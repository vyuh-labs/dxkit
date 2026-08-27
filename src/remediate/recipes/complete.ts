/**
 * Completion of a RECIPE-ONLY remediate run (split from `../run.ts` at the
 * module-size bar): when every order the task selected was recipe-tier, the
 * run finishes without any agent spawn, with the ONE tree verification still
 * arbitrates the combined recipe commits exactly as it would an agent's
 * (install, diff-scoped floor attributed vs entry, guardrail). A $0 run is
 * never a self-certified run.
 */
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import type { RemediateGit, RemediateResult, RemediateRunOptions } from '../outcome';
import type { RemediateTask } from '../tasks';
import {
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
  verifyOrderHead,
} from '../verify';
import { recipeCounts, runRecipePhaseForTask, type RecipePhaseSummary } from './run-recipes';

type Partial = Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>;

/**
 * The frame's recipe-tier step: run the phase (never throwing past this
 * function; a broken plan is a disclosed `planError` and the agent path
 * proceeds), and when EVERY selected order was recipe-tier, complete the
 * run here. `done` present = the runner finishes with it; absent = the
 * agent path continues with `recipes` disclosed.
 */
export async function recipeTierStep(
  opts: RemediateRunOptions,
  args: {
    readonly task: Pick<RemediateTask, 'id'>;
    readonly entryFloor: CorrectnessFloorResult;
    readonly baseHead: string;
    readonly git: RemediateGit;
    readonly runFloor: () => CorrectnessFloorResult;
  },
): Promise<{ recipes: RecipePhaseSummary; done?: Partial }> {
  let recipes: RecipePhaseSummary;
  try {
    recipes = await (opts.runRecipePhase ?? runRecipePhaseForTask)({
      cwd: opts.cwd,
      trust: opts.trust,
      taskId: args.task.id,
      config: opts.config,
      entryFloor: args.entryFloor,
      // An explicit human dispatch overrides the circuit breaker for this
      // task's classes (disclosed by the breaker, never silent).
      ...(opts.explicitDispatch ? { gather: { dispatchedTask: args.task.id } } : {}),
    });
  } catch (err) {
    recipes = {
      ran: false,
      planError: err instanceof Error ? err.message : String(err),
      disclosures: [],
      selectedRecipeTier: 0,
      selectedAgentTier: 0,
      records: [],
    };
  }
  const selected = recipes.selectedRecipeTier + recipes.selectedAgentTier;
  if (selected === 0) {
    // Every dispatchable order gone but PAUSED orders remain: the circuit
    // breaker declined the spend. Complete here at $0 with the pause and
    // its unpause conditions named — falling through would hand the task's
    // open-ended legacy prompt to an agent, re-buying the exact failure the
    // pause exists to stop.
    const pausedClasses = [...new Set((recipes.paused ?? []).map((p) => p.class))];
    if (pausedClasses.length > 0) {
      const first = recipes.paused![0];
      return {
        recipes,
        done: {
          outcome: 'no-op',
          task: args.task.id,
          recipes,
          floor: args.entryFloor,
          note:
            `every work order this task selects is PAUSED by the circuit breaker ` +
            `(class(es): ${pausedClasses.join(', ')}); no agent was spawned, nothing was ` +
            `spent ($0). Reason: ${first.reason}. Unpause: ${first.unpause}.`,
        },
      };
    }
    return { recipes };
  }
  // Order-driven dispatch (the scoped-agent unit): with a plan in hand and a
  // positive per-run order cap, everything the recipe tier left OPEN — the
  // agent-tier orders plus every refused/failed recipe order — goes to the
  // orders phase ONE ORDER PER AGENT RUN, so a refused recipe never
  // dead-ends the run. The run completes here only when nothing is left.
  const orderDispatch = opts.config.maxOrdersPerRun > 0 && recipes.agentOrders !== undefined;
  if (orderDispatch) {
    if ((recipes.agentOrders ?? []).length > 0) {
      const verified = await verifyRecipeGroup(opts, recipes, args);
      if (verified.groupVerification?.kind === 'unverifiable') {
        // The base the agent orders would build on cannot be verified:
        // spend nothing, keep the commits, disclose, and stop here.
        return {
          recipes: verified,
          done: {
            outcome: 'verification-unavailable',
            task: args.task.id,
            recipes: verified,
            floor: args.entryFloor,
            note:
              'the recipe group could not be verified (verification infrastructure failed: ' +
              `${verified.groupVerification.reason}); its commits stay on the branch, nothing ` +
              'lands, and no agent order was dispatched ($0). The branch is left for ' +
              'inspection or resume.',
            baseHead: args.baseHead,
            head: args.git.head(),
          },
        };
      }
      return { recipes: verified };
    }
  } else if (recipes.selectedAgentTier > 0) {
    // No order queue (dispatch off, or a summary without a plan): the
    // pre-order-dispatch shape — a mixed plan continues on the legacy
    // task-prompt agent path.
    return { recipes };
  }
  const done = await completeRecipeOnlyRun(opts, {
    taskId: args.task.id,
    recipes,
    baseHead: args.baseHead,
    head: args.git.head(),
    hasDiff: args.git.hasDiff(args.baseHead),
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  return { recipes, done };
}

/**
 * Per-order landing, the recipe half (4.4.6): when agent orders FOLLOW, the
 * recipe group's combined commits are verified as one contiguous unit
 * (install + floor; the guardrail arbitrates once over the landed head)
 * BEFORE any agent spawns. Kept: the agent tier builds on the verified
 * head. Dropped: the group's own committed paths are reverted (a targeted
 * revert, never a hard reset — a user's pre-existing uncommitted edits are
 * untouched), every applied record is marked dropped with the reason, and
 * the agent tier starts from the base. Unverifiable (infrastructure): the
 * commits stay, nothing lands, and the run completes
 * `verification-unavailable` before any agent spawns. A recipe-only run
 * (nothing follows) keeps its single completion-time verification.
 */
async function verifyRecipeGroup(
  opts: RemediateRunOptions,
  recipes: RecipePhaseSummary,
  args: {
    readonly baseHead: string;
    readonly git: RemediateGit;
    readonly entryFloor: CorrectnessFloorResult;
    readonly runFloor: () => CorrectnessFloorResult;
  },
): Promise<RecipePhaseSummary> {
  const applied = recipes.records.filter((r) => r.outcome.kind === 'applied');
  if (applied.length === 0 || !args.git.hasDiff(args.baseHead)) return recipes;
  const head = args.git.head();
  const verdict = await verifyOrderHead(opts, {
    head,
    baseHead: args.baseHead,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  switch (verdict.kind) {
    case 'kept':
      return {
        ...recipes,
        groupVerification: { kind: 'kept', head },
        records: recipes.records.map((r) =>
          r.outcome.kind === 'applied' ? { ...r, disposition: { kind: 'kept', head } } : r,
        ),
      };
    case 'unverifiable':
      // Infrastructure, not a verdict: the group's commits stay on the
      // branch (never destroyed by a transient failure); the caller
      // completes the run `verification-unavailable` before any agent
      // order spends anything.
      return {
        ...recipes,
        groupVerification: { kind: 'unverifiable', reason: verdict.reason },
      };
    case 'dropped': {
      // Targeted revert (review fix 2): restore exactly the paths the
      // group's own commits changed, leaving a user's pre-existing
      // uncommitted edits untouched. Never a hard reset over a dirty tree.
      const groupPaths = [
        ...new Set(
          applied.flatMap((r) => (r.outcome.kind === 'applied' ? r.outcome.changedFiles : [])),
        ),
      ];
      const droppedOrderIds = applied.map((r) => r.orderId);
      const disposition = { kind: 'dropped', step: verdict.step, reason: verdict.reason } as const;
      args.git.revertPaths(args.baseHead, groupPaths);
      return {
        ...recipes,
        groupVerification: {
          kind: 'dropped',
          step: verdict.step,
          reason: verdict.reason,
          droppedOrderIds,
        },
        // A dropped recipe order stays OPEN for the next firing (its row
        // records the drop, so the breaker sees it); this run's agent
        // queue is unchanged.
        records: recipes.records.map((r) =>
          r.outcome.kind === 'applied' ? { ...r, disposition } : r,
        ),
      };
    }
  }
}

export interface RecipeOnlyArgs {
  readonly taskId: RemediateTask['id'];
  readonly recipes: RecipePhaseSummary;
  readonly baseHead: string;
  readonly head: string;
  readonly hasDiff: boolean;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
}

export async function completeRecipeOnlyRun(
  opts: RemediateRunOptions,
  args: RecipeOnlyArgs,
): Promise<Partial> {
  const counts = recipeCounts(args.recipes);
  const zeroDollar = 'No agent was spawned: every selected work order was recipe-tier ($0 run).';
  if (!args.hasDiff) {
    // NOT a clean no-op: the orders exist, every recipe refused or failed,
    // and no agent dispatch remains in this run to pick them up (the
    // in-run fallback routes refused orders to the agent tier whenever
    // `remediate.maxOrdersPerRun` allows it — reaching this arm means it
    // did not). A green outcome here would let the scheduled lane loop
    // forever over debt nothing is working; `recipes-refused` is non-clean
    // by construction (the executor's clean set never contains it).
    const dispatchOff = opts.config.maxOrdersPerRun <= 0;
    return {
      outcome: 'recipes-refused',
      task: args.taskId,
      floor: args.entryFloor,
      recipes: args.recipes,
      note:
        `${zeroDollar} Every recipe declined: ${counts.refused} refused, ${counts.failed} ` +
        'failed, nothing was fixed, and the orders remain open. Per-order reasons are in ' +
        'the recipe section below; these orders need the agent tier or a human.' +
        (dispatchOff
          ? ' In-run agent dispatch is off (remediate.maxOrdersPerRun: 0); raise it to let ' +
            'the agent tier pick these orders up.'
          : ''),
    };
  }
  const { verified, guardrail } = await verifyCommittedHead(opts, {
    head: args.head,
    baseHead: args.baseHead,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  const common = {
    task: args.taskId,
    recipes: args.recipes,
    ...verificationDisclosures(verified, guardrail, opts.cwd),
    baseHead: args.baseHead,
    head: args.head,
  };
  if (verified.verdict === 'install-failed') {
    return { outcome: 'install-failed', ...common, note: installFailedNote(verified) };
  }
  if (verified.verdict === 'floor-red') {
    return {
      outcome: 'floor-red',
      ...common,
      note:
        'the correctness floor has NET-NEW failures after the recipe commits (the entry ' +
        'floor did not have them), so nothing lands. A recipe that breaks the build gets the ' +
        'same truthful failure an agent would.',
    };
  }
  if (!guardrail.ran || !guardrail.passesGate) {
    return {
      outcome: 'guardrail-red',
      ...common,
      note: guardrail.ran
        ? `the guardrail did not pass (${guardrail.verdict}), so nothing merges. The recipe ` +
          'commits stay on the branch for inspection.'
        : `the guardrail could not run (${guardrail.verdict}), so nothing lands. A recipe ` +
          'diff is never pushed unverified.',
    };
  }
  return {
    outcome: 'verified',
    ...common,
    note: `${zeroDollar} ${counts.applied} order(s) applied and verified the way CI verifies.`,
  };
}
