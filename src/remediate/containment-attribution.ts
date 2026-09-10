/**
 * Guardrail-red containment, the ATTRIBUTION half (4.4.7), split from
 * `containment.ts` at the module-size bar (the orders-phase /
 * orders-complete precedent): the kept-unit shape, the tiered overlap
 * evidence, the Rule 19 attribution ladder, and the kept-head chain
 * reconstruction. The engine (`containment.ts`) is the only production
 * consumer and re-exports everything, so callers keep one import surface.
 */
import type { BlockingFinding, GuardrailGateResult } from '../lanes/verify';
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import { pathInEnvelope } from './recipes/envelope';
import type { RecipeOrderRecord, RecipePhaseSummary } from './recipes/run-recipes';
import type { OrderRunRecord, RemediateGit } from './outcome';
import type { WorkOrder, WorkOrderEnvelope } from './work-orders/types';
import {
  RECIPE_REGISTRY,
  containmentUnitOf,
  type RecipeDeclaration,
} from './work-orders/recipes-registry';
import { packagesNamedBy } from './work-orders/shared';

/** One kept unit of the landed head: a kept agent order, the kept
 *  group-unit recipes as a whole (the 4.4.6 drop granularity, for orders
 *  that share manifest hunks), or ONE commit of a recipe that declares
 *  `containmentUnit: 'order'` (4.4.8: a file-scoped fix drops alone). */
export interface KeptUnit {
  readonly unit: 'agent-order' | 'recipe-group' | 'recipe-order';
  readonly orderIds: readonly string[];
  /** The unit's commit range on the branch (`from..to`). */
  readonly from: string;
  readonly to: string;
  /** Repo-relative paths the unit's commits changed. */
  readonly diffPaths: readonly string[];
  /** The order's envelope (agent orders; the recipe group attributes on
   *  its committed diff alone). */
  readonly envelope?: WorkOrderEnvelope;
  /** Packages the order's findings name (dep-advisory evidence). */
  readonly packages: ReadonlySet<string>;
  /** The driver reported this order's run failed or was cut short; its
   *  committed partial verified, but it is first in line for attribution. */
  readonly driverFailed: boolean;
}

export interface ContainmentArgs {
  readonly git: RemediateGit;
  readonly baseHead: string;
  /** HEAD after the recipe tier (the chain sanity check needs it). */
  readonly agentBase: string;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
  readonly recipes: RecipePhaseSummary;
  readonly records: readonly OrderRunRecord[];
  /** The dispatched work orders, by id (envelope + package evidence). */
  readonly ordersById: ReadonlyMap<string, WorkOrder>;
  /** The red final-guardrail result being contained. */
  readonly guardrail: GuardrailGateResult;
  readonly isManifestPath: (p: string) => boolean;
  /** The recipe registry the containment unit of each recipe is read from
   *  (injected for tests; defaults to the built-in registry). */
  readonly registry?: readonly RecipeDeclaration[];
}

/** Overlap evidence between one blocking finding and one kept unit, with
 *  its STRENGTH tier, or null when they do not overlap. Tier 1 (direct):
 *  the order names the finding's package, or its committed diff touches
 *  the finding's file. Tier 2 (circumstantial): the file merely sits
 *  inside the order envelope, or a package-shaped finding meets the
 *  manifest heuristic. The tiers exist because a repo-wide envelope (a
 *  whole-build floor order) overlaps EVERY located finding; without
 *  ranking, that circumstantial overlap plus the driver tiebreak could
 *  outvote the order whose diff actually touched the file. */
export interface OverlapEvidence {
  /** Lower is stronger: 1 = direct (package name / diff touch), 2 =
   *  circumstantial (envelope containment / manifest heuristic). */
  readonly tier: 1 | 2;
  readonly evidence: string;
}

export function overlapEvidence(
  f: BlockingFinding,
  u: KeptUnit,
  isManifestPath: (p: string) => boolean,
): OverlapEvidence | null {
  if (f.package !== undefined && u.packages.has(f.package)) {
    return { tier: 1, evidence: `the order names package ${f.package}` };
  }
  if (f.file !== undefined) {
    if (u.diffPaths.includes(f.file)) {
      return { tier: 1, evidence: `the committed diff touches ${f.file}` };
    }
    if (u.envelope && pathInEnvelope(f.file, u.envelope)) {
      return { tier: 2, evidence: `${f.file} is inside the order envelope` };
    }
    return null;
  }
  if (f.package !== undefined) {
    // A package-shaped finding with no file: any unit that changed the
    // dependency graph is a candidate (a pin can pull a transitive
    // advisory in). Circumstantial, so a tier-1 package naming anywhere
    // outranks it.
    if (u.diffPaths.some(isManifestPath)) {
      return { tier: 2, evidence: 'the committed diff touches a dependency manifest' };
    }
    if (u.envelope?.manifests === true) {
      return { tier: 2, evidence: 'the order envelope allows manifest changes' };
    }
    return null;
  }
  return null;
}

export type FindingAttribution =
  | { readonly kind: 'attributed'; readonly unit: KeptUnit; readonly evidence: string }
  | { readonly kind: 'ambiguous'; readonly units: readonly KeptUnit[] }
  | { readonly kind: 'unattributed' };

/**
 * Attribute ONE blocking finding to ONE kept unit, or say why it cannot be
 * (Rule 19). Evidence STRENGTH decides first: when any tier-1 (direct)
 * candidate exists, every tier-2 (circumstantial) candidate is out of the
 * running. Only WITHIN the surviving tier do the narrowing steps apply:
 * the unit(s) naming the finding's package, then a driver-failed unit
 * over verified ones. A tiebreak must never beat evidence.
 */
export function attributeFinding(
  f: BlockingFinding,
  units: readonly KeptUnit[],
  isManifestPath: (p: string) => boolean,
): FindingAttribution {
  const candidates = units
    .map((u) => ({ u, o: overlapEvidence(f, u, isManifestPath) }))
    .filter((c): c is { u: KeptUnit; o: OverlapEvidence } => c.o !== null);
  if (candidates.length === 0) return { kind: 'unattributed' };
  const bestTier = Math.min(...candidates.map((c) => c.o.tier));
  let pool = candidates.filter((c) => c.o.tier === bestTier);
  const notes: string[] = [];
  if (pool.length < candidates.length) {
    notes.push('direct evidence outranked envelope-level overlap on other orders');
  }
  const pkg = f.package;
  if (pool.length > 1 && pkg !== undefined) {
    const named = pool.filter((c) => c.u.packages.has(pkg));
    if (named.length > 0 && named.length < pool.length) {
      pool = named;
      notes.push(`narrowed to the order(s) naming package ${pkg}`);
    }
  }
  if (pool.length > 1) {
    const failed = pool.filter((c) => c.u.driverFailed);
    if (failed.length > 0 && failed.length < pool.length) {
      pool = failed;
      notes.push('driver-failed order preferred over verified ones (the ambiguity tiebreak)');
    }
  }
  if (pool.length === 1) {
    return {
      kind: 'attributed',
      unit: pool[0].u,
      evidence: [pool[0].o.evidence, ...notes].join('; '),
    };
  }
  return { kind: 'ambiguous', units: pool.map((c) => c.u) };
}

/** A kept recipe unit over `records`, spanning `from..to`. */
function recipeUnit(
  c: ContainmentArgs,
  unit: 'recipe-group' | 'recipe-order',
  records: readonly RecipeOrderRecord[],
  from: string,
  to: string,
): KeptUnit {
  return {
    unit,
    orderIds: records.map((r) => r.orderId),
    from,
    to,
    diffPaths: c.git.changedPaths(from, to),
    // The packages the unit's applied orders name (recorded per record by
    // the recipe executor): a red on a package the RECIPE pinned must
    // attribute to the group on tier-1 evidence, never fall through to a
    // driver tiebreak that blames an innocent agent order.
    packages: new Set(records.flatMap((r) => r.packages ?? [])),
    driverFailed: false,
  };
}

/**
 * The kept recipe tier as units (4.4.8), from `from` to the verified group
 * head. Applied records are walked in commit order (the executor records
 * them as it commits); consecutive records sharing a commit are one block
 * (a file's lint slices). Every block up to the LAST block whose recipe
 * declares `containmentUnit: 'group'` folds into ONE `recipe-group` unit
 * (orders sharing manifest hunks revert together; an `order` block that
 * sits inside that range is absorbed rather than split out of a range it
 * lies within, the conservative reading); each block after it is its own
 * `recipe-order` unit. The executor commits group recipes first, so on a
 * real run the group range is contiguous and every file-scoped commit gets
 * its own unit. An applied record with NO recorded commit (an older
 * summary) cannot be placed, so the whole tier stays the single group unit
 * it was before per-order units existed. A chain that does not end at the
 * verified head is a refusal string: containment never reverts a range it
 * cannot trust.
 */
function recipeTierUnits(c: ContainmentArgs, from: string, head: string): KeptUnit[] | string {
  const applied = c.recipes.records.filter((r) => r.outcome.kind === 'applied');
  if (applied.some((r) => r.commit === undefined)) {
    return [recipeUnit(c, 'recipe-group', applied, from, head)];
  }
  const registry = c.registry ?? RECIPE_REGISTRY;
  const blocks: { commit: string; records: RecipeOrderRecord[] }[] = [];
  for (const r of applied) {
    const last = blocks[blocks.length - 1];
    if (last && last.commit === r.commit) last.records.push(r);
    else blocks.push({ commit: r.commit!, records: [r] });
  }
  let groupEnd = -1;
  blocks.forEach((b, i) => {
    if (containmentUnitOf(b.records[0].recipe, registry) === 'group') groupEnd = i;
  });
  const units: KeptUnit[] = [];
  let prev = from;
  const groupBlocks = blocks.slice(0, groupEnd + 1);
  if (groupBlocks.length > 0) {
    const to = groupBlocks[groupBlocks.length - 1].commit;
    units.push(
      recipeUnit(
        c,
        'recipe-group',
        groupBlocks.flatMap((b) => b.records),
        prev,
        to,
      ),
    );
    prev = to;
  }
  for (const b of blocks.slice(groupEnd + 1)) {
    units.push(recipeUnit(c, 'recipe-order', b.records, prev, b.commit));
    prev = b.commit;
  }
  if (prev !== head) {
    return (
      `the recipe tier's commits end at ${prev} but its verified head is ${head}, so the ` +
      'per-order recipe ranges cannot be trusted'
    );
  }
  return units;
}

/**
 * Reconstruct the kept units' commit ranges from the chained kept
 * dispositions (each drop reset to the previously verified head, so the
 * kept heads chain from `baseHead` to the verified head). A chain that
 * does not close is a string (the refusal reason): containment never
 * reverts ranges it cannot trust.
 */
export function buildKeptUnits(c: ContainmentArgs): KeptUnit[] | string {
  const units: KeptUnit[] = [];
  let prev = c.baseHead;
  const gv = c.recipes.groupVerification;
  if (gv?.kind === 'kept') {
    const recipeUnits = recipeTierUnits(c, prev, gv.head);
    if (typeof recipeUnits === 'string') return recipeUnits;
    units.push(...recipeUnits);
    prev = gv.head;
  } else if (gv === undefined && c.agentBase !== c.baseHead) {
    return (
      'recipe commits exist without a per-group verification record, so the per-order ' +
      'commit ranges cannot be reconstructed'
    );
  }
  for (const rec of c.records) {
    if (rec.disposition?.kind !== 'kept') continue;
    const order = c.ordersById.get(rec.orderId);
    if (!order) {
      return `no work order is in scope for kept record ${rec.orderId}, so its range cannot be attributed`;
    }
    units.push({
      unit: 'agent-order',
      orderIds: [rec.orderId],
      from: prev,
      to: rec.disposition.head,
      diffPaths: c.git.changedPaths(prev, rec.disposition.head),
      envelope: order.envelope,
      packages: new Set(packagesNamedBy(order.findings)),
      driverFailed: rec.outcome === 'failed' || rec.outcome === 'partial',
    });
    prev = rec.disposition.head;
  }
  const head = c.git.head();
  if (prev !== head) {
    return (
      `the kept orders' commit chain ends at ${prev} but the verified head is ${head}, ` +
      'so the per-order ranges cannot be trusted'
    );
  }
  return units;
}
