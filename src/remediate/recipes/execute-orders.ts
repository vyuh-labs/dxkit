/**
 * The recipe-order EXECUTOR (split from `run-recipes.ts` at the
 * module-size bar): runs the recipe-tier orders of a plan in value order,
 * one execution per group, with the trust gate, the envelope partition,
 * the frame's tree-invariant step and the per-member records on EVERY
 * exit path. The phase orchestration (planning, selection, the breaker's
 * pauses, the agent queue) stays in `run-recipes.ts`, which re-exports
 * this module so consumers keep one import surface.
 */
import { tail, type CommandExec } from '../../analyzers/tools/bounded-exec';
import { resolveTolerances, type ResolvedTolerances } from '../../install/tolerances';
import { gatherDepVulnsWithAvailability } from '../../analyzers/security/gather';
import { queryOsvPackage, type OsvPackageQuery, type OsvVuln } from '../../analyzers/tools/osv';
import type { AnalysisTrustContext } from '../../analysis-trust';
import {
  DEFAULT_BROWNFIELD_POLICY,
  loadPolicyFromCwd,
  type BrownfieldPolicy,
} from '../../baseline/policy';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import { RECIPE_REGISTRY, type RecipeDeclaration } from '../work-orders/recipes-registry';
import { packagesNamedBy } from '../work-orders/shared';
import type { WorkOrder } from '../work-orders/types';
import { partitionByEnvelope, pathInEnvelope } from './envelope';
import type { RecipeGit } from './git';
import type { TreeInvariantStep } from '../../lanes/tree-invariants';
import { describeTreeInvariantOutcome } from '../../lanes/tree-invariants';
import { frameInvariantStep } from '../frame-invariants';
import type { RecipeOrderRecord } from './phase-summary';
import type { RecipeOutcome } from './types';

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
  /** The guardrail policy the OSV pre-checks put candidates to; defaults
   *  to the repo's resolved policy (`effectiveGuardrailPolicy`). */
  readonly policy?: BrownfieldPolicy;
  /** The frame's tree-invariant step (4.4.6); defaults to the real step
   *  bound to this phase's exec + git. */
  readonly invariantStep?: TreeInvariantStep;
}

/**
 * The guardrail policy the frame arbitrates this run with: the repo's
 * resolved `.dxkit/policy.json` through the ONE resolver the guardrail check
 * itself reads (`resolvePolicy`, so `extends` / presets apply identically).
 * The recipes' OSV pre-checks put every candidate to the guardrail's own
 * block predicate over THIS policy (Rule 2.30, #371); the previous
 * projection read `newAdvisories.blockSeverities`, the post-capture tier,
 * which a repo can set to `[]` and thereby disarm the pre-check while the
 * guardrail still blocks every `added` dep-vuln.
 *
 * An unloadable policy (unknown `extends`, malformed JSON) fails the
 * guardrail itself, so the run is red regardless; the recipes fall back to
 * the compiled DEFAULT, the strictest posture (every `added` blocks), which
 * can only over-refuse, never apply what the guardrail would reject.
 */
export function effectiveGuardrailPolicy(cwd: string): BrownfieldPolicy {
  try {
    return loadPolicyFromCwd(cwd);
  } catch {
    return DEFAULT_BROWNFIELD_POLICY;
  }
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
  const policy = deps.policy ?? effectiveGuardrailPolicy(deps.cwd);
  // The repo-root tolerance set, resolved ONCE for the whole phase and
  // shared with the frame's invariant step (one resolution per phase).
  const tolerances = deps.tolerances ?? resolveTolerances(deps.cwd);
  const invariantStep =
    deps.invariantStep ??
    frameInvariantStep(deps.cwd, deps.trust, { exec: deps.exec, git: deps.git, tolerances });
  const records: RecipeOrderRecord[] = [];
  const recordAll = (
    group: readonly WorkOrder[],
    outcome: RecipeOutcome,
    extra?: Pick<RecipeOrderRecord, 'droppedPaths' | 'invariants' | 'invariantDisclosures'>,
  ) => {
    for (const order of group) {
      const packages = packagesNamedBy(order.findings);
      records.push({
        orderId: order.id,
        class: String(order.class),
        recipe: order.recipe!,
        outcome,
        ...(packages.length > 0 ? { packages } : {}),
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
        policy,
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
      // Every group member is recorded on EVERY exit path (review fix 10):
      // the open members' still-open rules are recorded here whether the
      // commit succeeds or the invariant step fails, so no order enters the
      // agent queue without its ledger/breaker row.
      const recordOpen = (): void => {
        if (open.length === 0 || outcome.kind !== 'failed') return;
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
      };
      // The frame's invariant step (4.4.6) on the recipe's own diff, BEFORE
      // the commit: an invariant the diff tripped is re-established (its
      // rewritten paths ride the same commit as the frame's own) or the
      // whole diff is discarded with the failure named, so a recipe can
      // never commit a manifest whose lockfile the frame could not sync.
      let invariants: Awaited<ReturnType<TreeInvariantStep>>;
      try {
        invariants = await invariantStep({ changedPaths: inside, baseHead: 'HEAD' });
      } catch (err) {
        deps.git.discardPaths(inside);
        recordAll(
          applying,
          {
            kind: 'failed',
            step: 'tree-invariants',
            output: tail(err instanceof Error ? err.message : String(err)),
          },
          dropped,
        );
        recordOpen();
        continue;
      }
      // An owned path that was ALREADY dirty before the step carries user
      // content: it is never discarded and never committed by the frame
      // (disclosed on the outcome instead).
      const preDirty = new Set(
        invariants.applied.flatMap((o) =>
          o.status === 'reestablished' || o.status === 'could-not-reestablish'
            ? (o.preDirtyOwned ?? [])
            : [],
        ),
      );
      const invariantsDisclosure = {
        ...(invariants.applied.length > 0 ? { invariants: invariants.applied } : {}),
        ...(invariants.disclosures.length > 0
          ? { invariantDisclosures: invariants.disclosures }
          : {}),
      };
      if (invariants.failed) {
        deps.git.discardPaths(
          [...new Set([...inside, ...invariants.changedPaths])].filter((p) => !preDirty.has(p)),
        );
        recordAll(
          applying,
          {
            kind: 'failed',
            step: 'tree-invariants',
            output: invariants.applied
              .filter(
                (o) =>
                  o.status !== 'already-consistent' &&
                  o.status !== 'reestablished' &&
                  o.status !== 'pre-existing',
              )
              .map(describeTreeInvariantOutcome)
              .join('; '),
          },
          { ...dropped, ...invariantsDisclosure },
        );
        recordOpen();
        continue;
      }
      const committed = [...new Set([...inside, ...invariants.changedPaths])].filter(
        (p) => !preDirty.has(p),
      );
      deps.git.commitPaths(
        committed,
        `fix(${first.class}): ${nameOrders(applying.map((o) => o.id))} (${decl.id} recipe)`,
      );
      recordAll(
        applying,
        { kind: 'applied', changedFiles: committed },
        { ...dropped, ...invariantsDisclosure },
      );
      recordOpen();
    }
  }
  return records;
}
