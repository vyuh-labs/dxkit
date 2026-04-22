/**
 * Testing dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Phase 5: will be replaced with dedicated test gap analyzer logic.
 */
import { DimensionScore } from '../types';
import { ScoreInput, scoreTest } from '../scoring';

export function scoreTestsDimension(input: ScoreInput): DimensionScore {
  return scoreTest(input);
}
