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
 * - **Location fingerprint** — `(canonicalRule, file, lineWindow)`
 * for code/secret/config/hygiene findings. Locates a finding
 * in the source tree with ±2 line drift tolerance via bucket
 * windowing. Stable across small reformat / whitespace edits;
 * drifts on bigger shifts (closed by git-aware match).
 * - **Domain fingerprint** — `(package, version, advisoryId)` for
 * dep-vulns; `(package, version, licenseType)` for licenses;
 * normalized block hash for jscpd. Captures *what the finding
 * is about* independent of source position. Drift-immune.
 * - **Semantic fingerprint** — `(file, symbol)` for coverage gaps
 * when a symbol is known. Survives any vertical drift within
 * the symbol body.
 * - **Content fingerprint** — Sprint 0.x. Normalized snippet
 * hash; fallback when git history is unreachable.
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
 * - `secret` / `code` / `config` — security analyzer's
 * `SecurityFinding` (gitleaks, semgrep, TLS-bypass registry,
 * private-key files, env-in-git).
 * - `dep-vuln` — security analyzer's `DepVulnFinding` (osv-scanner,
 * npm-audit, pip-audit, cargo-audit, etc.).
 * - `duplication` — quality analyzer's `CloneGroup` (jscpd).
 * - `coverage-gap` — coverage-gap report entries (file + symbol
 * when available, fallback to file + line range).
 * - `test-gap` — non-test source files flagged by the test-gaps
 * analyzer.
 * - `hygiene` — TODO / FIXME / HACK / console-log / any-type
 * occurrences (per-occurrence identity).
 *
 * License attributions are NOT a baseline finding kind. They live in
 * the per-package BoM artifact (`.dxkit/bom.json`) — the canonical
 * license inventory carried by `vyuh-dxkit bom`. License findings
 * are informational, not regression material, and dominated the
 * baseline (~73% of entries on real customer repos) before being
 * lifted out.
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
 * Identity-scheme version. Bumped whenever the hashing inputs change in a
 * way that would invalidate stored baselines / allowlists.
 *
 *   - `v1` — the pre-2.11 scheme: code/secret/config hashed
 *     `(canonicalRule, file, lineWindow)`; dep-vuln hashed
 *     `(package, installedVersion, id)`.
 *   - `v2` (current) — content-anchored: code = `(scope, spanHash,
 *     ordinal)`, secret = salted HMAC, config = `(rule, file)`, all with
 *     a line-window fallback; dep-vuln = `(package, canonicalAdvisoryId)`.
 *
 * `identityFor` can compute EITHER scheme (every shipped scheme's id
 * function is retained — see `computeFingerprintV1`), which is what lets
 * the identity migrator build an `old → new` remap and carry allowlist
 * entries across an upgrade. The version is stamped on the baseline +
 * allowlist files so a later dxkit can detect the gap and migrate.
 *
 * Adding a future `v3`: extend this union, add its branch in
 * `identityFor`, retain the prior scheme's id function, and the migrator
 * + `update` handle the rest with no further wiring.
 */
export type IdentitySchemeVersion = 'v1' | 'v2';

/** The scheme `identityFor` mints new identities under by default, and the
 *  version stamped on freshly written baseline / allowlist files. */
export const CURRENT_IDENTITY_SCHEME: IdentitySchemeVersion = 'v2';

/**
 * Discriminated union of every finding kind that participates in
 * identity. Producers wrap their per-tool finding shape into one of
 * these before calling `identityFor`.
 *
 * Adding a new finding kind to the dispatch is a three-line change:
 * 1. Add the per-kind interface below.
 * 2. Append the interface name to this union.
 * 3. Add the corresponding case branch in `identityFor`.
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
  | TestFileDegradationIdentityInput
  | GodFileIdentityInput
  | StaleFileIdentityInput
  | LargeFileIdentityInput
  | SecretHmacIdentityInput
  | StaleAllowIdentityInput
  | FlowBindingIdentityInput
  | ModelSchemaDriftIdentityInput
  | CustomCheckIdentityInput;

/**
 * Content anchor for the secret/code/config identity schemes.
 * Derived from WHAT a finding is, not WHERE it sits, so identity
 * survives the finding moving lines:
 * - secret → salted HMAC of the value (`computeSecretHmac`).
 * - code → `codeContentAnchor(scope, span, ordinal)` — enclosing
 * symbol + normalized-span hash + in-scope ordinal.
 * - config → `''` (identity is just `(canonicalRule, file)`; a config
 * finding is inherently line-independent).
 *
 * Optional: when absent, `identityFor` falls back to the legacy
 * line-window hash; when present, the dispatch prefers this anchor and
 * `line` becomes display metadata only.
 */
export type ContentAnchor = string;

/** gitleaks + private-key files + similar secret detectors. */
export interface SecretIdentityInput {
  readonly kind: 'secret';
  /** Producer tool name as reported by the analyzer (e.g. 'gitleaks'). */
  readonly tool: string;
  /** Producer-specific rule id. The canonical-rule map collapses
   * cross-tool overlaps where they exist. */
  readonly rule: string;
  /** Project-relative file path. */
  readonly file: string;
  /** 1-based line number. Bucketed to absorb small drift between
   * tool versions; see `CODE_FINGERPRINT_LINE_WINDOW`. Display metadata
   * once `contentAnchor` is present. */
  readonly line: number;
  /** Salted HMAC of the secret value (Content anchor). Present when
   * the gather could derive a salt; absent → line-based fallback. */
  readonly contentAnchor?: ContentAnchor;
}

/** semgrep + TLS-bypass registry + per-language code-pattern providers. */
export interface CodeIdentityInput {
  readonly kind: 'code';
  readonly tool: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  /** `codeContentAnchor(scope, span, ordinal)`. Present when the
   * aggregator could resolve a span/scope; absent → line-based fallback. */
  readonly contentAnchor?: ContentAnchor;
}

/** Configuration-class findings (e.g. .env tracked in git). */
export interface ConfigIdentityInput {
  readonly kind: 'config';
  readonly tool: string;
  readonly rule: string;
  readonly file: string;
  /** Line 0 acceptable for whole-file findings. */
  readonly line: number;
  /** `''` for config (identity is `(canonicalRule, file)`). Carried for
   * uniformity with the other code-side inputs. */
  readonly contentAnchor?: ContentAnchor;
}

/** Dependency-advisory findings (osv-scanner / npm-audit / pip-audit / ...). */
export interface DepVulnIdentityInput {
  readonly kind: 'dep-vuln';
  /** Package name as reported by the producer. */
  readonly package: string;
  /** Installed version string, when known. Absent for findings produced
   * without an accessible lockfile. Display metadata only — NOT part of
   * the fingerprint (it's environment-dependent; see
   * `computeFingerprint`). */
  readonly installedVersion: string | undefined;
  /** Advisory id (GHSA / CVE / RUSTSEC / etc.). Producer-canonical. */
  readonly id: string;
  /** Cross-namespace aliases (CVE / GHSA / OSV / SNYK …) the producer
   * surfaced. Used to canonicalize identity so the same advisory found
   * by different scanners shares one fingerprint. */
  readonly aliases?: readonly string[];
}

/** jscpd-style duplicate-block findings. */
export interface DuplicationIdentityInput {
  readonly kind: 'duplication';
  /** Files on each side of the duplicate pair. Order is normalized
   * inside `identityFor` so swapped sides hash identically. */
  readonly fileA: string;
  readonly fileB: string;
  /** Line count of the duplicated block. `lines` is preferred over
   * the `tokens` field jscpd also reports because jscpd's JSON
   * reporter does not populate `tokens` in practice — it's always
   * 0, which would degenerate the identity tuple and silently lose
   * the "block-size changes → identity changes" property. */
  readonly lines: number;
  /** Start line of the block on side A. Combined with `startLineB`
   * this distinguishes intra-file clones at different positions
   * (same `fileA === fileB`, different line ranges) which would
   * otherwise collapse to one identity. */
  readonly startLineA: number;
  /** Start line of the block on side B. */
  readonly startLineB: number;
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
   * attributable to a named symbol; absent for line-range-only
   * attribution. */
  readonly symbol?: string;
  /** Inclusive `[startLine, endLine]`. Required when `symbol` is
   * absent. */
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
   * `'orig'`, `'tmp'`). The producer derives this from the file
   * extension; storing it in identity makes the reason for the
   * flag inspectable from the baseline alone. */
  readonly suffix: string;
}

/**
 * A source file flagged by the health analyzer as over the
 * large-file threshold (default 500 lines; configurable via
 * `policy.json:largeFileThreshold`). Identity is per-file —
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
 * Content-based identity for a detected secret. Companion to the
 * location-based `SecretIdentityInput` — both can describe the same
 * underlying finding, with the location identity locating WHERE the
 * secret lives and the HMAC identity locating WHAT secret it is.
 *
 * The producer (gitleaks provider in Phase 3) computes the HMAC via
 * `computeSecretHmac(secretValue, repoSalt)`. The salt lives in
 * `.dxkit/salt` per repo, generated once and gitignored — see the
 * baseline-create command for the salt-management contract.
 *
 * Identity-relocation use case: when a leaked token is copied from
 * `.env` to `src/config.ts`, the location identities differ but the
 * HMAC identities match. The matcher recognizes the move via HMAC
 * and reports the pair as relocated rather than added+removed.
 *
 * Producer never stores the raw secret. Only the HMAC enters the
 * baseline file, so a baseline leak doesn't leak secrets.
 */
export interface SecretHmacIdentityInput {
  readonly kind: 'secret-hmac';
  /** Producer tool name (e.g. 'gitleaks'). */
  readonly tool: string;
  /** Producer-specific rule id. The canonical-rule map applies here
   * too: two tools detecting the same secret class collapse to one
   * canonical rule. */
  readonly rule: string;
  /** 16-char hex from `computeSecretHmac(secret, repoSalt)`. */
  readonly hmac: string;
}

/**
 * Orphaned inline allowlist annotation — a `dxkit-allow:<category>`
 * comment in a source file that matches no current finding. The
 * developer suppressed something that's since been fixed (or the
 * scanner stopped flagging), and the annotation should be removed.
 * TypeScript's `@ts-expect-error` proved this pattern: tools that
 * surface their own stale suppressions as findings force the dev
 * to clean up, preventing the annotation graveyard.
 *
 * Identity is `(file, lineWindow, category)` — same 3-line window
 * the code-finding fingerprint uses, so formatter / unrelated-edit
 * line drift doesn't churn identity. Category is part of identity
 * because a `# dxkit-allow:test-fixture` becoming
 * `# dxkit-allow:false-positive` (developer reclassified mid-review)
 * is a semantically different stale-allow.
 */
export interface StaleAllowIdentityInput {
  readonly kind: 'stale-allow';
  readonly file: string;
  readonly line: number;
  /** The category named in the orphaned annotation. Free-form
   * string at identity-input level (the canonical
   * `AllowlistCategory` union lives in `src/allowlist/categories.ts`
   * to avoid a cross-module import here in the baseline types). */
  readonly category: string;
}

/**
 * A flow binding — a UI call site's dependency on a served `(method, path)`,
 * the unit the integration gate grandfathers. Identity is exactly the triple
 * `(method, path, file)`: the NORMALIZED join key (never the raw URL a tool
 * captured) plus the consuming file dxkit read from its own AST pass. It is
 * LINE-INDEPENDENT — the call can move anywhere in the file without re-minting
 * — so a committed baseline keeps matching in CI. Deliberately not the graph's
 * enclosing symbol: the flow layer is graphify-independent. (The line lives on
 * the baseline entry as display metadata, not as an identity input.)
 */
export interface FlowBindingIdentityInput {
  readonly kind: 'flow-binding';
  readonly method: string;
  readonly path: string;
  readonly file: string;
}

/**
 * A schema-drift finding — one detected change to a declared data model, the
 * unit the model-schema drift gate mints and the allowlist waives. Identity
 * is exactly the triple `(model, field, changeClass)` — LOCATION-FREE by
 * design (the dep-vuln doctrine: a model is a contract-domain entity whose
 * name is its address), so the finding survives line and file moves with no
 * matching machinery. `field` is null for model-level classes
 * (`model-removed` / `model-added`). The before/after values and the
 * file/line locator live on the baseline entry as display metadata, never in
 * the hash — a follow-up commit adjusting the same field cannot dodge an
 * allowlist decision.
 */
export interface ModelSchemaDriftIdentityInput {
  readonly kind: 'model-schema-drift';
  /** The model's declared name (dxkit's own AST/spec read, normalized). */
  readonly model: string;
  /** Field name, or null for a model-level change class. */
  readonly field: string | null;
  /** One of the fixed drift-taxonomy classes (`field-removed`, …). */
  readonly changeClass: string;
}

/**
 * A failure emitted by a user-declared custom check (`.dxkit/policy.json:checks`)
 * or a pack-declared built-in check (lint). The check runner turns a check's
 * output into zero or more of these — either ONE binary finding (the command
 * exited non-zero and produced no per-location parse: `file`/`line`/`rule` are
 * absent, identity is just the check name) or one finding PER parsed location (a
 * linter's `file:line: rule` diagnostic).
 *
 * Identity is dxkit-derived + tool-independent (Rule 9): the check `name` (a
 * repo-stable label the user/pack chose, not a captured tool string), the source
 * `file`, a 3-line window of `line`, and the intrinsic `rule` id the parser
 * extracted. It never hashes the raw output text — that varies run to run
 * (timestamps, ordering) and across environments. The located variant is
 * line-window-bucketed (like `hygiene` / `stale-allow`), so it carries a full
 * `(file, line, rule)` locator downstream; the binary variant is
 * line-INDEPENDENT (identity = the check name), so it is locator-less.
 */
export interface CustomCheckIdentityInput {
  readonly kind: 'custom-check';
  /** Stable check label (`lint:typescript`, a user check's `name`). Never a
   *  captured tool string — this is the durable cross-run/-environment key. */
  readonly check: string;
  /** Source file for a parsed per-location finding; absent for a binary
   *  (whole-command) failure. */
  readonly file?: string;
  /** Line for a parsed per-location finding (bucketed into the shared 3-line
   *  window at hash time); absent for a binary failure. */
  readonly line?: number;
  /** Intrinsic rule/diagnostic id the parser extracted (e.g. `no-unused-vars`);
   *  absent for a binary failure or an unparsed line. */
  readonly rule?: string;
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
      /** 16-char hex hash of normalized context around `line` at
       * baseline-create time. Stamped via `computeContentHashFromCommit`;
       * the matcher's third pass uses it as a fallback when git-aware
       * location matching fails (shallow clones, force-pushed base,
       * context survives but line shifts past the fuzz window). Absent
       * when the producer couldn't read the file. */
      contentHash?: string;
      /** Fingerprints of cross-tool / neighbor-bucket / CWE-bridge
       * findings that the aggregator collapsed into this one. Carried
       * so an allowlist entry keyed on a contributing fingerprint still
       * suppresses the merged finding — robust matching against dedup
       * nondeterminism between runs. Present only when such a merge
       * fired. */
      absorbedFingerprints?: readonly string[];
    }
  | {
      id: FindingId;
      kind: 'dep-vuln';
      package: string;
      installedVersion?: string;
      advisoryId: string;
    }
  | {
      id: FindingId;
      kind: 'duplication';
      fileA: string;
      fileB: string;
      lines: number;
      startLineA: number;
      startLineB: number;
      /** 16-char hex hash of the normalized block content at the canonical
       * representative side, stamped at baseline-create time. Lets the
       * matcher's content-hash pass relocate the clone WITHOUT git (shallow
       * clones, force-pushed baselines) — the git-line pass needs reachable
       * history, this does not. Absent when the producer couldn't read the
       * file. Same role as the secret/code/hygiene `contentHash`. */
      contentHash?: string;
    }
  | {
      id: FindingId;
      kind: 'coverage-gap';
      file: string;
      symbol?: string;
      lineRange?: readonly [number, number];
    }
  | { id: FindingId; kind: 'test-gap'; file: string; risk: TestGapRisk }
  | {
      id: FindingId;
      kind: 'hygiene';
      file: string;
      line: number;
      marker: HygieneMarker;
      /** Same content-hash semantics as the secret/code/config variant
       * — populated when the producer can read the file at the
       * baseline commit. */
      contentHash?: string;
    }
  | {
      id: FindingId;
      kind: 'test-file-degradation';
      file: string;
      status: TestFileDegradationStatus;
    }
  | { id: FindingId; kind: 'god-file'; file: string }
  | { id: FindingId; kind: 'stale-file'; file: string; suffix: string }
  | { id: FindingId; kind: 'large-file'; file: string }
  | { id: FindingId; kind: 'secret-hmac'; tool: string; rule: string; hmac: string }
  | {
      id: FindingId;
      kind: 'flow-binding';
      /** Normalized HTTP method + path — the canonical join key. Together with
       * `file` these are the only identity inputs (Rule 9): all three are
       * stored so identity is recomputable from the entry alone. */
      method: string;
      path: string;
      /** Consuming file (the UI module that holds the call). */
      file: string;
      /** Representative call-site line — display metadata only (not hashed;
       * identity is line-independent), so `show` / hints can point a human at
       * the source. */
      line: number;
    }
  | {
      id: FindingId;
      kind: 'model-schema-drift';
      /** The identity triple — all three stored so identity is recomputable
       * from the entry alone (the migration contract). */
      model: string;
      field: string | null;
      changeClass: string;
      /** Normalized before/after facts — display metadata, never hashed
       * (identity must survive a follow-up tweak to the same field). */
      from: string | null;
      to: string | null;
      /** Head-side locator (base-side for removals) — display metadata;
       * identity is location-free by design. */
      file: string;
      line: number;
    }
  | {
      id: FindingId;
      kind: 'stale-allow';
      file: string;
      line: number;
      category: string;
      /** Content-hash of the annotation's surrounding context, so the matcher
       * relocates it without git when a >window line shift re-mints the
       * line-bucketed identity. Same role as the secret/code/hygiene field;
       * absent when the file can't be read. */
      contentHash?: string;
    }
  | {
      id: FindingId;
      kind: 'custom-check';
      /** The check's stable label — the durable identity key (Rule 9). */
      check: string;
      /** Whether a NET-NEW occurrence of this finding blocks (the check declared
       * `blocking: true`) or only warns. Carried on the entry, not derived from
       * severity/status, because block intent is user/pack-declared per check —
       * the guardrail reads it to fold a non-blocking net-new finding down to a
       * warn (see check.ts). Not an identity input. */
      blocking: boolean;
      /** Source file for a parsed per-location finding; absent for a binary
       * (whole-command) failure. Present ⟹ line-sensitive identity ⟹ full
       * `(file, line, rule)` locator (the relocation invariant). */
      file?: string;
      /** Line for a parsed per-location finding; absent for a binary failure. */
      line?: number;
      /** Parser-extracted rule/diagnostic id; absent for a binary failure. */
      rule?: string;
      /** Human-facing message (the linter's message text, or the captured
       * output tail for a binary failure). Display metadata only — NOT hashed
       * (it is tool-captured text; Rule 9 forbids it from identity). */
      message?: string;
    }
  | SanitizedBaselineEntry;

/**
 * The full-payload subset of `BaselineEntry` — every variant except
 * the stripped sanitized shape. Producers emit this shape directly;
 * sanitization is a write-time transformation, never a producer
 * concern. Consumers narrowing on `entry.kind` from a `BaselineEntry`
 * must call `isSanitized` first to reach this shape (or accept the
 * sanitized variant in the union).
 */
export type RichBaselineEntry = Exclude<BaselineEntry, SanitizedBaselineEntry>;

/**
 * Stripped per-finding entry — identity + kind only, every other
 * field dropped. Produced by `sanitizeEntry` for baselines written in
 * sanitized mode (the public-repo / compliance-conscious posture).
 *
 * Sanitization preserves the cross-run matching contract: the
 * fingerprint `id` is unchanged, the matcher's identity-multiset
 * pass still works at full confidence. What's lost is the location-
 * pair pass (no `file` / `line` to compare) and the renderer's
 * ability to surface human-readable locators (`src/auth/oauth.ts:42`)
 * — they collapse to `<sanitized>` in `baseline show` output.
 *
 * The `sanitized: true` discriminant lets exhaustive switches narrow
 * to either the rich shape or the stripped shape via the
 * `isSanitized` guard in `./sanitize.ts`. Adding a new finding kind
 * doesn't require touching this variant — `kind` is the union of all
 * non-sanitized kinds, propagated automatically.
 */
export interface SanitizedBaselineEntry {
  readonly id: FindingId;
  readonly kind:
    | 'secret'
    | 'code'
    | 'config'
    | 'dep-vuln'
    | 'duplication'
    | 'coverage-gap'
    | 'test-gap'
    | 'hygiene'
    | 'test-file-degradation'
    | 'god-file'
    | 'stale-file'
    | 'large-file'
    | 'secret-hmac'
    | 'stale-allow'
    | 'flow-binding'
    | 'model-schema-drift'
    | 'custom-check';
  readonly sanitized: true;
}

/**
 * One pairing decision from the matcher. Carries enough context for
 * the guardrail to render a clear explanation ("this finding was
 * relocated from line 42 to line 57 via git diff, 0.95 confidence,
 * status: relocated") rather than a bare added/removed/persisted
 * label. Reasons are short codes plus human prose; consumers display
 * the prose and use the codes for filtering / policy decisions.
 *
 * `priorId` and `currentId` are both optional because:
 * - `added` → only `currentId` is present.
 * - `removed` → only `priorId` is present.
 * - `persisted` / `relocated` → both, and they may differ when a
 * location fingerprint shifted across the line-window boundary
 * (each "side" has its own hash even though they describe the
 * same finding).
 */
export type MatchStatus = 'persisted' | 'relocated' | 'added' | 'removed';

export interface MatchReason {
  /** Short code: 'exact-id', 'git-line-exact', 'git-line-fuzz',
   * 'git-rename', 'multiset-occurrence'. */
  readonly code: string;
  /** Human-readable explanation suitable for end-user rendering. */
  readonly detail: string;
}

export interface MatchPair {
  readonly priorId?: FindingId;
  readonly currentId?: FindingId;
  readonly status: MatchStatus;
  /** Confidence in [0, 1]. 1.0 = exact identity; <1.0 = paired via
   * a fallback layer (git relocation, line-fuzz, rename). */
  readonly confidence: number;
  readonly reasons: ReadonlyArray<MatchReason>;
}

/**
 * Severity tier carried alongside each match pair for policy
 * classification. Mirrors the global severity vocabulary used by the
 * security analyzer and dimension scoring.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Full taxonomy of post-classification status values a guardrail
 * check can emit. Wider than `MatchStatus` because policy adds context
 * the matcher doesn't have:
 *
 * - `persisted` / `relocated` / `added` / `removed` — direct
 * pass-through of the matcher's pair status.
 * - `fixed` — a `removed` finding that the policy treats as a
 * positive event (resolution rather than disappearance). Today
 * this is informational only; Phase 3 distinguishes the two when
 * `--detailed` flags it.
 * - `newly_detected` — current-only finding that surfaced because
 * the scanner / ruleset / advisory DB / policy config changed,
 * not because a developer introduced new code. Parent category;
 * `tooling_drift` and `config_drift` are the specific subtypes.
 * - `tooling_drift` — scanner or advisory-db version differs
 * between baseline and current. Reclassified `added` is suspect.
 * - `config_drift` — `.dxkit-ignore` / policy / suppressions hash
 * differs between runs.
 * - `probable_existing` — current-only with weak evidence it's
 * truly new (a prior near-match exists but didn't pair cleanly).
 * Reserved for the content-hash / semantic fallback layer in
 * Sprint 0.x.
 * - `uncertain` — confidence below the per-severity threshold;
 * the policy can't classify with conviction.
 *
 * The enum is the contract Phase 3's guardrail CLI reads. Today's
 * classifier emits a subset — the remaining states are reserved for
 * the Phase 3 baseline-metadata work that will provide the
 * contextual signals (scanner versions, config hashes, etc.).
 */
export type FindingStatus =
  | 'persisted'
  | 'relocated'
  | 'added'
  | 'removed'
  | 'fixed'
  | 'newly_detected'
  | 'tooling_drift'
  | 'config_drift'
  | 'probable_existing'
  | 'uncertain';

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
