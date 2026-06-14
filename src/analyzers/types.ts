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
  LicensesResult,
  LintResult,
  SecretsResult,
  StructuralResult,
  TestFrameworkResult,
} from '../languages/capabilities/types';
import type { CapApplied, Deduction, Rating, TopAction } from '../scoring';
import type { SecurityAggregate } from './security/aggregator';

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

  // Hygiene + comment metrics shared with the standalone Quality
  // report. Live in HealthMetrics so the canonical Quality scorer
  // reads the SAME values from both consumer paths — closes the
  // dual-Quality-formula drift class structurally. Populated by the
  // cache builder in gatherAnalysisResultBody; standalone analyzeQuality
  // reads them off the cached AnalysisResult instead of re-gathering.
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  staleFiles: number;
  mixedLanguages: boolean;
  commentRatio: number | null;

  /**
   * Count of source files matching any active language pack's
   * `architecturalShape.primaryComponentPaths`. The name preserves
   * the original "controllers" identifier for schema continuity, but
   * the semantics are broader than HTTP controllers: a React project
   * counts components/pages here; a WinForms project counts Forms
   * and ViewModels; a Spring Boot project counts controllers and
   * services. The label rendered in prose comes from
   * `dominantVocabulary(stack.languages)`.
   */
  controllers: number;
  /**
   * Count of source files matching any active language pack's
   * `architecturalShape.modelPaths` (ORM entities, DTOs, schemas).
   * Same schema-continuity note as `controllers`.
   */
  models: number;
  /**
   * Count of source files matching any active language pack's
   * `architecturalShape.routePaths` — the narrower subset of HTTP
   * route handlers / API endpoints. Gates the "Add API documentation"
   * health action: zero on pure-frontend / desktop apps, so the
   * action stays correctly silenced there.
   */
  routeHandlerFiles: number;
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

/**
 * Score for a single dimension (0-100).
 *
 * `rating` is the industry-anchored letter grade derived from `score`
 * via uniform thresholds in `src/scoring/thresholds.ts` (A ≥ 80,
 * B ≥ 60, C ≥ 40, D ≥ 20, E < 20). Same boundaries dxkit has always
 * used; the letter replaces the previous descriptive enum so the
 * customer surface is one concept (a letter) rather than three
 * (number + descriptive status + letter elsewhere).
 *
 * Provenance fields (`rawScore`, `rawPenalty`, `methodology`,
 * `deductions`, `capsApplied`, `topActions`) are populated by
 * dimension adapters that have migrated to declarative spec
 * evaluation in `src/scoring/`. Renderers that consume these
 * structures should treat them as optional and degrade gracefully
 * when absent — the migration lands one dimension at a time. After
 * all six dimensions migrate, the optional markers are tightened in
 * `scripts/check-architecture.sh`.
 */
export interface DimensionScore {
  score: number;
  maxScore: number;
  rating: Rating;
  metrics: Record<string, number | string | boolean | null>;
  details: string;
  rawScore?: number;
  rawPenalty?: number;
  methodology?: string;
  deductions?: readonly Deduction[];
  capsApplied?: readonly CapApplied[];
  topActions?: readonly TopAction[];
}

/**
 * Bundle of every signal a dimension scorer can read. Health-side
 * adapters (`src/analyzers/<dim>/shallow.ts`) build a `ScoreInput`
 * from gathered data and convert to a per-dimension spec input before
 * calling `evaluateSpec`.
 *
 * Lives here in `types.ts` because `ScoreInput` is the health-side
 * aggregator — it composes `HealthMetrics` (filesystem-derived) +
 * `CapabilityReport` (tool-derived) into one bundle the dimension
 * adapters consume. Not a scoring-system concept; the scoring system
 * receives per-dimension spec inputs (e.g. `SecurityScoreInput`).
 */
export interface ScoreInput {
  metrics: HealthMetrics;
  capabilities: CapabilityReport;
  /**
   * Active language flags from the detected stack. Dimension scorers
   * use this to pick per-stack vocabulary for prose (Maintainability)
   * and to gate "Add API documentation" recommendations on real
   * route-handler presence. Optional so legacy fixtures + tests that
   * don't construct a stack still typecheck; consumers fall back to
   * generic words / no per-stack behavior when absent.
   */
  languageFlags?: import('../types').DetectedStack['languages'];
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
   * Per-pack license inventory, aggregated across active language
   * packs. Populated alongside `licensesAvailability` so consumers
   * can distinguish "0 packages, scan ran cleanly" from "0 packages,
   * scanner not installed." The licenses subcommand and the BoM
   * report both read from this single envelope — same canonical
   * source, so cross-report drift on the package list becomes
   * structurally impossible.
   */
  licenses?: LicensesResult;

  /**
   * Availability metadata for the licenses aggregation. Sibling of
   * `licenses` to match the depVulns shape. `available === false`
   * only when at least one active pack with a licenses provider
   * returned an `'unavailable'` outcome. `'no-manifest'` outcomes do
   * NOT degrade availability — that's a clean "nothing to license"
   * state on polyglot repos where one pack activates but has nothing
   * to scan. `unavailableReason` carries the pack name + reason of
   * the first unavailable outcome for the markdown notice. Empty
   * string when available.
   */
  licensesAvailability?: { available: boolean; unavailableReason: string };

  /**
   * Availability metadata for the LINT dispatch. Sibling of
   * `lint` so both consumers (health-side scoreQualityDimension +
   * standalone analyzeQuality) can distinguish "no active pack
   * declared a lint capability" (available: true, no envelope —
   * vacuous "clean") from "active packs attempted lint but every
   * provider returned null" (available: false, no envelope —
   * actionable "not run, install deps"). Populated from
   * `gatherWithProvenance.skipped` in the cache builder.
   */
  lintAvailability?: { available: boolean; unavailableReason: string };

  /** Availability for CODE_PATTERNS (semgrep). Same shape as
   *  lintAvailability — distinguishes "no rulesets active"
   *  (vacuous) from "semgrep was attempted but every provider
   *  returned null" (actionable; tool may have OOM'd or timed
   *  out under parallel load). */
  codePatternsAvailability?: { available: boolean; unavailableReason: string };

  /** Availability for SECRETS (gitleaks + grep-secrets). Same shape.
   *  read by `toSecurityScoreInput` so a failed secret scan
   *  caps the Security score (uncertainty tier) instead of silently
   *  counting as "0 secrets" — the asymmetry that made a customer's
   *  scanner-enabling upgrade read as a score regression. */
  secretsAvailability?: { available: boolean; unavailableReason: string };

  /** Availability for DUPLICATION (jscpd). Same shape. */
  duplicationAvailability?: { available: boolean; unavailableReason: string };

  /** Availability for STRUCTURAL (graphify). Same shape. */
  structuralAvailability?: { available: boolean; unavailableReason: string };
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

  /**
   * G_v4_8 (2.4.7 Phase C1): the canonical `SecurityAggregate` built
   * once per analyzer run from every gathered security envelope
   * (secrets, file findings, code patterns, tls-bypass, dep vulns).
   * Health-side scorers (`security/shallow.ts`) read severity buckets
   * from this field — same source the standalone vuln-scan uses,
   * which closes the D086 class of "two consumers disagree on the
   * same metric." Optional so legacy `ScoreInput` fixtures (no
   * health gather pipeline) still typecheck; consumers fall back to
   * the pre-aggregator path when absent.
   */
  securityAggregate?: SecurityAggregate;
}

/** Complete health report. */
export interface HealthReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  summary: {
    overallScore: number;
    /**
     * Letter rating derived from `overallScore` via the uniform
     * thresholds in `src/scoring/thresholds.ts`. Matches each
     * dimension's `DimensionScore.rating` semantics: A ≥ 80, B ≥ 60,
     * C ≥ 40, D ≥ 20, E < 20. (Pre-2.4.7 this field was named
     * `grade` and used 'F' for failing; unified to 'E' for one
     * consistent letter taxonomy across dimensions + overall.)
     */
    rating: Rating;
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
   * Every source file over the large-file threshold (500 lines),
   * sorted by line count descending. Surfaced verbatim from
   * `HealthMetrics.largestFiles` so the baseline `large-file`
   * producer captures one entry per file. Renderers slice to top-N
   * at the display site (the markdown table shows the top 10).
   * Empty array when no source files were counted.
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
