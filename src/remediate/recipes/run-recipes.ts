/**
 * The recipe phase runner (remediate rethink, section 3B): execute the
 * recipe-tier orders of a task's plan INSIDE the remediate frame, before any
 * agent spawns. The most reliable agent run is the one that never happens:
 * a plan whose selected orders are all recipe-tier completes at $0.
 *
 * Per order, in sequence on the task branch's working tree:
 *
 *   1. the registry entry's `execute` runs (bounded exec, trust-gated at
 *      THIS entry point: an untrusted tree refuses every order before
 *      anything spawns, disclosed);
 *   2. the diff the recipe left is measured against the tree state BEFORE it
 *      ran (a locally dirty tree's pre-existing edits are never touched);
 *   3. envelope enforcement: paths outside the order's envelope are
 *      DISCARDED and disclosed (`droppedPaths`): sprawl is unlandable by
 *      construction, the same doctrine the agent sweep applies;
 *   4. an applied outcome with an in-envelope diff commits as one
 *      `fix(<class>): <order id>` commit; a refusal or failure discards the
 *      recipe's whole diff.
 *
 * The frame then runs the ONE tree verification over the combined result:
 * a recipe never certifies itself past the guardrail.
 *
 * The registry is iterated, never hardcoded (`registry` is injectable and
 * the playbook test injects a synthetic recipe, the Rule 6 discipline).
 */
import { makeCommandExec, type CommandExec } from '../../analyzers/tools/bounded-exec';
import type { AnalysisTrustContext } from '../../analysis-trust';
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import type { FindingSeverity } from '../../baseline/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { RecipeDeclaration } from '../work-orders/recipes-registry';
import type { OsvPackageQuery } from '../../analyzers/tools/osv';
import type { RemediateConfig } from '../config';
import { planRepoWorkOrders, type GatherWorkOrderOptions } from '../work-orders/gather';
import { classesSelectedBy } from '../work-orders/types';
import { selectOrders } from '../work-orders/planner';
import { realRecipeGit, type RecipeGit } from './git';
// The order executor lives in `./execute-orders` (module-size split);
// re-exported so consumers keep one import surface.
export {
  cachedOsvQuery,
  effectiveBlockSeverities,
  groupRecipeOrders,
  runRecipeOrders,
  type RunRecipeOrdersDeps,
} from './execute-orders';
import { runRecipeOrders } from './execute-orders';
import { emptyRecipePhase, type PausedOrderRecord, type RecipePhaseSummary } from './phase-summary';

// The summary shapes live in `./phase-summary` (module-size split); re-exported
// so consumers keep one import surface.
export {
  emptyRecipePhase,
  recipeCounts,
  type PausedOrderRecord,
  type RecipeGroupVerification,
  type RecipeOrderRecord,
  type RecipePhaseSummary,
} from './phase-summary';
import type { TreeInvariantStep } from '../../lanes/tree-invariants';

export interface RecipePhaseOptions {
  readonly cwd: string;
  readonly trust: AnalysisTrustContext;
  readonly taskId: string;
  readonly config: RemediateConfig;
  /** The entry floor the frame already captured, reused as the plan's floor
   *  source so the phase never pays (or diverges from) a second floor run. */
  readonly entryFloor: CorrectnessFloorResult;
  /** Injection seams (tests). */
  readonly git?: RecipeGit;
  readonly exec?: CommandExec;
  readonly timeoutMs?: number;
  readonly registry?: readonly RecipeDeclaration[];
  readonly gather?: GatherWorkOrderOptions;
  readonly queryOsv?: OsvPackageQuery;
  readonly auditDepVulns?: (cwd: string) => Promise<readonly DepVulnFinding[] | null>;
  readonly blockSeverities?: ReadonlySet<FindingSeverity>;
  readonly invariantStep?: TreeInvariantStep;
}

/**
 * Plan the repo's work orders, select the task's classes, and execute the
 * recipe tier. Fail-open on planning (a broken plan is a disclosed
 * `planError`, and the agent path proceeds exactly as before this phase
 * existed); fail-closed inside each recipe (an unverified diff is
 * discarded).
 */
export async function runRecipePhaseForTask(opts: RecipePhaseOptions): Promise<RecipePhaseSummary> {
  // Nothing consumes a plan when BOTH consumers are off: recipes disabled
  // and order dispatch off (maxOrdersPerRun 0) — do not pay the planning
  // gathers for a result nobody reads.
  if (!opts.config.recipes.enabled && opts.config.maxOrdersPerRun <= 0) {
    return emptyRecipePhase({ disabled: true });
  }
  let plan;
  try {
    plan = await planRepoWorkOrders(opts.cwd, opts.config, {
      runFloor: () => opts.entryFloor,
      ...opts.gather,
    });
  } catch (err) {
    const planError = err instanceof Error ? err.message : String(err);
    return emptyRecipePhase({
      planError,
      ...(opts.config.recipes.enabled ? {} : { disabled: true }),
    });
  }
  const allSelected = selectOrders(plan.plan, classesSelectedBy(opts.taskId));
  // The circuit breaker's marks (applied by the ONE gather+plan entry
  // point): a paused order is dispatched by NO tier — not the recipe tier
  // here, not the agent queue below — and is disclosed, never dropped.
  const pausedOrders = allSelected.filter((o) => o.paused);
  const paused: PausedOrderRecord[] = pausedOrders.map((o) => ({
    orderId: o.id,
    class: String(o.class),
    tier: o.tier,
    findings: o.findings.length,
    reason: o.paused!.reason,
    unpause: o.paused!.unpause,
  }));
  const pausedDisclosure = paused.length > 0 ? { paused } : {};
  const selected = allSelected.filter((o) => !o.paused);
  const recipeTier = selected.filter((o) => o.tier === 'recipe');
  if (!opts.config.recipes.enabled) {
    // The knob's documented meaning: route EVERY selected order to the
    // agent tier. The plan is still built (order-driven dispatch needs it);
    // no recipe executes.
    return emptyRecipePhase({
      disabled: true,
      disclosures: plan.disclosures,
      selectedRecipeTier: 0,
      selectedAgentTier: selected.length,
      ...pausedDisclosure,
      agentOrders: selected,
    });
  }
  const summaryBase = {
    disclosures: plan.disclosures,
    selectedRecipeTier: recipeTier.length,
    selectedAgentTier: selected.length - recipeTier.length,
    ...pausedDisclosure,
  };
  if (recipeTier.length === 0) {
    return { ran: false, records: [], ...summaryBase, agentOrders: selected };
  }
  const records = await runRecipeOrders(recipeTier, {
    cwd: opts.cwd,
    trust: opts.trust,
    git: opts.git ?? realRecipeGit(opts.cwd),
    exec: opts.exec ?? makeCommandExec(opts.timeoutMs),
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.queryOsv ? { queryOsv: opts.queryOsv } : {}),
    ...(opts.auditDepVulns ? { auditDepVulns: opts.auditDepVulns } : {}),
    ...(opts.blockSeverities ? { blockSeverities: opts.blockSeverities } : {}),
    ...(opts.invariantStep ? { invariantStep: opts.invariantStep } : {}),
  });
  // The agent queue, in plan (value) order: agent-tier orders plus every
  // recipe order whose recipe did not APPLY — a refused/failed recipe order
  // falls through to the agent within THIS run instead of dead-ending it.
  const applied = new Set(
    records.filter((r) => r.outcome.kind === 'applied').map((r) => r.orderId),
  );
  const agentOrders = selected.filter((o) => o.tier === 'agent' || !applied.has(o.id));
  return { ran: true, records, ...summaryBase, agentOrders };
}
