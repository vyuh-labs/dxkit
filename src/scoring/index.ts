/**
 * Scoring module public surface.
 *
 * Consumers should import scoring primitives from this barrel rather
 * than reaching into individual files. Per-dimension specs are
 * registered in `dimensions/<name>.ts` (added in subsequent commits;
 * the registry below grows as each dimension migrates).
 */

export type { Rating, CapTier, Deduction, CapApplied, TopAction, ScoreResult } from './result';

export type { PenaltyRule, CapRule, DimensionScoringSpec } from './spec';

export { RATING_THRESHOLDS, CAP_TIERS, ratingFromScore } from './thresholds';
export { evaluateSpec } from './evaluator';
export { formatTopActionLine, formatTopActionsBlock } from './format';
export type { ScoreResultLike } from './format';
export { computeOverall, DIMENSION_WEIGHTS, DIMENSION_LABEL } from './overall';
export type { DimensionId, CrossDimensionAction, OverallResult } from './overall';

import type { DimensionScoringSpec } from './spec';
import { SECURITY_SCORING_SPEC } from './dimensions/security';
import { QUALITY_SCORING_SPEC } from './dimensions/quality';
import { TESTING_SCORING_SPEC } from './dimensions/testing';
import { DOCUMENTATION_SCORING_SPEC } from './dimensions/documentation';
import { MAINTAINABILITY_SCORING_SPEC } from './dimensions/maintainability';
import { DX_SCORING_SPEC } from './dimensions/dx';

export { SECURITY_SCORING_SPEC } from './dimensions/security';
export type { SecurityScoreInput } from './dimensions/security';
export { QUALITY_SCORING_SPEC } from './dimensions/quality';
export type { QualityScoreInput } from './dimensions/quality';
export { TESTING_SCORING_SPEC } from './dimensions/testing';
export type { TestingScoreInput } from './dimensions/testing';
export { DOCUMENTATION_SCORING_SPEC } from './dimensions/documentation';
export type { DocumentationScoreInput } from './dimensions/documentation';
export { MAINTAINABILITY_SCORING_SPEC } from './dimensions/maintainability';
export type { MaintainabilityScoreInput } from './dimensions/maintainability';
export { DX_SCORING_SPEC } from './dimensions/dx';
export type { DxScoreInput } from './dimensions/dx';

/**
 * Central index of all dimension scoring specs. Each per-dimension
 * spec lands as it migrates from the legacy scorer; consumers
 * iterating over this registry (recipe-playbook test, future
 * cross-dimension renderers) pick up new specs automatically.
 */
export const SCORING_SPECS: readonly DimensionScoringSpec<unknown>[] = [
  SECURITY_SCORING_SPEC as DimensionScoringSpec<unknown>,
  QUALITY_SCORING_SPEC as DimensionScoringSpec<unknown>,
  TESTING_SCORING_SPEC as DimensionScoringSpec<unknown>,
  DOCUMENTATION_SCORING_SPEC as DimensionScoringSpec<unknown>,
  MAINTAINABILITY_SCORING_SPEC as DimensionScoringSpec<unknown>,
  DX_SCORING_SPEC as DimensionScoringSpec<unknown>,
];
