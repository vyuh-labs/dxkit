/**
 * Test gap analyzer types.
 */

export type RiskTier = 'critical' | 'high' | 'medium' | 'low';

export interface TestFile {
  path: string;
  status: 'active' | 'commented-out' | 'empty' | 'schema-only';
  framework: string | null;
}

export interface SourceFile {
  path: string;
  lines: number;
  /**
   * Architectural-role label drawn from the path segment that matched
   * an active language pack's `architecturalShape` contribution. Pre-
   * extension this was a closed union with backend-shaped values
   * (`'controller' | 'service' | 'interceptor' | 'model' |
   * 'repository' | 'other'`). Post-extension the values come from
   * the matched path pattern (e.g. `'Forms'` for a csharp WinForms
   * file, `'components'` for a React component), so the field is a
   * free string with `'other'` as the fallback when no pack pattern
   * matches.
   */
  type: string;
  risk: RiskTier;
  hasMatchingTest: boolean;
  /**
   * Caller-file count from the code graph — how many files depend on
   * this one (its blast radius). Stamped only when a graph is present
   * AND the language's call graph is reliable (so an untrustworthy `0`
   * from a language graphify can't resolve, e.g. C#, never masquerades
   * as a leaf). Absent ⇒ unknown, NOT zero. Used to weight the test-gap
   * worklist so the most-depended-on untested files surface first;
   * never affects the Tests score (that comes from summary counts).
   */
  blastRadius?: number;
}

/**
 * Where the `effectiveCoverage` number came from.
 *
 * Single source of truth: `tools/coverage.ts:CoverageSource` enumerates
 * artifact-derived sources (one per coverage tool format). We extend it
 * here with two test-only "derived" sources (`filename-match`,
 * `import-graph`) that the test-gaps analyzer falls back to when no
 * coverage artifact is available. Adding a new pack-owned coverage
 * format means editing one place: `tools/coverage.ts`.
 */
import type { CoverageSource as ArtifactCoverageSource } from '../tools/coverage';

export type CoverageSource =
  | ArtifactCoverageSource
  | 'filename-match' // No artifact and no import-graph data available
  | 'import-graph'; // Derived from test files' import edges (up to N hops)

/**
 * D021 (sub-branch #6, 2.4.7): tier-classification of `coverageSource`.
 * Surfaces the trust level of `effectiveCoverage` so reports + the
 * dashboard can warn users when the headline is heuristic vs ground-truth.
 *
 *   `line-coverage` — real artifact (istanbul, coverage-py, jacoco,
 *                     simplecov, lcov, cobertura, go, ...). The percent
 *                     is line-coverage truth — what your test run
 *                     actually exercised.
 *   `import-graph`  — derived from test files' import edges (up to N
 *                     hops). Stronger than filename-match because
 *                     it follows real call paths, but it doesn't know
 *                     what actually executed at runtime.
 *   `filename-match`— share of source files with a name-matched test.
 *                     Pure heuristic: a 200-line file with a 5-line
 *                     test passes the predicate. Install a coverage
 *                     pipeline to get line-level truth.
 *
 * Computed deterministically from `coverageSource` via
 * `tierFromCoverageSource()` in `tests/index.ts`; no separate input
 * needed.
 */
export type CoverageFidelity = 'line-coverage' | 'import-graph' | 'filename-match';

export interface TestGapsReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  summary: {
    testFiles: number;
    activeTestFiles: number;
    commentedOutFiles: number;
    /**
     * Headline coverage 0-100. When `coverageSource` is `filename-match`, this
     * is the share of source files with a name-matched test. Otherwise it's
     * the line-coverage percentage read from the artifact.
     */
    effectiveCoverage: number;
    /** Which signal produced `effectiveCoverage`. */
    coverageSource: CoverageSource;
    /**
     * D021 (2.4.7): tier-classification of `coverageSource` so consumers
     * can render trust banners + filter on heuristic-vs-ground-truth
     * without re-parsing the source string. See `CoverageFidelity`.
     */
    coverageFidelity: CoverageFidelity;
    /** Project-relative path of the artifact, when one was used. */
    coverageSourceFile?: string;
    sourceFiles: number;
    untestedCritical: number;
    untestedHigh: number;
    untestedMedium: number;
    untestedLow: number;
  };
  testFiles: TestFile[];
  gaps: SourceFile[];
  toolsUsed: string[];
  toolsUnavailable: string[];
}
