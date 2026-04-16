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
  type: 'controller' | 'service' | 'interceptor' | 'model' | 'repository' | 'other';
  risk: RiskTier;
  hasMatchingTest: boolean;
}

/** Where the `effectiveCoverage` number came from. */
export type CoverageSource =
  | 'filename-match' // No artifact and no import-graph data available
  | 'import-graph' // Derived from test files' import edges (up to N hops)
  | 'istanbul-summary'
  | 'istanbul-final'
  | 'coverage-py'
  | 'go';

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
