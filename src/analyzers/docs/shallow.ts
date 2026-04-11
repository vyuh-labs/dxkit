/**
 * Documentation dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand to include docstring coverage via graphify AST.
 */
import { HealthMetrics, DimensionScore } from '../types';
import { scoreDocumentation } from '../scoring';

export function scoreDocsDimension(m: HealthMetrics): DimensionScore {
  return scoreDocumentation(m);
}
