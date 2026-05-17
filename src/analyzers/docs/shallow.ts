/**
 * Documentation dimension — health-side adapter over the declarative
 * documentation scoring spec.
 *
 * Builds `DocumentationScoreInput` from the health-side `ScoreInput`
 * (HealthMetrics) and dispatches through `evaluateSpec`. The
 * resulting `DimensionScore` carries the score, rating, provenance
 * (deductions, capsApplied, topActions), and the dimension-specific
 * metrics + details surfaced in the health audit's markdown.
 */
import {
  DOCUMENTATION_SCORING_SPEC,
  type DocumentationScoreInput,
  evaluateSpec,
  ratingFromScore,
} from '../../scoring';
import { DimensionScore, ScoreInput } from '../types';

export function toDocumentationScoreInput(input: ScoreInput): DocumentationScoreInput {
  const m = input.metrics;
  return {
    sourceFiles: m.sourceFiles,
    readmeExists: m.readmeExists,
    readmeLines: m.readmeLines,
    docCommentFiles: m.docCommentFiles,
    apiDocsExist: m.apiDocsExist,
    architectureDocsExist: m.architectureDocsExist,
    contributingExists: m.contributingExists,
    changelogExists: m.changelogExists,
  };
}

/**
 * Score-only adapter for the health remediation planner. Mirrors the
 * other dimensions' `score*FromScoreInput` shims.
 */
export function scoreDocsFromScoreInput(input: ScoreInput): { score: number } {
  return evaluateSpec(DOCUMENTATION_SCORING_SPEC, toDocumentationScoreInput(input));
}

export function scoreDocsDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const scoreInput = toDocumentationScoreInput(input);
  const result = evaluateSpec(DOCUMENTATION_SCORING_SPEC, scoreInput);
  const score = result.score;
  const docRatio = m.docCommentFiles / Math.max(m.sourceFiles, 1);

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
      readmeExists: m.readmeExists,
      readmeLines: m.readmeLines,
      docCommentFiles: m.docCommentFiles,
      docRatio: Math.round(docRatio * 100) / 100,
      apiDocsExist: m.apiDocsExist,
      architectureDocsExist: m.architectureDocsExist,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `README: ${m.readmeExists ? `${m.readmeLines} lines` : 'missing'}` +
      `. ${m.docCommentFiles}/${m.sourceFiles} files have doc comments (${(docRatio * 100).toFixed(1)}%)` +
      `. API docs: ${m.apiDocsExist ? 'yes' : 'no'}` +
      `. Architecture docs: ${m.architectureDocsExist ? 'yes' : 'no'}` +
      `. Contributing: ${m.contributingExists ? 'yes' : 'no'}` +
      '.',
  };
}
