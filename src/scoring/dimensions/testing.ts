/**
 * Testing dimension — declarative scoring spec.
 *
 * Methodology: additive checklist over test-discipline signals (test
 * ratio, coverage-config presence, runner exit code, line-coverage
 * thresholds) gated on test-file presence, plus a hygiene penalty
 * for source that's predominantly commented-out code.
 *
 * Industry-conventional coverage thresholds: 60% (adequate), 80%
 * (excellent). Sources: CodeClimate default config, SonarQube's
 * Coverage on New Code quality-gate condition (default 80%), Google
 * Testing on the Toilet recommendations. These thresholds are the
 * de-facto convention; dxkit adopts them.
 *
 * Cap rule encodes the Label Contract: when coverage data is absent
 * the dimension can't honestly claim a top-tier rating regardless of
 * how many test files exist — file presence + a green exit code
 * without line-coverage measurement is failing the most basic
 * testing-discipline check.
 *
 *   unmeasured (35)   no coverage data available
 *
 * Source signal flow: the adapter (`src/analyzers/tests/shallow.ts`)
 * builds `TestingScoreInput` from the health-side ScoreInput
 * (HealthMetrics + CapabilityReport) and dispatches through
 * `evaluateSpec`. The standalone test-gaps subcommand uses its own
 * separate analyzer; this dimension only feeds the health rollup.
 */

import type { DimensionScoringSpec } from '../spec';

/**
 * Partition of every signal the Testing scorer reads. The adapter
 * builds this shape; the spec stays consumer-agnostic.
 */
export interface TestingScoreInput {
  /** Total source files (the denominator for test-ratio). */
  sourceFiles: number;
  /** Test files (discovered by name patterns per active language pack). */
  testFiles: number;
  /** True when at least one coverage config file is present
   *  (jest.config + collectCoverage, vitest.config + coverage,
   *  pytest.ini + --cov, etc.). */
  coverageConfigExists: boolean;
  /** Runner exit code: true=green, false=red, null=not invoked. */
  testsPass: boolean | null;
  /** Line-coverage percent (rounded integer). Null when no coverage
   *  artifact was found — the most-conservative interpretation is
   *  "we don't know" and triggers the unmeasured cap. */
  coveragePercent: number | null;
  /** From graphify: ratio of commented-out code in source files
   *  (0.0–1.0). Beyond 0.5 the file is more dead/commented than
   *  active code — a hygiene red flag worth penalizing. Null when
   *  graphify didn't run. */
  commentedCodeRatio: number | null;
}

export const TESTING_SCORING_SPEC: DimensionScoringSpec<TestingScoreInput> = {
  dimension: 'testing',
  methodology: 'industry-coverage-thresholds',
  // Additive baseline: every signal contributes positive points. A
  // repo with zero test files lands at 0 because every gated rule
  // skips.
  baseline: 0,
  penalties: [
    {
      id: 'test-ratio',
      describe: (i) =>
        `${i.testFiles} test files for ${i.sourceFiles} source files ` +
        `(${((i.testFiles / Math.max(i.sourceFiles, 1)) * 100).toFixed(1)}% ratio)`,
      applies: (i) => i.testFiles > 0,
      delta: (i) => Math.min((i.testFiles / Math.max(i.sourceFiles, 1)) * 200, 60),
    },
    {
      id: 'coverage-config-present',
      describe: () => `coverage config detected`,
      applies: (i) => i.testFiles > 0 && i.coverageConfigExists,
      delta: () => 10,
    },
    {
      id: 'tests-passing',
      describe: () => `test runner reports green`,
      applies: (i) => i.testFiles > 0 && i.testsPass === true,
      delta: () => 15,
    },
    {
      id: 'coverage-adequate',
      describe: (i) => `line coverage ${i.coveragePercent}% (≥ 60% threshold met)`,
      applies: (i) => i.testFiles > 0 && i.coveragePercent !== null && i.coveragePercent >= 60, // scoring-spec-ok: industry coverage threshold, not a rating boundary
      delta: () => 10,
    },
    {
      id: 'coverage-excellent',
      describe: (i) => `line coverage ${i.coveragePercent}% (≥ 80% threshold met)`,
      applies: (i) => i.testFiles > 0 && i.coveragePercent !== null && i.coveragePercent >= 80, // scoring-spec-ok: industry coverage threshold, not a rating boundary
      delta: () => 5,
    },
    {
      id: 'commented-code-density',
      describe: (i) =>
        `${((i.commentedCodeRatio ?? 0) * 100).toFixed(0)}% of source is commented-out code`,
      applies: (i) => i.commentedCodeRatio !== null && i.commentedCodeRatio > 0.5,
      delta: () => -15,
    },
  ],
  caps: [
    {
      id: 'coverage-unmeasured',
      tier: 'unmeasured',
      describe: () =>
        `no coverage data available — test runner did not produce a coverage artifact`,
      applies: (i) => i.coveragePercent === null,
    },
  ],
};
