/**
 * Per-order placement (4.4.6, split from `orders-phase.ts` at the
 * module-size bar): steps 6 and 7 of an order dispatch. After the sweep,
 * the scrub and the envelope enforcement, the order's committed diff goes
 * through the frame's tree-invariant step and then its own verification on
 * top of the previously verified head, and comes out KEPT (lands), DROPPED
 * (reverted to the order base, the step and reason named) or UNVERIFIABLE
 * (verification infrastructure failed: the commits STAY on the branch,
 * nothing lands, the run completes `verification-unavailable`). ONE
 * function for the placement so the ledger row, the PR body and the
 * circuit breaker read one decision.
 *
 * `applyFrameInvariants` is the shared post-agent invariant application:
 * the SAME code path serves the order dispatches here and the legacy
 * task-prompt run (`run.ts`), so an agent-produced tree is never trusted
 * as coherent on one path and re-established on another.
 *
 * Drop hygiene (review fixes 1 and 7): a DROP restores exactly what the
 * order and the frame's step touched — `resetTo` for the committed and
 * tracked state, then a PATH-SCOPED clean of only the untracked files the
 * step itself created (never a blanket `git clean`). A reset that itself
 * throws is a FATAL disclosed failure: the phase stops dispatching and the
 * already-kept orders still get their summary and ledger. And an
 * infrastructure failure of the verification NEVER resets: real committed
 * work is never destroyed by a transient worktree or disk failure.
 */
import type { TreeInvariantOutcome, TreeInvariantStep } from '../lanes/tree-invariants';
import { describeTreeInvariantOutcome } from '../lanes/tree-invariants';
import type { OrderRunRecord, RemediateGit, RemediateRunOptions } from './outcome';
import type { OrdersPhaseArgs } from './orders-phase';
import { verifyOrderHead } from './verify';
import type { WorkOrder } from './work-orders/types';

/** What the shared frame-invariant application did to the tree. */
export interface FrameStepApplication {
  readonly outcomes: readonly TreeInvariantOutcome[];
  readonly disclosures: readonly string[];
  /** Working-tree paths the step rewrote (committed below when clean). */
  readonly changedPaths: readonly string[];
  /** Present when the step failed (an invariant could not be
   *  re-established, the step threw, or its commit failed): the caller
   *  fails the order or the run at this step, named. */
  readonly failure?: string;
}

/**
 * The ONE post-agent invariant application (review fix 8): run the frame's
 * step over the diff `base..HEAD`, commit what it re-established as the
 * frame's own, and report the outcomes. Consumed by `placeOrder` below AND
 * by the legacy task-prompt path in `run.ts` — wherever the agent produced
 * a tree, the same invariants are re-established by the same code.
 */
export async function applyFrameInvariants(args: {
  readonly git: Pick<RemediateGit, 'changedPaths' | 'commitPaths'>;
  readonly base: string;
  readonly invariantStep: TreeInvariantStep;
  /** The commit-message tail ("after order X" / "after the task run"). */
  readonly label: string;
}): Promise<FrameStepApplication> {
  let step: Awaited<ReturnType<TreeInvariantStep>>;
  try {
    step = await args.invariantStep({
      changedPaths: args.git.changedPaths(args.base),
      baseHead: args.base,
    });
  } catch (err) {
    return {
      outcomes: [],
      disclosures: [],
      changedPaths: [],
      failure: `the frame's invariant step could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (step.failed) {
    return {
      outcomes: step.applied,
      disclosures: step.disclosures,
      changedPaths: step.changedPaths,
      failure: step.applied
        .filter(
          (o) =>
            o.status !== 'already-consistent' &&
            o.status !== 'reestablished' &&
            o.status !== 'pre-existing',
        )
        .map(describeTreeInvariantOutcome)
        .join('; '),
    };
  }
  if (step.changedPaths.length > 0) {
    try {
      args.git.commitPaths(
        step.changedPaths,
        `chore(frame): re-establish ${step.applied
          .filter((o) => o.status === 'reestablished')
          .map((o) => o.id)
          .join(', ')} ${args.label}`,
      );
    } catch (err) {
      return {
        outcomes: step.applied,
        disclosures: step.disclosures,
        changedPaths: step.changedPaths,
        failure: `the frame could not commit what it re-established: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    outcomes: step.applied,
    disclosures: step.disclosures,
    changedPaths: step.changedPaths,
  };
}

/** A placement: the record, plus a FATAL disclosure when the drop's own
 *  cleanup failed (the phase stops dispatching; kept orders keep their
 *  records). */
export interface OrderPlacement {
  readonly record: OrderRunRecord;
  readonly fatal?: string;
}

/**
 * Steps 6 and 7 of one order's dispatch: the frame invariants, then the
 * order's own verification on top of the previously verified head.
 */
export async function placeOrder(
  opts: RemediateRunOptions,
  args: OrdersPhaseArgs,
  p: {
    readonly order: WorkOrder;
    readonly orderBase: string;
    readonly record: OrderRunRecord;
    readonly invariantStep: TreeInvariantStep;
  },
): Promise<OrderPlacement> {
  // Step 6: the frame re-establishes what it owns, or the order fails here.
  opts.onPhase?.('frame-invariants');
  const frame = await applyFrameInvariants({
    git: args.git,
    base: p.orderBase,
    invariantStep: p.invariantStep,
    label: `after order ${p.order.id}`,
  });
  const disclosure: Pick<OrderRunRecord, 'invariants' | 'invariantDisclosures'> = {
    ...(frame.outcomes.length > 0 ? { invariants: frame.outcomes } : {}),
    ...(frame.disclosures.length > 0 ? { invariantDisclosures: frame.disclosures } : {}),
  };

  // A drop restores exactly what the order and the step touched: the reset
  // covers commits + tracked content, the path-scoped clean removes only
  // the untracked files the step created. A cleanup that itself throws is
  // FATAL (disclosed; the phase stops), never an uncaught crash.
  const dropped = (
    step: 'tree-invariants' | 'install' | 'floor',
    reason: string,
  ): OrderPlacement => {
    const record: OrderRunRecord = {
      ...p.record,
      ...disclosure,
      disposition: { kind: 'dropped', step, reason },
    };
    try {
      args.git.resetTo(p.orderBase);
      args.git.cleanPaths(frame.changedPaths);
    } catch (err) {
      return {
        record,
        fatal:
          `dropping order ${p.order.id} failed while restoring the tree to ${p.orderBase}: ` +
          `${err instanceof Error ? err.message : String(err)}. The tree state is unknown, so ` +
          'no further order is dispatched and nothing lands.',
      };
    }
    return { record };
  };

  if (frame.failure !== undefined) return dropped('tree-invariants', frame.failure);

  // Step 7: this order's commits, verified on top of the verified head.
  const head = args.git.head();
  const verdict = await verifyOrderHead(opts, {
    head,
    baseHead: p.orderBase,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  switch (verdict.kind) {
    case 'kept':
      return { record: { ...p.record, ...disclosure, disposition: { kind: 'kept', head } } };
    case 'dropped':
      return dropped(verdict.step, verdict.reason);
    case 'unverifiable':
      // Infrastructure, not a verdict: the commits STAY (not landed, not
      // reset); the phase stops dispatching and the run completes
      // `verification-unavailable` with the branch left for inspection.
      return {
        record: {
          ...p.record,
          ...disclosure,
          disposition: { kind: 'unverifiable', reason: verdict.reason },
        },
      };
  }
}
