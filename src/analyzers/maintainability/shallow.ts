/**
 * Maintainability dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand with more AST-derived architectural metrics.
 */
import { DimensionScore } from '../types';
import { ScoreInput, scoreMaintainability } from '../scoring';

export function scoreMaintainabilityDimension(input: ScoreInput): DimensionScore {
  return scoreMaintainability(input);
}
