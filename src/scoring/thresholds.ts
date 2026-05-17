/**
 * Single source of truth for rating thresholds and cap ceilings used by
 * every dimension scorer.
 *
 * Uniform 0-100 scale with A/B/C/D/E ratings at 80/60/40/20 boundaries
 * applies to every dimension. The per-dimension methodology determines
 * HOW the numeric score is computed (penalty stacks for some, debt-ratio
 * inversion for others); the score-to-rating mapping is uniform.
 *
 * Cap ceilings encode a severity taxonomy: lower ceiling = more serious
 * disclosure. Each tier name says what it means, not just what it does.
 * See `result.ts:CapTier` for the per-tier semantics.
 */

import type { CapTier, Rating } from './result';

/**
 * Uniform rating thresholds. A repo's letter rating is determined by
 * which band its numeric score falls into.
 *
 * Boundaries chosen so each band spans 20 points (familiar academic
 * grading shape), with the A boundary at 80 matching industry
 * convention for "excellent / no blockers."
 */
export const RATING_THRESHOLDS = {
  A: 80,
  B: 60,
  C: 40,
  D: 20,
} as const;

/**
 * Derive the letter rating for a numeric 0-100 score. Pure function;
 * the same score always maps to the same rating.
 */
export function ratingFromScore(score: number): Rating {
  if (score >= RATING_THRESHOLDS.A) return 'A';
  if (score >= RATING_THRESHOLDS.B) return 'B';
  if (score >= RATING_THRESHOLDS.C) return 'C';
  if (score >= RATING_THRESHOLDS.D) return 'D';
  return 'E';
}

/**
 * Cap ceiling per tier. A cap whose condition fires bounds the score at
 * its tier's ceiling, regardless of how clean other signals are.
 *
 * Tier values are derived from the rating boundaries (not picked
 * arbitrarily):
 *   - `trust-broken` (40): top of C — a definite catastrophic failure
 *     (e.g., committed credentials) cannot leave the dimension above C.
 *   - `unmeasured` (35): below C boundary — no signal at all means the
 *     dimension can't claim even "Fair."
 *   - `uncertainty` (65): middle of B — key signal source unavailable
 *     reads as "we can't measure, can't claim A."
 *   - `partial-uncertainty` (75): top of B — some tools didn't run;
 *     can't claim A but signal exists for what was measured.
 *   - `fixable-finding` (79): just-below-A — a concrete bounded finding
 *     blocks A specifically. Smallest possible cap claim: "fix the
 *     finding and you reach A."
 *
 * Lower number = more serious. The evaluator applies the lowest
 * applicable cap (most aggressive) when multiple conditions hold.
 */
export const CAP_TIERS: Record<CapTier, number> = {
  'trust-broken': 40,
  unmeasured: 35,
  uncertainty: 65,
  'partial-uncertainty': 75,
  'fixable-finding': 79,
} as const;
