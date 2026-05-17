/**
 * Testing dimension — health-side adapter over the declarative
 * testing scoring spec.
 *
 * Builds `TestingScoreInput` from the health-side `ScoreInput`
 * (HealthMetrics + CapabilityReport) and dispatches through
 * `evaluateSpec`. The resulting `DimensionScore` carries the score,
 * rating letter, full provenance (deductions, capsApplied,
 * topActions), and the dimension-specific metrics + details surfaced
 * in the health audit's markdown.
 */
import {
  TESTING_SCORING_SPEC,
  type TestingScoreInput,
  evaluateSpec,
  ratingFromScore,
} from '../../scoring';
import type { CapabilityReport } from '../types';
import { DimensionScore, ScoreInput } from '../types';

function coveragePercentFrom(c: CapabilityReport): number | null {
  const raw = c.coverage?.coverage.linePercent;
  return raw === undefined ? null : Math.round(raw);
}

export function toTestingScoreInput(input: ScoreInput): TestingScoreInput {
  const m = input.metrics;
  const c = input.capabilities;
  return {
    sourceFiles: m.sourceFiles,
    testFiles: m.testFiles,
    coverageConfigExists: m.coverageConfigExists,
    testsPass: m.testsPass,
    coveragePercent: coveragePercentFrom(c),
    commentedCodeRatio: c.structural?.commentedCodeRatio ?? null,
  };
}

/**
 * Score-only adapter for the health remediation planner. Mirrors
 * `scoreSecurityFromScoreInput` / `scoreQualityFromScoreInput` so
 * `health/actions.ts` stays symmetric across dimensions.
 */
export function scoreTestFromScoreInput(input: ScoreInput): { score: number } {
  return evaluateSpec(TESTING_SCORING_SPEC, toTestingScoreInput(input));
}

export function scoreTestsDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const scoreInput = toTestingScoreInput(input);
  const result = evaluateSpec(TESTING_SCORING_SPEC, scoreInput);
  const score = result.score;

  const testRatio = m.testFiles / Math.max(m.sourceFiles, 1);
  const coveragePercent = scoreInput.coveragePercent;
  const testFramework = c.testFramework?.name ?? null;
  const commentedCodeRatio = scoreInput.commentedCodeRatio;

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
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // Capability-owned values (coverage / testFramework / structural)
    // live in `report.capabilities.*` so downstream consumers read
    // them from one place.
    metrics: {
      sourceFiles: m.sourceFiles,
      testFiles: m.testFiles,
      testRatio: Math.round(testRatio * 100) / 100,
      testsPass: m.testsPass,
      coverageConfigExists: m.coverageConfigExists,
    },
    details:
      m.testFiles === 0
        ? `No test files found across ${m.sourceFiles} source files. 0% test coverage.`
        : `${m.testFiles} test files for ${m.sourceFiles} source files (ratio: ${(testRatio * 100).toFixed(1)}%). ` +
          `Tests ${m.testsPass === true ? 'pass' : m.testsPass === false ? 'fail' : 'not run'}. ` +
          (coveragePercent !== null ? `Coverage: ${coveragePercent}%. ` : 'No coverage data. ') +
          // Always surface framework state explicitly. A silent omission
          // when detection fails reads as "no framework needed" rather
          // than "we couldn't infer it" — the latter is actionable
          // (configure the test runner; report a detection gap).
          `Framework: ${testFramework || 'not detected'}.` +
          // When tests are detected but haven't executed AND no coverage
          // artifact is on disk, the customer's next step is to run
          // dxkit's coverage subcommand — surface that explicitly so
          // "0% coverage" doesn't read as an indictment of the codebase.
          (m.testsPass === null && coveragePercent === null
            ? ' Run `vyuh-dxkit coverage` to materialize test execution + coverage data.'
            : '') +
          (commentedCodeRatio !== null && commentedCodeRatio > 0.5
            ? ` Warning: ${(commentedCodeRatio * 100).toFixed(0)}% of source files appear to contain only comments.`
            : ''),
  };
}
