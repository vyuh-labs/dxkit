/**
 * Maintainability dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand with more AST-derived architectural metrics.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreMaintainability } from '../scoring';

export function scoreMaintainabilityDimension(m: HealthMetrics): DimensionScore {
  return scoreMaintainability(m);
}
