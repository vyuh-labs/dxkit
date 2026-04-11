/**
 * Testing dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Phase 5: will be replaced with dedicated test gap analyzer logic.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreTest } from '../scoring';

export function scoreTestsDimension(m: HealthMetrics): DimensionScore {
  return scoreTest(m);
}
