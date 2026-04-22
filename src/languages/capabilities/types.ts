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
 * `ImportsResult` landed in Phase 10e.B.4 — a pack pre-computes the full
 * per-pack import graph (extracted specifiers + resolved edges) for every
 * source file matching its `sourceExtensions`, and the dispatcher unions
 * the per-pack graphs so `buildReachable` can BFS over the unified edge
 * map. Global-gatherer envelopes (`SecretsResult`, `CodePatternsResult`,
 * ...) land in Phase 10e.B.6+.
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
 * Pre-computed import graph for one language pack, the imports capability.
 *
 * Every key in `extracted` and `edges` is a project-relative source file
 * path matching one of `sourceExtensions`. Keys are disjoint across packs
 * (a pack only owns files whose extension it declares), so the descriptor
 * aggregates by plain union.
 *
 * `extracted` carries the raw specifiers captured from each file (e.g.
 * `'./foo'`, `'lodash'`, `'../bar/baz'`). `edges` carries only the
 * specifiers the pack could resolve to an in-project file; external
 * packages and unresolvable specifiers are dropped. `buildReachable`
 * consumes `edges`; future analyses (unused-imports, dead-code) can
 * consume `extracted` without re-parsing source.
 *
 * Packs whose language has no file-based import resolution (Rust uses
 * `mod`/crate paths, C# uses namespaces) still emit a result: `extracted`
 * is populated for completeness and `edges` is empty. The union of an
 * empty edges map is a no-op.
 */
export interface ImportsResult extends CapabilityEnvelope {
  readonly sourceExtensions: ReadonlyArray<string>;
  readonly extracted: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Per-finding detail for the secrets capability. */
export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  severity: keyof SeverityCounts;
  /** Human-readable description from the scanner (e.g. gitleaks' `Description` field). */
  title?: string;
}

/**
 * Hardcoded-secret findings, the secrets capability. Produced by global
 * scanners (gitleaks today, trufflehog-compatible in the future) that
 * run once per repo rather than per language pack. `suppressedCount`
 * is the count of findings the repo's `.dxkit-suppressions.json`
 * acknowledged and dropped — reported separately so the UI can
 * distinguish "zero findings" from "zero visible findings after
 * suppression."
 */
export interface SecretsResult extends CapabilityEnvelope {
  findings: ReadonlyArray<SecretFinding>;
  suppressedCount: number;
}

/** Per-finding detail for the codePatterns capability. */
export interface CodePatternFinding {
  file: string;
  line: number;
  rule: string;
  severity: keyof SeverityCounts;
  /** Human-readable summary from the scanner (first line of semgrep's `message`). */
  title: string;
  /** CWE identifier when the scanner supplies one (e.g. `CWE-79`). Empty otherwise. */
  cwe: string;
}

/**
 * Code-pattern findings, the codePatterns capability. Produced by static
 * analysis scanners (semgrep today) that consume rulesets per active
 * language pack (`LanguageSupport.semgrepRulesets`). Running once per
 * repo rather than per pack: the scanner takes a union of rulesets and
 * emits findings attributed by file path.
 *
 * `suppressedCount` mirrors `SecretsResult` — the count dropped by
 * `.dxkit-suppressions.json` so the UI can report "zero visible after
 * suppression" separately from "zero real findings."
 */
export interface CodePatternsResult extends CapabilityEnvelope {
  findings: ReadonlyArray<CodePatternFinding>;
  suppressedCount: number;
}

/** One side of a duplicate block reported by a clone detector. */
export interface DuplicationCloneSide {
  file: string;
  startLine: number;
  endLine: number;
}

/** A single clone pair (two locations with matching content). */
export interface DuplicationClone {
  lines: number;
  tokens: number;
  a: DuplicationCloneSide;
  b: DuplicationCloneSide;
}

/**
 * Duplication metrics, the duplication capability. Produced by clone
 * detectors (jscpd today) that tokenize every source file and emit
 * pair-wise matches above configured thresholds. `topClones` is
 * bounded (the detector sorts + truncates) so the envelope is safe
 * to keep in reports.
 */
export interface DuplicationResult extends CapabilityEnvelope {
  totalLines: number;
  duplicatedLines: number;
  /** Rounded to 2 decimal places. */
  percentage: number;
  /** Total clone pairs found (may exceed topClones.length after truncation). */
  cloneCount: number;
  /** Largest clone pairs first; typically capped at ~15. */
  topClones: ReadonlyArray<DuplicationClone>;
}

/**
 * Structural metrics, the structural capability. Produced by AST
 * graph-builders (graphify today) that walk every source file via
 * tree-sitter, build a call-graph, detect communities, and derive
 * cohesion / dead-import / orphan signals.
 *
 * Every field is a repo-level scalar produced by one graph pass —
 * summing them across providers would double-count the same real
 * functions/modules, so the descriptor aggregate is last-wins
 * (matches COVERAGE's strategy for the same reason).
 */
export interface StructuralResult extends CapabilityEnvelope {
  functionCount: number;
  classCount: number;
  maxFunctionsInFile: number;
  maxFunctionsFilePath: string;
  godNodeCount: number;
  communityCount: number;
  /** Mean cohesion score across communities, 0-1 range, 3 decimal places. */
  avgCohesion: number;
  orphanModuleCount: number;
  deadImportCount: number;
  /** Share of source files with zero AST nodes — proxy for "mostly-commented" files. */
  commentedCodeRatio: number;
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
