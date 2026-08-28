/**
 * The ONE planner (`planWorkOrders`): builds work orders from the finding
 * sets dxkit already computes. PURE over injected inputs: no I/O, no clock
 * read, no registry probe beyond the recipe registry it is handed. The I/O
 * adapter that assembles its inputs from a repo is `gather.ts` (Rule 2.30:
 * one place assembles planner inputs).
 *
 * Sources, in value order (section 3A): net-new entry-floor failures, then
 * active deferrals (soonest expiry first), then reachable high/critical
 * blocking advisories, other blocking findings, pre-existing floor failures,
 * and debt slices. The per-source builders live beside this module
 * (`floor-orders.ts`, `advisory-orders.ts`, `lint-orders.ts`).
 */
import type { RichBaselineEntry } from '../../baseline/types';
import {
  matchPackExemption,
  matchRecipe,
  RECIPE_REGISTRY,
  type RecipeDeclaration,
} from './recipes-registry';
import { floorOrders, type FloorFailureInput } from './floor-orders';
import { advisoryOrders, type AdvisoryInput } from './advisory-orders';
import { lintOrders, type CustomCheckEntry, type LintSource } from './lint-orders';
import {
  byteOrder,
  compareRank,
  deriveBudget,
  doneFor,
  identityOnly,
  kindsOf,
  undispatch,
  type BudgetCapFor,
  type Draft,
  type InstallFor,
  type ManifestRoot,
  type Ranked,
} from './shared';
import type {
  UndispatchableGroup,
  WorkOrder,
  WorkOrderClass,
  WorkOrderFinding,
  WorkOrderPlan,
} from './types';

export type { FloorFailureInput } from './floor-orders';
export type { AdvisoryInput } from './advisory-orders';
export type { ManifestRoot } from './shared';
export { BUDGET_DERIVATION, DEFAULT_MAX_SLICE_SIZE, deriveBudget } from './shared';

/** A finding of the guardrail's blocking set, already joined to its entry. */
export type BlockingInput =
  | { readonly kind: 'dep-vuln'; readonly advisory: AdvisoryInput }
  | { readonly kind: 'custom-check'; readonly entry: CustomCheckEntry }
  | { readonly kind: 'other'; readonly entry: RichBaselineEntry };

/** An active deferral joined to what it suppresses: a live/baseline advisory,
 *  a baseline custom-check entry, or nothing (the fingerprint joined to no
 *  finding dxkit can see). */
export type DeferredInput =
  | {
      readonly fingerprint: string;
      readonly expiresAt: string;
      readonly kind: 'dep-vuln';
      readonly advisory: AdvisoryInput;
    }
  | {
      readonly fingerprint: string;
      readonly expiresAt: string;
      readonly kind: 'custom-check';
      readonly entry: CustomCheckEntry;
    }
  | {
      readonly fingerprint: string;
      readonly expiresAt: string;
      readonly kind: 'unjoined';
      readonly declaredKind: string;
    }
  | {
      readonly fingerprint: string;
      readonly expiresAt: string;
      readonly kind: 'other';
      readonly entry: RichBaselineEntry;
    };

/**
 * Per-finding advisory facts dxkit knows from OUTSIDE the finding's own
 * source, keyed by finding id: the live scan's copy for a baseline entry,
 * or an OSV-resolved fix version for a finding whose scanner never carried
 * one. Filled into `AdvisoryInput`s at the ONE application point in
 * `planWorkOrders`, missing fields only: a value the finding's own source
 * stated always wins. This is what lets a deferral or a debt advisory tier
 * `recipe` (the override-pin matches needs a concrete `fixedVersion`)
 * wherever dxkit can actually know the fix.
 */
export interface AdvisoryDetail {
  readonly fixedVersion?: string;
  readonly reachable?: boolean;
  readonly installedVersion?: string;
  readonly pack?: string;
}

export interface PlannerInput {
  /** Failing entry-floor checks, attributed (empty when no floor source). */
  readonly floorFailures: readonly FloorFailureInput[];
  readonly blocking: readonly BlockingInput[];
  readonly deferred: readonly DeferredInput[];
  /** Advisory facts joined from richer sources (see `AdvisoryDetail`). */
  readonly advisoryDetails?: ReadonlyMap<string, AdvisoryDetail>;
  /** Grandfathered entries NOT under any active allowlist entry, every kind
   *  (the planner classifies and discloses; callers never pre-filter). */
  readonly debt: readonly RichBaselineEntry[];
  /** Dependency roots for envelope derivation (the root has `dir: ''`). */
  readonly manifests: readonly ManifestRoot[];
  /** Per producing pack, its declared install command (see `InstallFor`). */
  readonly installFor: InstallFor;
  readonly policy: {
    readonly maxSliceSize: number;
    /** Per class, the selecting task's effective budget (`budgetForTask`). */
    readonly budgetFor: BudgetCapFor;
  };
}

export interface PlannerOptions {
  readonly registry?: readonly RecipeDeclaration[];
}

/** The tier decision: `recipe` when a registry entry matches, else `agent`.
 *  An agent tier caused by a pack's DECLARED capability exemption carries
 *  the exemption on the order, so the plan surface can say why the
 *  deterministic tier was unavailable (disclosed, never silence). */
export function assignTier(
  order: Draft,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): WorkOrder {
  const probe: WorkOrder = { ...order, tier: 'agent' };
  const recipe = matchRecipe(probe, registry);
  if (recipe) return { ...order, tier: 'recipe', recipe: recipe.id };
  const exemption = matchPackExemption(probe, registry);
  return { ...order, tier: 'agent', ...(exemption ? { capabilityExemption: exemption } : {}) };
}

/** Baseline dep-vuln debt as an advisory input (identity + severity only;
 *  the richer live-scan copy wins where both exist). */
function advisoryFromDebt(e: Extract<RichBaselineEntry, { kind: 'dep-vuln' }>): AdvisoryInput {
  return {
    id: e.id,
    package: e.package,
    ...(e.installedVersion !== undefined ? { installedVersion: e.installedVersion } : {}),
    advisoryId: e.advisoryId,
    ...(e.severity !== undefined ? { severity: e.severity } : {}),
  };
}

/** Fill an advisory's MISSING fields from the detail join (never
 *  overwrite: the finding's own source is the closer witness). */
function withAdvisoryDetail(
  a: AdvisoryInput,
  details: ReadonlyMap<string, AdvisoryDetail> | undefined,
): AdvisoryInput {
  const d = details?.get(a.id);
  if (!d) return a;
  return {
    ...a,
    ...(a.fixedVersion === undefined && d.fixedVersion !== undefined
      ? { fixedVersion: d.fixedVersion }
      : {}),
    ...(a.reachable === undefined && d.reachable !== undefined ? { reachable: d.reachable } : {}),
    ...(a.installedVersion === undefined && d.installedVersion !== undefined
      ? { installedVersion: d.installedVersion }
      : {}),
    ...(a.pack === undefined && d.pack !== undefined ? { pack: d.pack } : {}),
  };
}

/**
 * Merge a colliding draft into the earlier (higher-value) order. Every
 * finding-derived field is RECOMPUTED through the builders' own formulas
 * (`doneFor`, `deriveBudget`, the envelope union), never patched: a merge
 * that appended findings but kept the first draft's done ids, budget, and
 * envelope left the order unable to close the merged findings (their ids
 * were absent from `done.absentIds`, their files outside the envelope).
 */
export function mergeCollidingDraft(existing: Draft, draft: Draft, capFor: BudgetCapFor): Draft {
  const known = new Set(existing.findings.map((f) => f.id));
  const extra = draft.findings.filter((f) => !known.has(f.id));
  const findings = [...existing.findings, ...extra];
  return {
    ...existing,
    findings,
    envelope: {
      paths: [...new Set([...existing.envelope.paths, ...draft.envelope.paths])].sort(byteOrder),
      manifests: existing.envelope.manifests || draft.envelope.manifests,
    },
    done: doneFor(existing.done.verifier, findings),
    budget: deriveBudget(findings.length, capFor(existing.class)),
  };
}

export function planWorkOrders(input: PlannerInput, opts: PlannerOptions = {}): WorkOrderPlan {
  const registry = opts.registry ?? RECIPE_REGISTRY;
  const undispatchable: UndispatchableGroup[] = [];
  const ctx = {
    manifests: input.manifests,
    installFor: input.installFor,
    capFor: input.policy.budgetFor,
    maxSliceSize: input.policy.maxSliceSize,
  };

  const blockingAdvisories: AdvisoryInput[] = [];
  const lintSources: LintSource[] = [];
  const noClass: WorkOrderFinding[] = [];
  for (const b of input.blocking) {
    if (b.kind === 'dep-vuln') blockingAdvisories.push(b.advisory);
    else if (b.kind === 'custom-check')
      lintSources.push({ entry: b.entry, attribution: 'net-new' });
    else noClass.push(identityOnly(b.entry.kind, b.entry.id, 'net-new'));
  }
  undispatch(
    undispatchable,
    `blocking findings whose kind has no work-order class yet (${kindsOf(noClass)})`,
    noClass,
  );

  const deferredAdvisories: Array<{ advisory: AdvisoryInput; expiresAt: string }> = [];
  const unjoined: WorkOrderFinding[] = [];
  const deferredNoClass: WorkOrderFinding[] = [];
  for (const d of input.deferred) {
    if (d.kind === 'dep-vuln')
      deferredAdvisories.push({ advisory: d.advisory, expiresAt: d.expiresAt });
    else if (d.kind === 'custom-check')
      lintSources.push({ entry: d.entry, attribution: 'deferred', expiresAt: d.expiresAt });
    else if (d.kind === 'unjoined')
      unjoined.push(identityOnly(d.declaredKind, d.fingerprint, 'deferred'));
    else deferredNoClass.push(identityOnly(d.entry.kind, d.entry.id, 'deferred'));
  }
  undispatch(
    undispatchable,
    'deferred allowlist entries whose fingerprint matches no finding dxkit can see here ' +
      '(not in the live scan, not in the baseline)',
    unjoined,
  );
  undispatch(
    undispatchable,
    `deferred findings whose kind has no work-order class yet (${kindsOf(deferredNoClass)})`,
    deferredNoClass,
  );

  const debtAdvisories: AdvisoryInput[] = [];
  const debtNoClass: WorkOrderFinding[] = [];
  for (const e of input.debt) {
    if (e.kind === 'custom-check') lintSources.push({ entry: e, attribution: 'pre-existing' });
    else if (e.kind === 'dep-vuln') debtAdvisories.push(advisoryFromDebt(e));
    else debtNoClass.push(identityOnly(e.kind, e.id, 'pre-existing'));
  }
  undispatch(
    undispatchable,
    `debt entries whose kind has no work-order class yet (${kindsOf(debtNoClass)})`,
    debtNoClass,
  );

  // The ONE detail-application point: every advisory bucket passes through
  // the same fill before the builder, so a deferral, a blocking pair, and a
  // debt entry all see the identical join (Rule 2.30).
  const detail = (a: AdvisoryInput) => withAdvisoryDetail(a, input.advisoryDetails);
  const ranked: Ranked[] = [
    ...floorOrders(input.floorFailures, ctx),
    ...advisoryOrders(
      blockingAdvisories.map(detail),
      deferredAdvisories.map((d) => ({ ...d, advisory: detail(d.advisory) })),
      debtAdvisories.map(detail),
      ctx,
    ),
    ...lintOrders(lintSources, ctx, undispatchable),
  ].sort(compareRank);

  // Ids are unique by construction (one builder per class, one order per
  // natural unit). Defensively, a collision merges findings into the earlier
  // (higher-value) order and is disclosed — a duplicate must never destroy
  // the plan.
  const byId = new Map<string, { order: WorkOrder; index: number }>();
  const orders: WorkOrder[] = [];
  const collisions: WorkOrderFinding[] = [];
  for (const { draft } of ranked) {
    const existing = byId.get(draft.id);
    if (existing) {
      const merged = assignTier(mergeCollidingDraft(existing.order, draft, ctx.capFor), registry);
      orders[existing.index] = merged;
      byId.set(draft.id, { order: merged, index: existing.index });
      collisions.push(...draft.findings);
      continue;
    }
    const order = assignTier(draft, registry);
    byId.set(draft.id, { order, index: orders.length });
    orders.push(order);
  }
  undispatch(
    undispatchable,
    'planner produced a duplicate order id (a builder bug — findings were merged into the ' +
      'earlier order, nothing was dropped; please report this)',
    collisions,
  );
  return { orders, undispatchable };
}

/** The orders a task selects, by class. Open-ended tasks select nothing. */
export function selectOrders(plan: WorkOrderPlan, classes: readonly WorkOrderClass[]): WorkOrder[] {
  const wanted = new Set<string>(classes);
  return plan.orders.filter((o) => wanted.has(o.class));
}
