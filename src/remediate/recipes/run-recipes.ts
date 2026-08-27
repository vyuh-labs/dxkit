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
import { resolveTolerances, type ResolvedTolerances } from '../../install/tolerances';
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

/** One order the circuit breaker paused — planned, selected by this task,
 *  and deliberately NOT dispatched by any tier (disclosed, never silent). */
export interface PausedOrderRecord {
  readonly orderId: string;
  readonly class: string;
  readonly tier: 'recipe' | 'agent';
  readonly findings: number;
  readonly reason: string;
  readonly unpause: string;
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
  /** Orders the task selected whose class the circuit breaker PAUSED: in
   *  neither tier count above, dispatched by nothing, disclosed here and in
   *  the ledger (remediate rethink 3F — never a silent skip). */
  readonly paused?: readonly PausedOrderRecord[];
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
  /** Injected for tests; defaults to the repo-root resolution. */
  readonly tolerances?: ResolvedTolerances;
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

/** Orders sharing a recipe + a non-null `groupKey` collapse into ONE
 *  execution attempt (positioned at the first member): a file's lint
 *  slices pay one `--fix` run, not one per slice. Everything else stays a
 *  singleton group, byte-identical to the ungrouped behavior. */
export function groupRecipeOrders(
  orders: readonly WorkOrder[],
  registry: readonly RecipeDeclaration[],
): WorkOrder[][] {
  const groups: WorkOrder[][] = [];
  const byKey = new Map<string, number>();
  for (const order of orders) {
    if (order.tier !== 'recipe' || !order.recipe) continue;
    const key = registry.find((r) => r.id === order.recipe)?.groupKey?.(order) ?? null;
    if (key !== null) {
      const groupKey = `${order.recipe}\0${key}`;
      const at = byKey.get(groupKey);
      if (at !== undefined) {
        groups[at].push(order);
        continue;
      }
      byKey.set(groupKey, groups.length);
    }
    groups.push([order]);
  }
  return groups;
}

/** The commit-message order list, capped so a 40-slice file does not write
 *  a paragraph-long subject. */
function nameOrders(ids: readonly string[]): string {
  return ids.length <= 6 ? ids.join(', ') : `${ids.slice(0, 6).join(', ')} +${ids.length - 6} more`;
}

/** The rules a lint order's findings carry. */
function orderRules(order: WorkOrder): Set<string> {
  return new Set(
    order.findings.flatMap((f) =>
      f.evidence.type === 'custom-check' && f.evidence.rule !== undefined ? [f.evidence.rule] : [],
    ),
  );
}

/** Execute the recipe-tier orders, in plan (value) order. */
export async function runRecipeOrders(
  orders: readonly WorkOrder[],
  deps: RunRecipeOrdersDeps,
): Promise<RecipeOrderRecord[]> {
  const registry = deps.registry ?? RECIPE_REGISTRY;
  const queryOsv = cachedOsvQuery(deps.queryOsv ?? queryOsvPackage);
  const blockSeverities = deps.blockSeverities ?? effectiveBlockSeverities(deps.cwd);
  // The repo-root tolerance set, resolved ONCE for the whole phase.
  const tolerances = deps.tolerances ?? resolveTolerances(deps.cwd);
  const records: RecipeOrderRecord[] = [];
  const recordAll = (
    group: readonly WorkOrder[],
    outcome: RecipeOutcome,
    extra?: Pick<RecipeOrderRecord, 'droppedPaths'>,
  ) => {
    for (const order of group) {
      records.push({
        orderId: order.id,
        class: String(order.class),
        recipe: order.recipe!,
        outcome,
        ...(extra ?? {}),
      });
    }
  };
  for (const group of groupRecipeOrders(orders, registry)) {
    const first = group[0];
    // Rule 17, decided at the ONE phase entry point: recipes run installs
    // and linters, so an untrusted tree refuses every order before any
    // registry entry executes, disclosed per order, never silent.
    if (!deps.trust.repoExecutionAllowed) {
      recordAll(group, {
        kind: 'refused',
        reason:
          `repo execution is not allowed under this trust context (${deps.trust.source}); ` +
          'recipes run package-manager and linter commands, so nothing spawned',
      });
      continue;
    }
    const decl = registry.find((r) => r.id === first.recipe);
    if (!decl?.execute) {
      recordAll(group, {
        kind: 'refused',
        reason: `recipe '${first.recipe}' is declared but not executable in this build`,
      });
      continue;
    }
    let pre: Set<string>;
    try {
      pre = new Set(deps.git.changedPaths());
    } catch (err) {
      recordAll(group, {
        kind: 'failed',
        step: 'working-tree',
        output: tail(err instanceof Error ? err.message : String(err)),
      });
      continue;
    }
    // A pre-existing uncommitted edit INSIDE the envelope makes the recipe's
    // own diff unattributable: an edit to an already-dirty file would be
    // neither committed (a partial manifest commit CI cannot install) nor
    // discarded (leaking the recipe's change into the user's dirt). Refuse
    // up front, dirty paths named, so both contracts hold exactly. Group
    // members share one envelope (the group key IS the file), so the first
    // member's answers for all.
    const dirtyInEnvelope = [...pre].filter((path) => pathInEnvelope(path, first.envelope));
    if (dirtyInEnvelope.length > 0) {
      recordAll(group, {
        kind: 'refused',
        reason:
          'the working tree already has uncommitted changes inside this order envelope ' +
          `(${dirtyInEnvelope.join(', ')}); commit or stash them so the recipe's own diff ` +
          'stays attributable',
      });
      continue;
    }
    // One attempt for the whole group: the merged findings tell the
    // executor everything the group's orders know (its verify treats their
    // union as the known set).
    const merged: WorkOrder =
      group.length === 1 ? first : { ...first, findings: group.flatMap((o) => o.findings) };
    let outcome: RecipeOutcome;
    try {
      outcome = await decl.execute(merged, {
        cwd: deps.cwd,
        trust: deps.trust,
        exec: deps.exec,
        tolerances,
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
      recordAll(group, {
        kind: 'failed',
        step: 'working-tree',
        output:
          'could not read the working tree after the recipe ran, so its diff can be ' +
          `neither enforced nor committed: ${tail(err instanceof Error ? err.message : String(err))}`,
      });
      continue;
    }
    // Per-order done inside a partly-fixed group: when the verify handed
    // back STRUCTURED leftovers (every remaining rule known to the merged
    // order), each member whose own rules are all gone is done; the rest
    // stay open and fall to the agent queue. The partial fix is real work
    // and commits; the leftover findings are the grandfathered debt of the
    // still-open orders, and the tree verification stays the arbiter.
    const leftoverRules =
      outcome.kind === 'failed' && outcome.step === 'verify-lint'
        ? outcome.leftoverRules
        : undefined;
    const closed =
      leftoverRules !== undefined
        ? group.filter((o) => [...orderRules(o)].every((r) => !leftoverRules.includes(r)))
        : [];
    if (outcome.kind !== 'applied' && closed.length === 0) {
      deps.git.discardPaths(delta);
      recordAll(group, outcome);
      continue;
    }
    const applying = outcome.kind === 'applied' ? [...group] : closed;
    const open = group.filter((o) => !applying.includes(o));
    const { inside, outside } = partitionByEnvelope(delta, first.envelope);
    if (outside.length > 0) deps.git.discardPaths(outside);
    const dropped = outside.length > 0 ? { droppedPaths: outside } : {};
    if (inside.length === 0) {
      recordAll(
        applying,
        {
          kind: 'failed',
          step: 'envelope',
          output:
            'the recipe reported this order done but left no change inside the order envelope' +
            (outside.length > 0 ? ` (out-of-envelope paths were discarded)` : ''),
        },
        dropped,
      );
    } else {
      deps.git.commitPaths(
        inside,
        `fix(${first.class}): ${nameOrders(applying.map((o) => o.id))} (${decl.id} recipe)`,
      );
      recordAll(applying, { kind: 'applied', changedFiles: inside }, dropped);
    }
    if (open.length > 0 && outcome.kind === 'failed') {
      for (const o of open) {
        const remain = [...orderRules(o)].filter((r) => leftoverRules!.includes(r)).sort();
        records.push({
          orderId: o.id,
          class: String(o.class),
          recipe: o.recipe!,
          outcome: {
            kind: 'failed',
            step: 'verify-lint',
            output:
              `rules remain after the file-level autofix (${remain.join(', ')}); ` +
              'not auto-fixable; this order falls to the agent tier',
          },
        });
      }
    }
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
