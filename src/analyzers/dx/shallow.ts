/**
 * Developer Experience dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand with more DX indicators (devcontainer, IDE config, etc).
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreDeveloperExperience } from '../scoring';

export function scoreDxDimension(m: HealthMetrics): DimensionScore {
  return scoreDeveloperExperience(m);
}
