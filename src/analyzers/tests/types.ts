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

export interface TestGapsReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  summary: {
    testFiles: number;
    activeTestFiles: number;
    commentedOutFiles: number;
    effectiveCoverage: number; // 0-100 percentage
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
