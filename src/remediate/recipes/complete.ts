/**
 * Completion of a RECIPE-ONLY remediate run (split from `../run.ts` at the
 * module-size bar): when every order the task selected was recipe-tier, the
 * run finishes without any agent spawn, with the ONE tree verification still
 * arbitrates the combined recipe commits exactly as it would an agent's
 * (install, diff-scoped floor attributed vs entry, guardrail). A $0 run is
 * never a self-certified run.
 */
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import { containIfGuardrailRed } from '../containment';
import { describeDropped } from '../orders-complete';
import { notDispatched } from '../orders-phase';
import type {
  OrdersPhaseSummary,
  RemediateGit,
  RemediateResult,
  RemediateRunOptions,
} from '../outcome';
import type { RemediateTask } from '../tasks';
import {
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
  verifyOrderHead,
} from '../verify';
import { classesSelectedBy } from '../work-orders/types';
import { recipeCounts, runRecipePhaseForTask, type RecipePhaseSummary } from './run-recipes';

type Partial = Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>;

/** The one phrasing of the policy that turns the agent tier off (#393):
 *  every ledger line that names it reads the same. */
export const AGENT_TIER_DISABLED_BY_POLICY =
  'agent tier disabled by policy (remediate.maxOrdersPerRun: 0)';

/**
 * Does a work-order plan APPLY to this run? The ONE predicate behind the
 * runner's path decision (#393): a plan applies when the task selects
 * work-order classes AND the recipe phase built a plan (`agentOrders`
 * present, even when empty). Only when NO plan applies does the runner
 * take the legacy single-prompt path: an open-ended task (no classes to
 * plan for), or a failed plan (fail-open, the `planError` disclosed).
 * `remediate.maxOrdersPerRun` plays no part here: the cap decides how many
 * orders the agent tier gets, never whether a plan exists.
 */
export function workOrderPlanApplies(
  taskId: string,
  recipes: RecipePhaseSummary,
): { readonly applies: true } | { readonly applies: false; readonly reason: string } {
  if (classesSelectedBy(taskId).length === 0) {
    return { applies: false, reason: 'the task selects no work-order classes' };
  }
  if (recipes.agentOrders === undefined) {
    return {
      applies: false,
      reason: recipes.planError
        ? `work-order planning failed (${recipes.planError}); the agent path proceeded as before`
        : 'no work-order plan was built',
    };
  }
  return { applies: true };
}

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
  const planApplies = workOrderPlanApplies(args.task.id, recipes).applies;
  const agentQueue = recipes.agentOrders ?? [];
  if (planApplies && opts.config.maxOrdersPerRun <= 0) {
    // `remediate.maxOrdersPerRun: 0` means RECIPES ONLY (#393): the agent
    // tier is disabled by policy, so the run completes from the recipe
    // tier right here, never on the legacy single-prompt path (which was
    // the least scoped agent the lane has). Every order the queue held is
    // disclosed `not-dispatched` with the policy named, so a reader sees
    // exactly what stays open and why.
    const orders: OrdersPhaseSummary | undefined =
      agentQueue.length > 0
        ? {
            cap: 0,
            queued: agentQueue.length,
            records: agentQueue.map((o) => notDispatched(o, AGENT_TIER_DISABLED_BY_POLICY)),
          }
        : undefined;
    const done = await completeRecipeOnlyRun(opts, {
      taskId: args.task.id,
      recipes,
      baseHead: args.baseHead,
      head: args.git.head(),
      hasDiff: args.git.hasDiff(args.baseHead),
      entryFloor: args.entryFloor,
      runFloor: args.runFloor,
      git: args.git,
      ...(orders ? { orders } : {}),
    });
    return { recipes, done };
  }
  if (planApplies) {
    if (agentQueue.length > 0) {
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
    // No plan applies yet agent-tier orders were counted (a summary without
    // an order queue): the pre-order-dispatch shape, kept for older
    // summaries; the runner's own predicate then takes the legacy path.
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
    git: args.git,
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
      return recipeTierKeptAt(recipes, head);
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

/** The recipe tier verified as one unit (install + floor) at `head`: the
 *  group verification record plus every applied record kept there. ONE
 *  shape, written by the pre-agent group verification and by the
 *  recipe-only completion when its guardrail goes red (so containment can
 *  place the tier's commits either way). */
function recipeTierKeptAt(recipes: RecipePhaseSummary, head: string): RecipePhaseSummary {
  return {
    ...recipes,
    groupVerification: { kind: 'kept', head },
    records: recipes.records.map((r) =>
      r.outcome.kind === 'applied' ? { ...r, disposition: { kind: 'kept', head } } : r,
    ),
  };
}

export interface RecipeOnlyArgs {
  readonly taskId: RemediateTask['id'];
  readonly recipes: RecipePhaseSummary;
  readonly baseHead: string;
  readonly head: string;
  readonly hasDiff: boolean;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
  /** The branch surface containment reverts through (4.4.8). */
  readonly git: RemediateGit;
  /** The agent-tier queue this run did NOT dispatch because the agent tier
   *  is disabled by policy (`remediate.maxOrdersPerRun: 0`, #393): every
   *  order recorded `not-dispatched` with the policy named, disclosed on
   *  every arm below. Absent on a plan that left nothing for the agent. */
  readonly orders?: OrdersPhaseSummary;
  /** Injected for tests; production derives from the active packs. */
  readonly isManifestPath?: (path: string) => boolean;
}

export async function completeRecipeOnlyRun(
  opts: RemediateRunOptions,
  args: RecipeOnlyArgs,
): Promise<Partial> {
  const counts = recipeCounts(args.recipes);
  const undispatched = args.orders ? { orders: args.orders } : {};
  const zeroDollar = args.orders
    ? `No agent was spawned: ${AGENT_TIER_DISABLED_BY_POLICY}; ${args.orders.queued} ` +
      'agent-tier order(s) were not dispatched and remain open ($0 run).'
    : 'No agent was spawned: every selected work order was recipe-tier ($0 run).';
  if (!args.hasDiff) {
    // NOT a clean no-op: the orders exist, every recipe refused or failed
    // (or none was selected), and no agent dispatch remains in this run to
    // pick them up (the in-run fallback routes refused orders to the agent
    // tier whenever `remediate.maxOrdersPerRun` allows it; reaching this
    // arm means it did not). A green outcome here would let the scheduled
    // lane loop forever over debt nothing is working; `recipes-refused` is
    // non-clean by construction (the executor's clean set never contains
    // it).
    const remedy =
      opts.config.maxOrdersPerRun <= 0
        ? ' Raise remediate.maxOrdersPerRun to let the agent tier pick these orders up.'
        : '';
    return {
      outcome: 'recipes-refused',
      task: args.taskId,
      floor: args.entryFloor,
      recipes: args.recipes,
      ...undispatched,
      note:
        (args.recipes.records.length === 0
          ? `${zeroDollar} No recipe-tier order was selected, so nothing was fixed and the ` +
            'orders remain open; they need the agent tier or a human.'
          : `${zeroDollar} Every recipe declined: ${counts.refused} refused, ${counts.failed} ` +
            'failed, nothing was fixed, and the orders remain open. Per-order reasons are in ' +
            'the recipe section below; these orders need the agent tier or a human.') + remedy,
    };
  }
  const { verified, guardrail } = await verifyCommittedHead(opts, {
    head: args.head,
    baseHead: args.baseHead,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  if (verified.verdict === 'install-failed') {
    return {
      outcome: 'install-failed',
      ...disclose(args, verified, guardrail, opts),
      note: installFailedNote(verified),
    };
  }
  if (verified.verdict === 'floor-red') {
    return {
      outcome: 'floor-red',
      ...disclose(args, verified, guardrail, opts),
      note:
        'the correctness floor has NET-NEW failures after the recipe commits (the entry ' +
        'floor did not have them), so nothing lands. A recipe that breaks the build gets the ' +
        'same truthful failure an agent would.',
    };
  }
  // Guardrail-red containment for a recipe-only run (4.4.8, #376): the
  // tree this verification arbitrated IS the recipe tier, verified as one
  // unit (install + floor) at `head`, exactly what the pre-agent group
  // verification records when agent orders follow. Stamp that, then route
  // through the ONE containment call site the order-driven completion
  // uses, so a red in one file of an autofix run drops that file's commit
  // and lands the rest instead of discarding the whole verified tier
  // because no agent order happened to follow.
  const red = guardrail.ran && !guardrail.passesGate;
  const attempt = await containIfGuardrailRed(opts, {
    git: args.git,
    baseHead: args.baseHead,
    agentBase: args.head,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
    recipes: red ? recipeTierKeptAt(args.recipes, args.head) : args.recipes,
    records: [],
    ordersById: new Map(),
    guardrail,
    verified,
    head: args.head,
    ...(args.isManifestPath ? { isManifestPath: args.isManifestPath } : {}),
  });
  const common = {
    // A refused attempt restores the branch and carries the phase's own
    // records (a kept-stamped tier under a guardrail-red run would read as
    // landing); only a contained run carries the flipped records.
    ...disclose(
      { ...args, recipes: attempt.contained ? attempt.recipes : args.recipes, head: attempt.head },
      attempt.verified,
      attempt.guardrail,
      opts,
    ),
    ...(attempt.containment ? { containment: attempt.containment } : {}),
  };
  if (attempt.contained) {
    const dropped = attempt.recipes.records.filter((r) => r.disposition?.kind === 'dropped');
    return {
      outcome: 'partially-landed',
      ...common,
      note:
        `${zeroDollar} The final guardrail was red; its blocking findings were attributed per ` +
        'order, the attributed orders were dropped (commits reverted), and the remainder ' +
        're-verified green, so the verified remainder lands. Dropped at their own ' +
        `verification (still open): ${describeDropped(dropped)}.`,
    };
  }
  if (!guardrail.ran || !guardrail.passesGate) {
    const refusalNote =
      attempt.containment?.refused !== undefined
        ? ` Containment was attempted and refused: ${attempt.containment.refused}.`
        : '';
    return {
      outcome: 'guardrail-red',
      ...common,
      note:
        (guardrail.ran
          ? `the guardrail did not pass (${guardrail.verdict}), so nothing merges. The recipe ` +
            'commits stay on the branch for inspection.'
          : `the guardrail could not run (${guardrail.verdict}), so nothing lands. A recipe ` +
            'diff is never pushed unverified.') + refusalNote,
    };
  }
  return {
    outcome: 'verified',
    ...common,
    note: `${zeroDollar} ${counts.applied} order(s) applied and verified the way CI verifies.`,
  };
}

/** The result fields every recipe-only arm carries. */
function disclose(
  args: Pick<RecipeOnlyArgs, 'taskId' | 'recipes' | 'baseHead' | 'head' | 'orders'>,
  verified: Awaited<ReturnType<typeof verifyCommittedHead>>['verified'],
  guardrail: Awaited<ReturnType<typeof verifyCommittedHead>>['guardrail'],
  opts: RemediateRunOptions,
) {
  return {
    task: args.taskId,
    recipes: args.recipes,
    ...(args.orders ? { orders: args.orders } : {}),
    ...verificationDisclosures(verified, guardrail, opts.cwd),
    baseHead: args.baseHead,
    head: args.head,
  };
}
