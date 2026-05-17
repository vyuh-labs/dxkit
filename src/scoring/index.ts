/**
 * Scoring module public surface.
 *
 * Consumers should import scoring primitives from this barrel rather
 * than reaching into individual files. Per-dimension specs are
 * registered in `dimensions/<name>.ts` (added in subsequent commits;
 * the registry below grows as each dimension migrates).
 */

export type { Rating, CapTier, Deduction, CapApplied, TopAction, ScoreResult } from './result';

export type { PenaltyRule, CapRule, DimensionScoringSpec } from './spec';

export { RATING_THRESHOLDS, CAP_TIERS, ratingFromScore } from './thresholds';
export { evaluateSpec } from './evaluator';

import type { DimensionScoringSpec } from './spec';

/**
 * Central index of all dimension scoring specs. Populated as each
 * dimension's spec lands. Empty in the foundation commit; consumers
 * iterating over this registry (e.g. recipe-playbook test, future
 * cross-dimension renderers) will pick up new specs automatically as
 * they're registered.
 */
export const SCORING_SPECS: readonly DimensionScoringSpec<unknown>[] = [];
