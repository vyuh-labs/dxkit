/**
 * The recipe phase's SUMMARY shapes (split from `run-recipes.ts` at the
 * module-size bar): the per-order records, the group-verification record
 * (4.4.6), the phase summary every ledger and completion reads, and the
 * two convenience projections. `run-recipes.ts` re-exports them so every
 * consumer keeps one import surface.
 */
import type { TreeInvariantOutcome } from '../../lanes/tree-invariants';
import type { OrderDisposition } from '../outcome';
import type { RecipeOutcome } from './types';
import type { WorkOrder } from '../work-orders/types';

export interface RecipeOrderRecord {
  readonly orderId: string;
  readonly class: string;
  readonly recipe: string;
  readonly outcome: RecipeOutcome;
  /** Out-of-envelope paths the enforcement discarded (disclosed). */
  readonly droppedPaths?: readonly string[];
  /** Collector/step disclosures for this order's invariant step. */
  readonly invariantDisclosures?: readonly string[];
  /** The frame-owned invariants the recipe's diff tripped and what the
   *  frame did about each (4.4.6), disclosed per order. */
  readonly invariants?: readonly TreeInvariantOutcome[];
  /** Set on an APPLIED record once the recipe group was verified as a
   *  contiguous unit before the agent tier (4.4.6): kept (its commits
   *  land) or dropped (reverted, the reason named; the order stays open). */
  readonly disposition?: OrderDisposition;
}

/** How the recipe group's combined commits fared when verified BEFORE the
 *  agent tier ran (4.4.6): the group either lands as a unit or is dropped
 *  as a unit, with the step and reason named. Absent when no agent order
 *  followed (a recipe-only run is verified once, at completion). */
export type RecipeGroupVerification =
  | { readonly kind: 'kept'; readonly head: string }
  | {
      readonly kind: 'dropped';
      /** `guardrail` marks a containment drop (4.4.7): the final guardrail
       *  attributed blocking findings to the group after it was kept. */
      readonly step: 'install' | 'floor' | 'guardrail';
      readonly reason: string;
      readonly droppedOrderIds: readonly string[];
    }
  | {
      /** Verification INFRASTRUCTURE failed: the group's commits STAY on
       *  the branch (not landed, not reverted); the run completes
       *  `verification-unavailable` before any agent order dispatches. */
      readonly kind: 'unverifiable';
      readonly reason: string;
    };

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
  /** The recipe group's own verification, when an agent order followed. */
  readonly groupVerification?: RecipeGroupVerification;
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
