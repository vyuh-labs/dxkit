/**
 * Documentation dimension — shallow score for health aggregation.
 *
 * Phase 3: delegates to scoring.ts (identical behavior).
 * Future: may expand to include docstring coverage via graphify AST.
 */
import { DimensionScore } from '../types';
import { ScoreInput, scoreDocumentation } from '../scoring';

export function scoreDocsDimension(input: ScoreInput): DimensionScore {
  return scoreDocumentation(input);
}
