/**
 * Security dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Phase 4: will be replaced with dedicated security analyzer logic.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreSecurity } from '../scoring';

export function scoreSecurityDimension(m: HealthMetrics): DimensionScore {
  return scoreSecurity(m);
}
