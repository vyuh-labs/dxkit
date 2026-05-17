/**
 * Developer Experience dimension — health-side adapter over the
 * declarative DX scoring spec.
 *
 * Builds `DxScoreInput` from the health-side `ScoreInput`
 * (HealthMetrics) and dispatches through `evaluateSpec`. The
 * resulting `DimensionScore` carries the score, rating, provenance,
 * and the dimension-specific metrics + details surfaced in the
 * health audit's markdown.
 */
import { DX_SCORING_SPEC, type DxScoreInput, evaluateSpec, ratingFromScore } from '../../scoring';
import { DimensionScore, ScoreInput } from '../types';

export function toDxScoreInput(input: ScoreInput): DxScoreInput {
  const m = input.metrics;
  return {
    ciConfigCount: m.ciConfigCount,
    dockerConfigCount: m.dockerConfigCount,
    precommitConfigCount: m.precommitConfigCount,
    makefileExists: m.makefileExists,
    envExampleExists: m.envExampleExists,
    npmScriptsCount: m.npmScriptsCount,
    contributingExists: m.contributingExists,
    readmeLines: m.readmeLines,
    changelogExists: m.changelogExists,
  };
}

/**
 * Score-only adapter for the health remediation planner. Mirrors the
 * other dimensions' `score*FromScoreInput` shims.
 */
export function scoreDxFromScoreInput(input: ScoreInput): { score: number } {
  return evaluateSpec(DX_SCORING_SPEC, toDxScoreInput(input));
}

export function scoreDxDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const scoreInput = toDxScoreInput(input);
  const result = evaluateSpec(DX_SCORING_SPEC, scoreInput);
  const score = result.score;

  return {
    score,
    maxScore: 100,
    rating: ratingFromScore(score),
    rawScore: result.rawScore,
    rawPenalty: result.rawPenalty,
    methodology: result.methodology,
    deductions: result.deductions,
    capsApplied: result.capsApplied,
    topActions: result.topActions,
    metrics: {
      ciConfigCount: m.ciConfigCount,
      dockerConfigCount: m.dockerConfigCount,
      precommitConfigCount: m.precommitConfigCount,
      makefileExists: m.makefileExists,
      envExampleExists: m.envExampleExists,
      npmScriptsCount: m.npmScriptsCount,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `CI configs: ${m.ciConfigCount}` +
      `. Docker: ${m.dockerConfigCount > 0 ? 'yes' : 'no'}` +
      `. Pre-commit hooks: ${m.precommitConfigCount > 0 ? 'yes' : 'no'}` +
      `. Makefile: ${m.makefileExists ? 'yes' : 'no'}` +
      `. .env.example: ${m.envExampleExists ? 'yes' : 'no'}` +
      `. npm scripts: ${m.npmScriptsCount}` +
      '.',
  };
}
