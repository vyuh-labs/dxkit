/**
 * Developer Experience dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand with more DX indicators (devcontainer, IDE config, etc).
 */
import { DimensionScore, ScoreInput } from '../types';
import { scoreDeveloperExperience } from '../scoring';

export function scoreDxDimension(input: ScoreInput): DimensionScore {
  return scoreDeveloperExperience(input);
}
