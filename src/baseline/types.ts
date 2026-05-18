/**
 * Baseline types — per-finding fingerprints carried in
 * `.dxkit-baseline.json` so the guardrail check can compare today's
 * scan against the recorded baseline.
 *
 * # Identity model
 *
 * dxkit does not treat a single hash as "the finding's stable
 * identity." Each finding has up to several fingerprint axes,
 * differentiated by what they capture:
 *
 *   - **Location fingerprint** — `(canonicalRule, file, lineWindow)`
 *     for code/secret/config/hygiene findings. Locates a finding
 *     in the source tree with ±2 line drift tolerance via bucket
 *     windowing. Stable across small reformat / whitespace edits;
 *     drifts on bigger shifts (closed by git-aware match).
 *   - **Domain fingerprint** — `(package, version, advisoryId)` for
 *     dep-vulns; `(package, version, licenseType)` for licenses;
 *     normalized block hash for jscpd. Captures *what the finding
 *     is about* independent of source position. Drift-immune.
 *   - **Semantic fingerprint** — `(file, symbol)` for coverage gaps
 *     when a symbol is known. Survives any vertical drift within
 *     the symbol body.
 *   - **Content fingerprint** — Sprint 0.x. Normalized snippet
 *     hash; fallback when git history is unreachable.
 *
 * The hash format is identical across axes — 16-char lowercase hex
 * (SHA-1[0:16]). Callers don't need to know which axis a hash came
 * from to use it for set-diff, but the matcher uses the axis
 * structure to layer different match strategies (domain first,
 * then git-aware location, then content fallback, then exact).
 *
 * The identity space mirrors the analyzer shapes that produce
 * findings. Each `IdentityInput` discriminant maps 1:1 to an existing
 * gather pipeline:
 *
 *   - `secret` / `code` / `config` — security analyzer's
 *     `SecurityFinding` (gitleaks, semgrep, TLS-bypass registry,
 *     private-key files, env-in-git).
 *   - `dep-vuln` — security analyzer's `DepVulnFinding` (osv-scanner,
 *     npm-audit, pip-audit, cargo-audit, etc.).
 *   - `duplication` — quality analyzer's `CloneGroup` (jscpd).
 *   - `coverage-gap` — coverage-gap report entries (file + symbol
 *     when available, fallback to file + line range).
 *   - `test-gap` — non-test source files flagged by the test-gaps
 *     analyzer.
 *   - `hygiene` — TODO / FIXME / HACK / console-log / any-type
 *     occurrences (per-occurrence identity).
 *   - `license` — package license attributions.
 */

/**
 * 16-char lowercase hex fingerprint. Same byte format as the
 * `fingerprint` field stamped on `DepVulnFinding` and `CodeFinding`,
 * so a baseline fingerprint compares directly to a fresh finding's
 * stamped value without re-hashing.
 *
 * Whether this represents a location, domain, semantic, or content
 * fingerprint depends on the finding kind — see the file header for
 * the axis model. For line-anchored kinds this is the location
 * fingerprint; for content-based kinds it IS the domain fingerprint.
 */
export type FindingId = string;

/**
 * Identity-scheme version. Bumping this minor field will be required
 * if the hashing inputs change in a way that would invalidate stored
 * baselines. v1 is the only scheme today.
 */
export type IdentitySchemeVersion = 'v1';

/**
 * Discriminated union of every finding kind that participates in
 * identity. Producers wrap their per-tool finding shape into one of
 * these before calling `identityFor`.
 *
 * Adding a new finding kind to the dispatch is a three-line change:
 *   1. Add the per-kind interface below.
 *   2. Append the interface name to this union.
 *   3. Add the corresponding case branch in `identityFor`.
 *
 * The hash format is SHA-1[0:16] across every kind — callers store
 * identities in one flat set without tracking provenance.
 */
export type IdentityInput =
  | SecretIdentityInput
  | CodeIdentityInput
  | ConfigIdentityInput
  | DepVulnIdentityInput
  | DuplicationIdentityInput
  | CoverageGapIdentityInput
  | TestGapIdentityInput
  | HygieneOffenderIdentityInput
  | LicenseIdentityInput
  | TestFileDegradationIdentityInput
  | GodFileIdentityInput
  | StaleFileIdentityInput
  | LargeFileIdentityInput;

/** gitleaks + private-key files + similar secret detectors. */
export interface SecretIdentityInput {
  readonly kind: 'secret';
  /** Producer tool name as reported by the analyzer (e.g. 'gitleaks'). */
  readonly tool: string;
  /** Producer-specific rule id. The canonical-rule map collapses
   *  cross-tool overlaps where they exist. */
  readonly rule: string;
  /** Project-relative file path. */
  readonly file: string;
  /** 1-based line number. Bucketed to absorb small drift between
   *  tool versions; see `CODE_FINGERPRINT_LINE_WINDOW`. */
  readonly line: number;
}

/** semgrep + TLS-bypass registry + per-language code-pattern providers. */
export interface CodeIdentityInput {
  readonly kind: 'code';
  readonly tool: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

/** Configuration-class findings (e.g. .env tracked in git). */
export interface ConfigIdentityInput {
  readonly kind: 'config';
  readonly tool: string;
  readonly rule: string;
  readonly file: string;
  /** Line 0 acceptable for whole-file findings. */
  readonly line: number;
}

/** Dependency-advisory findings (osv-scanner / npm-audit / pip-audit / ...). */
export interface DepVulnIdentityInput {
  readonly kind: 'dep-vuln';
  /** Package name as reported by the producer. */
  readonly package: string;
  /** Installed version string, when known. Absent for findings produced
   *  without an accessible lockfile. */
  readonly installedVersion: string | undefined;
  /** Advisory id (GHSA / CVE / RUSTSEC / etc.). Producer-canonical. */
  readonly id: string;
}

/** jscpd-style duplicate-block findings. */
export interface DuplicationIdentityInput {
  readonly kind: 'duplication';
  /** Files on each side of the duplicate pair. Order is normalized
   *  inside `identityFor` so swapped sides hash identically. */
  readonly fileA: string;
  readonly fileB: string;
  /** Token count of the duplicated block. Stable across pure file
   *  movement but changes when the block itself is refactored. */
  readonly tokens: number;
}

/**
 * Coverage-gap findings — uncovered code surfaces. Identity prefers
 * `(file, symbol)` when the gap-detection pipeline has a symbol name
 * available (graphify-symbols), falling back to `(file, lineRange)`
 * otherwise.
 */
export interface CoverageGapIdentityInput {
  readonly kind: 'coverage-gap';
  readonly file: string;
  /** Function / method / class symbol. Present when the gap is
   *  attributable to a named symbol; absent for line-range-only
   *  attribution. */
  readonly symbol?: string;
  /** Inclusive `[startLine, endLine]`. Required when `symbol` is
   *  absent. */
  readonly lineRange?: readonly [number, number];
}

/**
 * Test-gap source file — a non-test file flagged by the test-gaps
 * analyzer as lacking a matching test. Identity carries the risk
 * tier: a file moving from MEDIUM gap to CRITICAL gap deserves to
 * register as a fresh added finding (the previous lower-tier
 * identity disappears, a new higher-tier identity arrives), which is
 * the right guardrail signal for "this file's testing situation
 * regressed."
 */
export type TestGapRisk = 'critical' | 'high' | 'medium' | 'low';

export interface TestGapIdentityInput {
  readonly kind: 'test-gap';
  readonly file: string;
  readonly risk: TestGapRisk;
}

/**
 * Hygiene marker — one TODO / FIXME / HACK / console-log / any-type
 * occurrence. Identity is per-occurrence so guardrails can fire on
 * "a new TODO was added" rather than just "the TODO count went up."
 * Line numbers are bucketed via the same line-window mechanism used
 * by code-finding fingerprints, so small drift from formatter runs
 * or unrelated edits doesn't churn identity.
 */
export type HygieneMarker = 'todo' | 'fixme' | 'hack' | 'console-log' | 'any-type';

export interface HygieneOffenderIdentityInput {
  readonly kind: 'hygiene';
  readonly file: string;
  readonly line: number;
  readonly marker: HygieneMarker;
}

/**
 * Package license attribution. Identity includes the license type so
 * a license change on the same `(package, version)` pin registers
 * as a fresh finding — compliance teams want to know if a dependency
 * re-licenses under a different (perhaps more restrictive) license
 * even when no version bump happened.
 */
export interface LicenseIdentityInput {
  readonly kind: 'license';
  readonly package: string;
  readonly version: string;
  /** Canonical SPDX identifier (`'MIT'`, `'Apache-2.0'`, `'GPL-3.0'`,
   *  `'UNKNOWN'`). Producer is the existing license-aggregation
   *  pipeline; identity is byte-stable as long as the producer
   *  reports the SPDX id consistently. */
  readonly licenseType: string;
}

/**
 * A test file flagged by the test-gaps analyzer as degraded — present
 * but not actively exercising the system under test. Identity carries
 * the degradation status because a file moving between states (an
 * empty stub becoming a schema-only test, or a commented-out test
 * being uncommented into an empty body) is a real change worth a
 * fresh guardrail signal.
 */
export type TestFileDegradationStatus = 'commented-out' | 'empty' | 'schema-only';

export interface TestFileDegradationIdentityInput {
  readonly kind: 'test-file-degradation';
  readonly file: string;
  readonly status: TestFileDegradationStatus;
}

/**
 * A source file flagged by the quality analyzer's complexity signals
 * as a "god file" — a top offender for function count, function
 * length, or graphify-derived complexity. Identity is per-file: the
 * fact that this file IS a top offender is the durable signal. When
 * a different file becomes the top offender, identity changes
 * appropriately.
 */
export interface GodFileIdentityInput {
  readonly kind: 'god-file';
  readonly file: string;
}

/**
 * A stale on-disk artifact tracked in git — `.swp`, `.bak`, `.orig`,
 * `.tmp`, and similar editor / merge / backup leftovers. Identity
 * pairs the path with the offending suffix so a file moved between
 * directories registers as a fresh finding (the move ought to be
 * noticed) but a single file's identity stays stable across runs.
 */
export interface StaleFileIdentityInput {
  readonly kind: 'stale-file';
  readonly file: string;
  /** Lower-case suffix without the leading dot (`'swp'`, `'bak'`,
   *  `'orig'`, `'tmp'`). The producer derives this from the file
   *  extension; storing it in identity makes the reason for the
   *  flag inspectable from the baseline alone. */
  readonly suffix: string;
}

/**
 * A source file flagged by the health analyzer as over the
 * largest-file threshold (today: 500 lines). Identity is per-file —
 * the fact that this specific file crossed the threshold is the
 * durable signal. Crossing back under the threshold removes the
 * identity; crossing back over re-adds it.
 *
 * Note: aggregate "the largest file grew by N lines" reporting is a
 * separate concern handled by `--fail-on-largest-file-size`; this
 * identity tracks the discrete "X is now too large" finding.
 */
export interface LargeFileIdentityInput {
  readonly kind: 'large-file';
  readonly file: string;
}

/**
 * Per-finding entry stored in a baseline. Carries identity plus the
 * minimum metadata needed for cross-run drift-tolerant matching —
 * never raw payloads (no titles, no secret content, no source
 * excerpts). Sufficient for set-diff and for future drift heuristics
 * (e.g. matching `(rule, file)` pairs across line shifts).
 */
export type BaselineEntry =
  | {
      id: FindingId;
      kind: 'secret' | 'code' | 'config';
      tool: string;
      rule: string;
      file: string;
      line: number;
    }
  | {
      id: FindingId;
      kind: 'dep-vuln';
      package: string;
      installedVersion?: string;
      advisoryId: string;
    }
  | { id: FindingId; kind: 'duplication'; fileA: string; fileB: string; tokens: number }
  | {
      id: FindingId;
      kind: 'coverage-gap';
      file: string;
      symbol?: string;
      lineRange?: readonly [number, number];
    }
  | { id: FindingId; kind: 'test-gap'; file: string; risk: TestGapRisk }
  | { id: FindingId; kind: 'hygiene'; file: string; line: number; marker: HygieneMarker }
  | { id: FindingId; kind: 'license'; package: string; version: string; licenseType: string }
  | {
      id: FindingId;
      kind: 'test-file-degradation';
      file: string;
      status: TestFileDegradationStatus;
    }
  | { id: FindingId; kind: 'god-file'; file: string }
  | { id: FindingId; kind: 'stale-file'; file: string; suffix: string }
  | { id: FindingId; kind: 'large-file'; file: string };

/**
 * One pairing decision from the matcher. Carries enough context for
 * the guardrail to render a clear explanation ("this finding was
 * relocated from line 42 to line 57 via git diff, 0.95 confidence,
 * status: relocated") rather than a bare added/removed/persisted
 * label. Reasons are short codes plus human prose; consumers display
 * the prose and use the codes for filtering / policy decisions.
 *
 * `priorId` and `currentId` are both optional because:
 *   - `added`   → only `currentId` is present.
 *   - `removed` → only `priorId` is present.
 *   - `persisted` / `relocated` → both, and they may differ when a
 *      location fingerprint shifted across the line-window boundary
 *      (each "side" has its own hash even though they describe the
 *      same finding).
 */
export type MatchStatus = 'persisted' | 'relocated' | 'added' | 'removed';

export interface MatchReason {
  /** Short code: 'exact-id', 'git-line-exact', 'git-line-fuzz',
   *  'git-rename', 'multiset-occurrence'. */
  readonly code: string;
  /** Human-readable explanation suitable for end-user rendering. */
  readonly detail: string;
}

export interface MatchPair {
  readonly priorId?: FindingId;
  readonly currentId?: FindingId;
  readonly status: MatchStatus;
  /** Confidence in [0, 1]. 1.0 = exact identity; <1.0 = paired via
   *  a fallback layer (git relocation, line-fuzz, rename). */
  readonly confidence: number;
  readonly reasons: ReadonlyArray<MatchReason>;
}

/**
 * Composite result of comparing two runs.
 *
 * The structured `pairs` field carries one entry per matched +
 * unmatched finding occurrence (multiset-aware: an identity that
 * occurs twice in prior and once in current produces three pairs —
 * one persisted, one removed).
 *
 * `persisted` / `added` / `removed` are flat-array views over the
 * pair set, retained for callers that want simple set-diff output
 * without the reason metadata. Identity values appear once per
 * occurrence (multiset, not set) — duplicate identities are NOT
 * collapsed.
 *
 * `gitAware` reports whether the git-aware location pass actually
 * ran. `degradedReason` carries a human-readable note when the
 * pass was skipped (no git, base SHA unreachable, etc.) so the
 * guardrail CLI can tell the user what mode it ran in.
 */
export interface MatchResult {
  readonly pairs: ReadonlyArray<MatchPair>;
  readonly persisted: ReadonlyArray<FindingId>;
  readonly added: ReadonlyArray<FindingId>;
  readonly removed: ReadonlyArray<FindingId>;
  readonly gitAware: boolean;
  readonly degradedReason?: string;
}
