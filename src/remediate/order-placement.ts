/**
 * Per-order placement (4.4.6, split from `orders-phase.ts` at the
 * module-size bar): steps 6 and 7 of an order dispatch. After the sweep,
 * the scrub and the envelope enforcement, the order's committed diff goes
 * through the frame's tree-invariant step and then its own verification on
 * top of the previously verified head, and comes out KEPT (lands) or
 * DROPPED (reverted to the order base, the step and reason named). ONE
 * function for the placement so the ledger row, the PR body and the
 * circuit breaker read one decision.
 */
import { describeTreeInvariantOutcome, type TreeInvariantStep } from '../lanes/tree-invariants';
import type { OrderRunRecord, RemediateRunOptions } from './outcome';
import type { OrdersPhaseArgs } from './orders-phase';
import { verifyOrderHead } from './verify';
import type { WorkOrder } from './work-orders/types';

/**
 * Per-order landing (4.4.6), steps 6 and 7 of the dispatch: the frame's
 * invariant step over the order's committed diff, then the order's own
 * verification on top of the previously verified head. Returns the record
 * with its DISPOSITION: kept (lands) or dropped (reverted to `orderBase`,
 * the step and reason named). ONE function for the placement so the ledger
 * row, the PR body and the breaker read one decision.
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
): Promise<OrderRunRecord> {
  const dropped = (
    step: 'tree-invariants' | 'install' | 'floor' | 'verification',
    reason: string,
    extra: Pick<OrderRunRecord, 'invariants'> = {},
  ): OrderRunRecord => {
    args.git.resetTo(p.orderBase);
    return { ...p.record, ...extra, disposition: { kind: 'dropped', step, reason } };
  };

  // Step 6: the frame re-establishes what it owns, or the order fails here.
  opts.onPhase?.('frame-invariants');
  let invariants: ReturnType<TreeInvariantStep>;
  try {
    invariants = p.invariantStep({ changedPaths: args.git.changedPaths(p.orderBase) });
  } catch (err) {
    return dropped(
      'tree-invariants',
      `the frame's invariant step could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const disclosure = invariants.applied.length > 0 ? { invariants: invariants.applied } : {};
  if (invariants.failed) {
    return dropped(
      'tree-invariants',
      invariants.applied
        .filter((o) => o.status !== 'already-consistent' && o.status !== 'reestablished')
        .map(describeTreeInvariantOutcome)
        .join('; '),
      disclosure,
    );
  }
  if (invariants.changedPaths.length > 0) {
    try {
      args.git.commitPaths(
        invariants.changedPaths,
        `chore(frame): re-establish ${invariants.applied
          .filter((o) => o.status === 'reestablished')
          .map((o) => o.id)
          .join(', ')} after order ${p.order.id}`,
      );
    } catch (err) {
      return dropped(
        'tree-invariants',
        `the frame could not commit what it re-established: ${err instanceof Error ? err.message : String(err)}`,
        disclosure,
      );
    }
  }

  // Step 7: this order's commits, verified on top of the verified head.
  const head = args.git.head();
  const verdict = await verifyOrderHead(opts, {
    head,
    baseHead: p.orderBase,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  if (!verdict.kept) return dropped(verdict.step, verdict.reason, disclosure);
  return { ...p.record, ...disclosure, disposition: { kind: 'kept', head } };
}
