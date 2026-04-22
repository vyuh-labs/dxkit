/**
 * Code Quality dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Phase 6: will be replaced with dedicated quality analyzer logic.
 */
import { DimensionScore } from '../types';
import { ScoreInput, scoreQuality } from '../scoring';

export function scoreQualityDimension(input: ScoreInput): DimensionScore {
  return scoreQuality(input);
}
