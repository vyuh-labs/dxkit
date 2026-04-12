/**
 * Security dimension — shallow score for health aggregation.
 *
 * Computes the DimensionScore using the same formula as scoring.ts
 * (delegating to it), but Phase 4b+ can switch to using the deep
 * analyzer's findings for more accurate scoring.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreSecurity } from '../scoring';

export function scoreSecurityDimension(m: HealthMetrics): DimensionScore {
  return scoreSecurity(m);
}
