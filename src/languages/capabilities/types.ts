/**
 * Capability result envelopes.
 *
 * Phase 10e introduces a capabilities model: language packs (and global
 * gatherers) expose typed *capabilities* that the dispatcher collects,
 * runs, and aggregates. Each capability returns a strongly-typed envelope
 * that extends `CapabilityEnvelope` so every result carries:
 *
 *   - `schemaVersion`: pinned literal so downstream consumers can detect
 *     wire-format changes without inspecting fields.
 *   - `tool`: which underlying tool produced this result. Required for
 *     attribution in reports and for the `toolsUsed` aggregation.
 *
 * Only the envelopes whose shape is stable today are defined here.
 * `ImportsResult` is deferred until Phase 10e.B.4 (imports migration)
 * because the import-graph refactor will fix the shape; defining it
 * speculatively would carry slop forward. Same for the global-gatherer
 * envelopes (`SecretsResult`, `CodePatternsResult`, ...) — those land
 * in Phase 10e.B.6+.
 */

import type { Coverage } from '../../analyzers/tools/coverage';

/** Four-tier severity counts, the project-wide convention. */
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Common shape every capability envelope carries. */
export interface CapabilityEnvelope {
  /** Pinned literal — bump when the shape changes incompatibly. */
  readonly schemaVersion: 1;
  /** Underlying tool name (e.g. 'pip-audit', 'eslint', 'govulncheck'). */
  readonly tool: string;
}

/** Per-finding detail for dep-vuln reports that need more than counts. */
export interface DepVulnFinding {
  id: string;
  package: string;
  installedVersion?: string;
  fixedVersion?: string;
  severity: keyof SeverityCounts;
  source: 'osv.dev' | 'tool-default' | 'tool-reported';
}

/** Dependency vulnerabilities, the depVulns capability. */
export interface DepVulnResult extends CapabilityEnvelope {
  /** Severity-tier counts. Always populated; zeros allowed. */
  counts: SeverityCounts;
  /** Source of severity classification, when enrichment is involved. */
  enrichment: 'osv.dev' | null;
  /** Optional per-finding detail. Deep-mode reports populate this. */
  findings?: DepVulnFinding[];
}

/** Lint output, the lint capability. Tier counts collapse to errors/warnings in legacy fields. */
export interface LintResult extends CapabilityEnvelope {
  counts: SeverityCounts;
}

/** Coverage data, the coverage capability. Wraps the existing Coverage type. */
export interface CoverageResult extends CapabilityEnvelope {
  coverage: Coverage;
}

/** Detected test runner, the testFramework capability. */
export interface TestFrameworkResult extends CapabilityEnvelope {
  /** Lower-case framework id: 'vitest', 'jest', 'pytest', 'go-test', 'cargo-test', 'dotnet-test'. */
  name: string;
}

/**
 * Internal outcome shape used by language packs while bridging from the
 * legacy `gatherMetrics` channel to the capability dispatcher in Phase
 * 10e.B.1. Each pack has a private `gatherDepVulnsResult(cwd)` helper
 * that returns this; the pack's `capabilities.depVulns.gather()` thinly
 * unwraps the envelope, and `gatherMetrics` decomposes it back into
 * legacy `depVuln*` + `toolsUsed`/`toolsUnavailable` strings.
 *
 * The discriminated union captures every distinction `gatherMetrics`
 * historically made: ran-and-parsed, tool-missing, ran-but-parse-error,
 * ran-but-empty-output. Removed in Phase 10e.C when the legacy fields go.
 */
export type DepVulnGatherOutcome =
  | { kind: 'success'; envelope: DepVulnResult }
  | { kind: 'tool-missing' }
  | { kind: 'parse-error' }
  | { kind: 'no-output' };

/**
 * Internal outcome shape for the lint capability bridge in Phase 10e.B.2.
 * Lint has simpler semantics than depVulns: either the linter ran and we
 * have tier counts, or it didn't and we have a reason. The reason becomes
 * the parenthetical in `toolsUnavailable` strings ('eslint (not installed)',
 * 'ruff (parse error)', etc.) so legacy gatherMetrics text stays unchanged.
 */
export type LintGatherOutcome =
  | { kind: 'success'; envelope: LintResult }
  | { kind: 'unavailable'; reason: string };
