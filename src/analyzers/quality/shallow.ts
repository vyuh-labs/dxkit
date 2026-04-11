/**
 * Code Quality dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Phase 6: will be replaced with dedicated quality analyzer logic.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreQuality } from '../scoring';

export function scoreQualityDimension(m: HealthMetrics): DimensionScore {
  return scoreQuality(m);
}
