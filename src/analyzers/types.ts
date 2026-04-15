/**
 * Core types for deterministic analyzers.
 *
 * Design principles:
 * - Metrics come from tools, not LLM
 * - Scores come from formulas, not judgment
 * - Tools are layered: always-available (grep/find/git) -> project tools -> optional tools
 */

/** Raw metrics gathered by tool runners. All values are exact counts -- no estimates. */
export interface HealthMetrics {
  sourceFiles: number;
  testFiles: number;
  totalLines: number;
  testsPass: boolean | null;
  testsPassing: number;
  testsFailing: number;
  testFramework: string | null;
  coveragePercent: number | null;
  coverageConfigExists: boolean;

  lintErrors: number;
  lintWarnings: number;
  lintTool: string | null;
  typeErrors: number | null;

  filesOver500Lines: number;
  largestFileLines: number;
  largestFilePath: string;
  consoleLogCount: number;
  anyTypeCount: number;

  readmeLines: number;
  readmeExists: boolean;
  docCommentFiles: number;
  apiDocsExist: boolean;
  architectureDocsExist: boolean;
  contributingExists: boolean;
  changelogExists: boolean;

  secretFindings: number;
  secretDetails: Array<{ file: string; line: number; rule: string; severity: string }>;
  /** Count of gitleaks findings filtered by `.dxkit-suppressions.json`. */
  secretSuppressed?: number;
  evalCount: number;
  privateKeyFiles: number;
  envFilesInGit: number;
  tlsDisabledCount: number;
  depVulnCritical: number;
  depVulnHigh: number;
  depVulnMedium: number;
  depVulnLow: number;
  depAuditTool: string | null;

  controllers: number;
  models: number;
  directories: number;
  languages: Array<{ name: string; files: number; lines: number; percentage: number }>;
  nodeEngineVersion: string | null;

  ciConfigCount: number;
  dockerConfigCount: number;
  precommitConfigCount: number;
  makefileExists: boolean;
  envExampleExists: boolean;
  npmScriptsCount: number;

  toolsUsed: string[];
  toolsUnavailable: string[];

  // cloc-derived (Layer 2 -- replaces grep estimates when available)
  clocLanguages: Array<{
    language: string;
    files: number;
    code: number;
    comment: number;
    blank: number;
  }> | null;

  // graphify-derived (Layer 2 -- AST analysis)
  functionCount: number | null;
  classCount: number | null;
  maxFunctionsInFile: number | null;
  maxFunctionsFilePath: string | null;
  godNodeCount: number | null;
  communityCount: number | null;
  avgCohesion: number | null;
  orphanModuleCount: number | null;
  deadImportCount: number | null;
  commentedCodeRatio: number | null;
}

/** Score for a single dimension (0-100). */
export interface DimensionScore {
  score: number;
  maxScore: number;
  status: 'critical' | 'poor' | 'fair' | 'good' | 'excellent';
  metrics: Record<string, number | string | boolean | null>;
  details: string;
}

/** Complete health report. */
export interface HealthReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  summary: {
    overallScore: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
  };
  dimensions: {
    testing: DimensionScore;
    quality: DimensionScore;
    documentation: DimensionScore;
    security: DimensionScore;
    maintainability: DimensionScore;
    developerExperience: DimensionScore;
  };
  languages: Array<{ name: string; files: number; lines: number; percentage: number }>;
  toolsUsed: string[];
  toolsUnavailable: string[];
}
