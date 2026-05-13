/**
 * Core types for deterministic analyzers.
 *
 * Design principles:
 * - Metrics come from tools, not LLM
 * - Scores come from formulas, not judgment
 * - Tools are layered: always-available (grep/find/git) -> project tools -> optional tools
 */

import type {
  CodePatternsResult,
  CoverageResult,
  DepVulnResult,
  DuplicationResult,
  ImportsResult,
  LintResult,
  SecretsResult,
  StructuralResult,
  TestFrameworkResult,
} from '../languages/capabilities/types';

/**
 * Raw metrics gathered by tool runners — the non-capability signals that
 * survive into 2.0. Every capability-owned field (lint, depVulns, coverage,
 * secrets, structural, testFramework) moved to `HealthReport.capabilities`
 * in Phase 10e.C.1/.2 and got deleted from this interface in C.7. What
 * remains is counted-directly-from-the-filesystem data: file counts, line
 * counts, grep-derived markers, doc file checks, config-file presence.
 *
 * All values are exact counts — no estimates.
 */
export interface HealthMetrics {
  sourceFiles: number;
  testFiles: number;
  totalLines: number;
  testsPass: boolean | null;
  testsPassing: number;
  testsFailing: number;
  coverageConfigExists: boolean;

  typeErrors: number | null;

  filesOver500Lines: number;
  largestFileLines: number;
  largestFilePath: string;
  /**
   * 2.4.7 — top N largest files by line count, sorted desc. Backing
   * data for the "Top Files by Size" markdown section. Index 0 is the
   * single largest (mirrors `largestFileLines` / `largestFilePath`,
   * kept for back-compat). Capped to top 10 to keep the report
   * compact.
   */
  largestFiles: Array<{ path: string; lines: number }>;
  consoleLogCount: number;
  anyTypeCount: number;

  readmeLines: number;
  readmeExists: boolean;
  docCommentFiles: number;
  apiDocsExist: boolean;
  architectureDocsExist: boolean;
  contributingExists: boolean;
  changelogExists: boolean;

  evalCount: number;
  privateKeyFiles: number;
  envFilesInGit: number;
  tlsDisabledCount: number;

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

  // cloc-derived — feeds the language breakdown when available.
  clocLanguages: Array<{
    language: string;
    files: number;
    code: number;
    comment: number;
    blank: number;
  }> | null;
}

/** Score for a single dimension (0-100). */
export interface DimensionScore {
  score: number;
  maxScore: number;
  status: 'critical' | 'poor' | 'fair' | 'good' | 'excellent';
  metrics: Record<string, number | string | boolean | null>;
  details: string;
}

/**
 * Aggregated capability envelopes attached to a HealthReport.
 *
 * Phase 10e.C.1 introduces this sub-object alongside the legacy `HealthMetrics`
 * channel. Each field is the dispatched, aggregated envelope produced by one
 * capability (see `src/languages/capabilities/descriptors.ts`). A field is
 * absent only when every provider returned null — e.g. a repo with no active
 * Python/Node/Go/Rust/C# pack, or a global tool that isn't installed.
 *
 * Optional through C.1–C.7 so the legacy path and test fixtures keep working.
 * C.8 narrows HealthReport and removes the legacy fields; `capabilities`
 * becomes the single source of truth in 2.0.0.
 */
export interface CapabilityReport {
  depVulns?: DepVulnResult;
  lint?: LintResult;
  coverage?: CoverageResult;
  imports?: ImportsResult;
  testFramework?: TestFrameworkResult;
  secrets?: SecretsResult;
  codePatterns?: CodePatternsResult;
  duplication?: DuplicationResult;
  structural?: StructuralResult;
  /**
   * D025b (2.4.7): availability metadata for the depVulns aggregation.
   * Sibling field rather than nested into `depVulns` so the envelope
   * shape stays a clean `DepVulnResult` (matches the other capability
   * fields). `available === false` only when at least one active pack
   * returned an `'unavailable'` outcome (tool missing, no output, parse
   * fail). `no-manifest` outcomes do NOT degrade availability — that's
   * a clean "nothing to scan here" state. `unavailableReason` carries
   * the pack name + reason of the first unavailable outcome for the
   * markdown notice (e.g. "csharp: dotnet list package produced no
   * output (see D036)"). Empty when available.
   *
   * Read by the health-side adapter `toSecurityScoreInput` to set
   * `SecurityScoreInput.depVulnsAvailable`, which the security scorer
   * uses to cap the dimension at 65/100. Populated by
   * `gatherDepVulnsWithAvailability` in `analyzers/security/gather.ts`.
   */
  depVulnsAvailability?: { available: boolean; unavailableReason: string };
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
  /**
   * 2.4.7 — top 10 largest source files by line count (post-autogen
   * exclusion). Surfaced verbatim from `HealthMetrics.largestFiles`
   * so consumers (markdown report, dashboard, AI agent) don't have
   * to re-derive. Empty array when no source files were counted.
   */
  largestFiles: Array<{ path: string; lines: number }>;
  toolsUsed: string[];
  toolsUnavailable: string[];
  /**
   * Dispatched capability envelopes (Phase 10e.C.1).
   * Optional until 2.0.0 — legacy `HealthMetrics` fields still carry the
   * same data for scoring and actions. Populated by `analyzeHealthInternal`
   * on every real run.
   */
  capabilities?: CapabilityReport;
}
