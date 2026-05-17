/**
 * Pure-function spec evaluator. The single code path every dimension's
 * score travels through.
 *
 * Same spec + same input → same `ScoreResult`, every time. No I/O, no
 * clock, no randomness. This is the determinism property dxkit's
 * scoring depends on for cross-process consistency and for agents to
 * verify expected score deltas after applying a fix.
 *
 * Algorithm:
 *   1. Apply each penalty whose `applies(input)` is true; accumulate
 *      deductions and a running score from `spec.baseline`.
 *   2. Clamp the raw score to [0, 100].
 *   3. Determine which caps apply; sort by ceiling ascending; the
 *      first (lowest-ceiling) cap that binds (i.e. final > ceiling)
 *      lowers the final score to that ceiling.
 *   4. Compute uplift for each surfaced action:
 *      - For deductions: bounded by the current cap (0 if a cap binds).
 *      - For the binding cap: distance to the next-applicable ceiling
 *        OR the post-clamp rawScore, whichever is lower.
 *   5. Build `topActions` by sorting deductions + cap by uplift desc.
 *      Annotate any action whose uplift crosses a rating boundary.
 */

import type { DimensionScoringSpec } from './spec';
import { CAP_TIERS, ratingFromScore } from './thresholds';
import type { CapApplied, Deduction, ScoreResult, TopAction } from './result';

export function evaluateSpec<TInput>(
  spec: DimensionScoringSpec<TInput>,
  input: TInput,
): ScoreResult {
  const deductions: Deduction[] = [];
  let runningScore = spec.baseline;

  for (const rule of spec.penalties) {
    if (!rule.applies(input)) continue;
    const delta = rule.delta(input);
    runningScore += delta;
    const upliftIfFixed = rule.upliftIfFixed ? rule.upliftIfFixed(input) : Math.abs(delta);
    deductions.push({
      id: rule.id,
      reason: rule.describe(input),
      delta,
      upliftIfFixed,
    });
  }

  const rawScore = runningScore;
  const rawPenalty = rawScore - spec.baseline;
  const scoreAfterClamp = Math.round(Math.max(0, Math.min(100, rawScore)));

  const applicableCaps = spec.caps
    .filter((cap) => cap.applies(input))
    .map((cap) => ({ cap, ceiling: CAP_TIERS[cap.tier] }))
    .sort((a, b) => a.ceiling - b.ceiling);

  let finalScore = scoreAfterClamp;
  let bindingCap: CapApplied | null = null;

  for (let i = 0; i < applicableCaps.length; i++) {
    const { cap, ceiling } = applicableCaps[i];
    if (finalScore <= ceiling) continue;
    // Uplift if THIS cap were lifted: next-most-aggressive cap takes
    // over, or the unclamped post-penalty score (capped at 100) bounds
    // if no other cap applies.
    const nextCap = applicableCaps[i + 1];
    const ceilingIfRemoved = nextCap ? Math.min(scoreAfterClamp, nextCap.ceiling) : scoreAfterClamp;
    bindingCap = {
      id: cap.id,
      tier: cap.tier,
      ceiling,
      reason: cap.describe(input),
      upliftIfRemoved: ceilingIfRemoved - ceiling,
    };
    finalScore = ceiling;
    break;
  }

  const capsApplied: readonly CapApplied[] = bindingCap ? [bindingCap] : [];

  // Compute effective uplift for each deduction. When a cap binds,
  // fixing a non-cap deduction can't raise the score past the ceiling,
  // so uplift reads as 0 — surfaces the cap as the real top action.
  const effectiveDeductionUplift = (d: Deduction): number => {
    if (bindingCap) return 0;
    const headroom = 100 - finalScore;
    return Math.max(0, Math.min(d.upliftIfFixed, headroom));
  };

  const currentRating = ratingFromScore(finalScore);

  const projectRating = (uplift: number) => ratingFromScore(Math.min(100, finalScore + uplift));

  const buildTopActions = (): readonly TopAction[] => {
    const actions: TopAction[] = [];
    for (const d of deductions) {
      const uplift = effectiveDeductionUplift(d);
      if (uplift <= 0) continue;
      const projected = projectRating(uplift);
      actions.push({
        source: 'deduction',
        id: d.id,
        reason: d.reason,
        upliftIfFixed: uplift,
        ratingTransition:
          projected !== currentRating ? { from: currentRating, to: projected } : undefined,
      });
    }
    if (bindingCap && bindingCap.upliftIfRemoved > 0) {
      const projected = projectRating(bindingCap.upliftIfRemoved);
      actions.push({
        source: 'cap',
        id: bindingCap.id,
        reason: bindingCap.reason,
        upliftIfFixed: bindingCap.upliftIfRemoved,
        ratingTransition:
          projected !== currentRating ? { from: currentRating, to: projected } : undefined,
      });
    }
    actions.sort((a, b) => b.upliftIfFixed - a.upliftIfFixed);
    return actions;
  };

  return {
    dimension: spec.dimension,
    methodology: spec.methodology,
    rating: currentRating,
    score: finalScore,
    rawScore,
    rawPenalty,
    deductions,
    capsApplied,
    topActions: buildTopActions(),
  };
}
