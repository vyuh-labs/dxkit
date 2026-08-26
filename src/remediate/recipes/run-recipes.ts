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
import { makeCommandExec, tail, type CommandExec } from '../../analyzers/tools/bounded-exec';
import { gatherDepVulnsWithAvailability } from '../../analyzers/security/gather';
import { queryOsvPackage, type OsvPackageQuery, type OsvVuln } from '../../analyzers/tools/osv';
import type { AnalysisTrustContext } from '../../analysis-trust';
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import { newAdvisoryBlockSeverities } from '../../baseline/policy-sections';
import { readPolicySection } from '../../baseline/policy-text';
import type { FindingSeverity } from '../../baseline/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { RemediateConfig } from '../config';
import { planRepoWorkOrders, type GatherWorkOrderOptions } from '../work-orders/gather';
import { classesSelectedBy } from '../work-orders/types';
import { selectOrders } from '../work-orders/planner';
import { RECIPE_REGISTRY, type RecipeDeclaration } from '../work-orders/recipes-registry';
import type { WorkOrder } from '../work-orders/types';
import { partitionByEnvelope, pathInEnvelope } from './envelope';
import { realRecipeGit, type RecipeGit } from './git';
import type { RecipeOutcome } from './types';

export interface RecipeOrderRecord {
  readonly orderId: string;
  readonly class: string;
  readonly recipe: string;
  readonly outcome: RecipeOutcome;
  /** Out-of-envelope paths the enforcement discarded (disclosed). */
  readonly droppedPaths?: readonly string[];
}

export interface RecipePhaseSummary {
  /** Did the phase execute at all? False when disabled, when planning
   *  failed, or when the task selects no recipe-tier orders. */
  readonly ran: boolean;
  /** `remediate.recipes.enabled: false` (disclosed, never silent). */
  readonly disabled?: boolean;
  /** Planning broke (fail-open: the agent path proceeds; the ledger says
   *  why no recipe ran). */
  readonly planError?: string;
  /** Degraded gather reads, straight from the ONE gather adapter. */
  readonly disclosures: readonly string[];
  /** Orders the task selected, split by tier. Agent-tier orders are NOT
   *  dispatched by this phase (the scoped-agent unit owns that); the count
   *  is disclosed so a reader knows what remains. */
  readonly selectedRecipeTier: number;
  readonly selectedAgentTier: number;
  readonly records: readonly RecipeOrderRecord[];
  /** The orders LEFT for the agent tier after this phase, in plan (value)
   *  order: the selected agent-tier orders, plus every recipe-tier order
   *  whose recipe refused or failed (the in-run fallback — a refused
   *  recipe order joins the agent queue instead of dead-ending the run).
   *  Absent when no plan was built (planning failed, or an injected
   *  summary predates the field) — the runner then keeps the legacy
   *  task-prompt path. */
  readonly agentOrders?: readonly WorkOrder[];
}

export function emptyRecipePhase(extra?: Partial<RecipePhaseSummary>): RecipePhaseSummary {
  return {
    ran: false,
    disclosures: [],
    selectedRecipeTier: 0,
    selectedAgentTier: 0,
    records: [],
    ...extra,
  };
}

export interface RunRecipeOrdersDeps {
  readonly cwd: string;
  readonly trust: AnalysisTrustContext;
  readonly git: RecipeGit;
  readonly exec: CommandExec;
  readonly registry?: readonly RecipeDeclaration[];
  readonly queryOsv?: OsvPackageQuery;
  readonly auditDepVulns?: (cwd: string) => Promise<readonly DepVulnFinding[] | null>;
  /** The advisory block tier for the OSV pre-checks; defaults to the repo's
   *  policy through the one normalizer (`effectiveBlockSeverities`). */
  readonly blockSeverities?: ReadonlySet<FindingSeverity>;
}

/** The repo's effective advisory block tier, through the ONE policy
 *  normalizer the guardrail's new-advisory classifier reads (Rule 2.30). */
export function effectiveBlockSeverities(cwd: string): ReadonlySet<FindingSeverity> {
  return newAdvisoryBlockSeverities({
    newAdvisories: readPolicySection(cwd, 'newAdvisories') as never,
  });
}

/** Wrap an OSV query in a per-run cache: one plan can ask about the same
 *  candidate from several orders, and a network answer does not change
 *  mid-run. */
export function cachedOsvQuery(query: OsvPackageQuery): OsvPackageQuery {
  const cache = new Map<string, Promise<OsvVuln[] | null>>();
  return (pkg, version, ecosystem) => {
    const key = `${ecosystem}\0${pkg}\0${version}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = query(pkg, version, ecosystem);
    cache.set(key, pending);
    return pending;
  };
}

/** The default re-audit: the ONE dep-audit dispatch primitive; an
 *  unavailable audit reads as null (cannot verify), never as clean. */
async function defaultAudit(cwd: string): Promise<readonly DepVulnFinding[] | null> {
  const result = await gatherDepVulnsWithAvailability(cwd);
  if (!result.available) return null;
  return result.envelope?.findings ?? [];
}

/** Execute the recipe-tier orders, in plan (value) order. */
export async function runRecipeOrders(
  orders: readonly WorkOrder[],
  deps: RunRecipeOrdersDeps,
): Promise<RecipeOrderRecord[]> {
  const registry = deps.registry ?? RECIPE_REGISTRY;
  const queryOsv = cachedOsvQuery(deps.queryOsv ?? queryOsvPackage);
  const blockSeverities = deps.blockSeverities ?? effectiveBlockSeverities(deps.cwd);
  const records: RecipeOrderRecord[] = [];
  for (const order of orders) {
    if (order.tier !== 'recipe' || !order.recipe) continue;
    const base = { orderId: order.id, class: String(order.class), recipe: order.recipe };
    // Rule 17, decided at the ONE phase entry point: recipes run installs
    // and linters, so an untrusted tree refuses every order before any
    // registry entry executes, disclosed per order, never silent.
    if (!deps.trust.repoExecutionAllowed) {
      records.push({
        ...base,
        outcome: {
          kind: 'refused',
          reason:
            `repo execution is not allowed under this trust context (${deps.trust.source}); ` +
            'recipes run package-manager and linter commands, so nothing spawned',
        },
      });
      continue;
    }
    const decl = registry.find((r) => r.id === order.recipe);
    if (!decl?.execute) {
      records.push({
        ...base,
        outcome: {
          kind: 'refused',
          reason: `recipe '${order.recipe}' is declared but not executable in this build`,
        },
      });
      continue;
    }
    let pre: Set<string>;
    try {
      pre = new Set(deps.git.changedPaths());
    } catch (err) {
      records.push({
        ...base,
        outcome: {
          kind: 'failed',
          step: 'working-tree',
          output: tail(err instanceof Error ? err.message : String(err)),
        },
      });
      continue;
    }
    // A pre-existing uncommitted edit INSIDE the envelope makes the recipe's
    // own diff unattributable: an edit to an already-dirty file would be
    // neither committed (a partial manifest commit CI cannot install) nor
    // discarded (leaking the recipe's change into the user's dirt). Refuse
    // up front, dirty paths named, so both contracts hold exactly.
    const dirtyInEnvelope = [...pre].filter((path) => pathInEnvelope(path, order.envelope));
    if (dirtyInEnvelope.length > 0) {
      records.push({
        ...base,
        outcome: {
          kind: 'refused',
          reason:
            'the working tree already has uncommitted changes inside this order envelope ' +
            `(${dirtyInEnvelope.join(', ')}); commit or stash them so the recipe's own diff ` +
            'stays attributable',
        },
      });
      continue;
    }
    let outcome: RecipeOutcome;
    try {
      outcome = await decl.execute(order, {
        cwd: deps.cwd,
        trust: deps.trust,
        exec: deps.exec,
        queryOsv,
        blockSeverities,
        auditDepVulns: deps.auditDepVulns ?? defaultAudit,
      });
    } catch (err) {
      outcome = {
        kind: 'failed',
        step: 'recipe',
        output: tail(err instanceof Error ? err.message : String(err)),
      };
    }
    // Only the paths THIS recipe dirtied are in play: pre-existing local
    // edits are never staged, committed, or discarded by the phase.
    let delta: string[];
    try {
      delta = deps.git.changedPaths().filter((p) => !pre.has(p));
    } catch (err) {
      records.push({
        ...base,
        outcome: {
          kind: 'failed',
          step: 'working-tree',
          output:
            'could not read the working tree after the recipe ran, so its diff can be ' +
            `neither enforced nor committed: ${tail(err instanceof Error ? err.message : String(err))}`,
        },
      });
      continue;
    }
    if (outcome.kind !== 'applied') {
      deps.git.discardPaths(delta);
      records.push({ ...base, outcome });
      continue;
    }
    const { inside, outside } = partitionByEnvelope(delta, order.envelope);
    if (outside.length > 0) deps.git.discardPaths(outside);
    if (inside.length === 0) {
      records.push({
        ...base,
        outcome: {
          kind: 'failed',
          step: 'envelope',
          output:
            'the recipe reported applied but left no change inside the order envelope' +
            (outside.length > 0 ? ` (out-of-envelope paths were discarded)` : ''),
        },
        ...(outside.length > 0 ? { droppedPaths: outside } : {}),
      });
      continue;
    }
    deps.git.commitPaths(inside, `fix(${order.class}): ${order.id} (${decl.id} recipe)`);
    records.push({
      ...base,
      outcome: { ...outcome, changedFiles: inside },
      ...(outside.length > 0 ? { droppedPaths: outside } : {}),
    });
  }
  return records;
}

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
  const selected = selectOrders(plan.plan, classesSelectedBy(opts.taskId));
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
      agentOrders: selected,
    });
  }
  const summaryBase = {
    disclosures: plan.disclosures,
    selectedRecipeTier: recipeTier.length,
    selectedAgentTier: selected.length - recipeTier.length,
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

/** Convenience projections for the frame's decision + ledger. */
export function recipeCounts(summary: RecipePhaseSummary): {
  applied: number;
  refused: number;
  failed: number;
} {
  let applied = 0;
  let refused = 0;
  let failed = 0;
  for (const r of summary.records) {
    if (r.outcome.kind === 'applied') applied += 1;
    else if (r.outcome.kind === 'refused') refused += 1;
    else failed += 1;
  }
  return { applied, refused, failed };
}
