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
import type { RemediateBudget } from '../config';
import type { RichBaselineEntry } from '../../baseline/types';
import { matchRecipe, RECIPE_REGISTRY, type RecipeDeclaration } from './recipes-registry';
import { floorOrders, type FloorFailureInput, type ManifestRoot } from './floor-orders';
import { advisoryOrders, type AdvisoryInput } from './advisory-orders';
import { attributedLintOrders, debtLintOrders, type CustomCheckEntry } from './lint-orders';
import {
  compareRank,
  identityOnly,
  kindsOf,
  undispatch,
  type BudgetCapFor,
  type Draft,
  type Ranked,
} from './shared';
import type {
  UndispatchableGroup,
  WorkOrder,
  WorkOrderClass,
  WorkOrderFinding,
  WorkOrderPlan,
} from './types';

export type { FloorFailureInput, ManifestRoot } from './floor-orders';
export type { AdvisoryInput } from './advisory-orders';
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

export interface PlannerInput {
  /** Failing entry-floor checks, attributed (empty when no floor source). */
  readonly floorFailures: readonly FloorFailureInput[];
  readonly blocking: readonly BlockingInput[];
  readonly deferred: readonly DeferredInput[];
  /** Grandfathered entries NOT under any active allowlist entry. */
  readonly debt: readonly RichBaselineEntry[];
  /** Dependency roots for envelope derivation (the root has `dir: ''`). */
  readonly manifests: readonly ManifestRoot[];
  /** The pack-declared install command; undefined = none known (disclosed). */
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
  readonly policy: {
    readonly maxSliceSize: number;
    /** Per class, the selecting task's effective budget (`budgetForTask`). */
    readonly budgetFor: BudgetCapFor;
  };
}

export interface PlannerOptions {
  readonly registry?: readonly RecipeDeclaration[];
}

/** The tier decision: `recipe` when a registry entry matches, else `agent`. */
export function assignTier(
  order: Draft,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): WorkOrder {
  const recipe = matchRecipe({ ...order, tier: 'agent' }, registry);
  return recipe ? { ...order, tier: 'recipe', recipe: recipe.id } : { ...order, tier: 'agent' };
}

/** A budget resolver that gives every class the same cap (tests, callers
 *  without a task catalog). */
export function uniformBudget(cap: RemediateBudget): BudgetCapFor {
  return () => cap;
}

export function planWorkOrders(input: PlannerInput, opts: PlannerOptions = {}): WorkOrderPlan {
  const registry = opts.registry ?? RECIPE_REGISTRY;
  const undispatchable: UndispatchableGroup[] = [];
  const ctx = {
    manifests: input.manifests,
    ...(input.install ? { install: input.install } : {}),
    capFor: input.policy.budgetFor,
    maxSliceSize: input.policy.maxSliceSize,
  };

  const blockingAdvisories: AdvisoryInput[] = [];
  const blockingLint: Array<{ entry: CustomCheckEntry; attribution: 'net-new' }> = [];
  const noClass: WorkOrderFinding[] = [];
  for (const b of input.blocking) {
    if (b.kind === 'dep-vuln') blockingAdvisories.push(b.advisory);
    else if (b.kind === 'custom-check')
      blockingLint.push({ entry: b.entry, attribution: 'net-new' });
    else noClass.push(identityOnly(b.entry.kind, b.entry.id, 'net-new'));
  }
  undispatch(
    undispatchable,
    `blocking findings whose kind has no work-order class yet (${kindsOf(noClass)})`,
    noClass,
  );

  const deferredAdvisories: Array<{ advisory: AdvisoryInput; expiresAt: string }> = [];
  const deferredLint: Array<{ entry: CustomCheckEntry; attribution: 'deferred' }> = [];
  const unjoined: WorkOrderFinding[] = [];
  const deferredNoClass: WorkOrderFinding[] = [];
  for (const d of input.deferred) {
    if (d.kind === 'dep-vuln')
      deferredAdvisories.push({ advisory: d.advisory, expiresAt: d.expiresAt });
    else if (d.kind === 'custom-check')
      deferredLint.push({ entry: d.entry, attribution: 'deferred' });
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

  const debtLint: CustomCheckEntry[] = [];
  const debtNoClass: WorkOrderFinding[] = [];
  for (const e of input.debt) {
    if (e.kind === 'custom-check') debtLint.push(e);
    else debtNoClass.push(identityOnly(e.kind, e.id, 'pre-existing'));
  }
  undispatch(
    undispatchable,
    `debt entries whose kind has no work-order class yet (${kindsOf(debtNoClass)})`,
    debtNoClass,
  );

  const ranked: Ranked[] = [
    ...floorOrders(input.floorFailures, ctx),
    ...advisoryOrders(blockingAdvisories, deferredAdvisories, ctx),
    ...attributedLintOrders([...blockingLint, ...deferredLint], ctx, undispatchable),
    ...debtLintOrders(debtLint, ctx, undispatchable),
  ].sort(compareRank);

  // Ids are unique by construction (one builder per class, one order per
  // natural unit); a collision would be a builder bug, so it is surfaced,
  // never silently deduplicated.
  const seen = new Set<string>();
  const orders: WorkOrder[] = [];
  for (const { draft } of ranked) {
    if (seen.has(draft.id)) throw new Error(`work-order planner produced duplicate id ${draft.id}`);
    seen.add(draft.id);
    orders.push(assignTier(draft, registry));
  }
  return { orders, undispatchable };
}

/** The orders a task selects, by class. Open-ended tasks select nothing. */
export function selectOrders(plan: WorkOrderPlan, classes: readonly WorkOrderClass[]): WorkOrder[] {
  const wanted = new Set<string>(classes);
  return plan.orders.filter((o) => wanted.has(o.class));
}
