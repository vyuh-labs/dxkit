/**
 * Overall weighted rollup across the six dimension scores.
 *
 * Produces the headline number + letter the customer sees first
 * (dashboard banner, CLI summary line), the rating-tier letter
 * derived from that score via the uniform thresholds in
 * `thresholds.ts`, and a cross-dimension `topActions[]` list
 * sorted by weighted score-impact so the customer sees the
 * single best move across all dimensions.
 *
 * Dimension weights (sum to 1.0):
 *   Testing                25%
 *   Quality                20%
 *   Security               20%
 *   Developer Experience   15%
 *   Documentation          10%
 *   Maintainability        10%
 *
 * Cross-dimension `topActions[]` ranks each dimension's
 * top-action by its weighted contribution to the overall score
 * (`upliftIfFixed * dimensionWeight`). Customers reading the
 * health report's top-of-document recommendation see the single
 * fix that lifts the overall number most — regardless of which
 * dimension it lives in.
 */

import type { DimensionScore } from '../analyzers/types';
import type { Rating, TopAction } from './result';
import { ratingFromScore } from './thresholds';

export type DimensionId =
  | 'testing'
  | 'quality'
  | 'documentation'
  | 'security'
  | 'maintainability'
  | 'developerExperience';

export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  testing: 0.25,
  quality: 0.2,
  security: 0.2,
  developerExperience: 0.15,
  documentation: 0.1,
  maintainability: 0.1,
};

/** Human-readable label for renderers. */
export const DIMENSION_LABEL: Record<DimensionId, string> = {
  testing: 'Testing',
  quality: 'Code Quality',
  security: 'Security',
  developerExperience: 'Developer Experience',
  documentation: 'Documentation',
  maintainability: 'Maintainability',
};

/** A top-action lifted across dimensions, retaining which dimension it
 *  came from so the renderer can label the source. */
export interface CrossDimensionAction extends TopAction {
  readonly dimension: DimensionId;
  readonly dimensionLabel: string;
  /** Per-dimension uplift multiplied by the dimension's weight. The
   *  cross-dimension list is sorted by this value descending. */
  readonly weightedUplift: number;
}

export interface OverallResult {
  readonly overallScore: number;
  readonly rating: Rating;
  /** Cross-dimension top-actions sorted by weighted score-impact. */
  readonly topActions: readonly CrossDimensionAction[];
}

/**
 * Compute the weighted overall score, rating letter, and cross-
 * dimension top-actions list from the six per-dimension scores.
 */
export function computeOverall(
  dimensions: Record<DimensionId, DimensionScore>,
  options: { topActionsLimit?: number } = {},
): OverallResult {
  const overallScore = Math.round(
    (Object.entries(DIMENSION_WEIGHTS) as Array<[DimensionId, number]>).reduce(
      (sum, [id, w]) => sum + dimensions[id].score * w,
      0,
    ),
  );

  const crossActions: CrossDimensionAction[] = [];
  for (const id of Object.keys(DIMENSION_WEIGHTS) as DimensionId[]) {
    const dim = dimensions[id];
    if (!dim.topActions) continue;
    for (const action of dim.topActions) {
      crossActions.push({
        ...action,
        dimension: id,
        dimensionLabel: DIMENSION_LABEL[id],
        weightedUplift: action.upliftIfFixed * DIMENSION_WEIGHTS[id],
      });
    }
  }
  crossActions.sort((a, b) => b.weightedUplift - a.weightedUplift);
  const limit = options.topActionsLimit ?? 10;

  return {
    overallScore,
    rating: ratingFromScore(overallScore),
    topActions: crossActions.slice(0, limit),
  };
}
