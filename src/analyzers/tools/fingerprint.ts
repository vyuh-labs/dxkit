/**
 * Durable per-finding identity across runs — used by both intra-run dedup
 * (the security aggregator collapses cross-tool overlaps via fingerprint)
 * and cross-run diff tooling (baselines compare today's fingerprint set
 * against yesterday's to surface added / removed / persisted findings).
 *
 * Two fingerprint families live here:
 *
 *   1. Dependency-advisory fingerprints — stable hash of
 *      `(package, canonicalAdvisoryId)`. Used by `gatherDepVulns` +
 *      BoM. Excludes severity / cvssScore / enrichment fields
 *      (epssScore, kev, reachable, riskScore), producer `tool`, and
 *      `upgradeAdvice` / `upgradePlan` so re-scoring the same advisory
 *      against the same install never mints a new identity. Crucially
 *      it also excludes `installedVersion`: that value is only known
 *      when the dependency tree is installed (npm-audit reads
 *      node_modules), so a lockfile-only scanner (osv-scanner, or any
 *      gather in a bare git worktree) omits it — and including it forked
 *      the SAME advisory into two identities depending on the scan
 *      environment. The version is display metadata, not identity:
 *      bumping to a still-vulnerable version is the same finding, and
 *      bumping to a fixed version makes the finding disappear on its own.
 *
 *   2. Code/secret/config-finding fingerprints — stable hash of
 *      `(canonicalRule, file, lineWindow)`. The canonical-rule map
 *      collapses cross-tool overlaps (e.g. semgrep + a per-language
 *      grep-based pattern both reporting the same TLS-bypass
 *      construct). The line-window absorbs the small offset between
 *      tools that report the declaration vs. the assignment.
 *
 * Both families share format: 16-char lowercase hex (first 8 bytes of
 * SHA-1). Short enough to embed inline in reports, long enough to make
 * collisions between non-identical tuples effectively impossible at
 * repo scale. Producers may render either inline interchangeably.
 */

import { createHash, createHmac } from 'crypto';
import type { DepVulnFinding } from '../../languages/capabilities/types';

/**
 * Canonical advisory id for dep-vuln identity. Scanners label the same
 * advisory differently — npm-audit emits an uppercase `GHSA-…`, while
 * osv-scanner may primary an `OSV-…` / `CVE-…` / `GHSA-…` id and carry
 * the rest in `aliases`. Collapse them to one token so the SAME
 * vulnerability fingerprints identically regardless of which tool found
 * it: prefer GHSA (the namespace every supported scanner shares), then
 * CVE (the next-best cross-tool token), else the producer's own id.
 * Lowercased so `GHSA-AB` and `ghsa-ab` don't fork identity.
 */
export function canonicalAdvisoryId(finding: {
  readonly id: string;
  readonly aliases?: readonly string[];
}): string {
  const candidates = [finding.id, ...(finding.aliases ?? [])]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
  const ghsa = candidates.find((c) => /^GHSA-/i.test(c));
  if (ghsa) return ghsa.toLowerCase();
  const cve = candidates.find((c) => /^CVE-/i.test(c));
  if (cve) return cve.toLowerCase();
  return finding.id.toLowerCase();
}

/**
 * Stable 16-char hex fingerprint for one DepVulnFinding. Input tuple is
 * NUL-separated (not present in any legal package name / advisory id) so
 * distinct tuples can never collide via concatenation tricks.
 *
 * Identity is `(package, canonicalAdvisoryId)` — deliberately NOT the
 * installed version (see the module header): the version is unavailable
 * to lockfile-only scanners, so including it forked identity by scan
 * environment.
 */
export function computeFingerprint(finding: {
  readonly package: string;
  readonly id: string;
  readonly aliases?: readonly string[];
}): string {
  const input = `${finding.package}\0${canonicalAdvisoryId(finding)}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Stamp `fingerprint` on every finding in place. Called once in
 * `gatherDepVulns` after cross-pack merge + enrichment so every
 * downstream consumer (bom, security/detailed, JSON export) sees a
 * fully-stamped finding.
 *
 * Idempotent: re-stamping a finding that already has a fingerprint
 * overwrites it with the same value. Safe to call multiple times,
 * though the gather path only invokes it once.
 */
export function stampFingerprints(findings: DepVulnFinding[]): void {
  for (const f of findings) {
    f.fingerprint = computeFingerprint(f);
  }
}

/**
 * Sorted, deduplicated fingerprint list for a set of findings. Used by
 * `analyzeBom` to populate `BomReport.summary.fingerprints` — a single
 * manifest of every advisory identity the report covers, convenient
 * for external diff tooling without walking `entries[].vulns[]`.
 *
 * Silently skips findings missing a fingerprint (should not happen
 * post-gather, but a safety net against a future producer that emits
 * findings outside the `gatherDepVulns` path).
 */
export function collectFingerprints(findings: ReadonlyArray<DepVulnFinding>): string[] {
  const set = new Set<string>();
  for (const f of findings) {
    if (f.fingerprint) set.add(f.fingerprint);
  }
  return [...set].sort();
}

// ─── Code/secret/config-finding fingerprints ─────────────────────────────────

/**
 * Maps raw `(tool, rule)` pairs to a canonical rule id. Two raw
 * findings with the same canonical rule (and same file + line window)
 * fingerprint identically — the aggregator's dedup pipeline collapses
 * them into a single CodeFinding with `producedBy` listing every
 * contributing tool. Adding a new collapse is a one-line addition; no
 * algorithm changes.
 *
 * Unmapped pairs fall through to `raw:${tool}:${rule}` — conservative
 * default. Never accidentally collapses unrelated findings.
 */
export const CANONICAL_RULE_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  // TLS / certificate validation bypass. An ingested engine reports the
  // same insecure-TLS construct under its own rule (Snyk classes it as
  // CWE-327 where the registry grep classes it CWE-295), so the CWE
  // fallback can't bridge them — they're mapped explicitly here.
  ['tls-bypass-registry:tls-validation-disabled', 'canonical:tls-bypass'],
  ['semgrep:bypass-tls-verification', 'canonical:tls-bypass'],
  ['semgrep:nodejsscan.node_tls_reject_unauthorized', 'canonical:tls-bypass'],
  ['snyk-code:javascript/InsecureTLSConfig', 'canonical:tls-bypass'],

  // Code injection / dynamic require of request-derived input. The
  // bundled scanner and an interprocedural engine both reach the same
  // sink under different rule names.
  ['semgrep:require-request', 'canonical:code-injection'],
  ['snyk-code:javascript/CodeInjection', 'canonical:code-injection'],

  // Private-key file on disk — find + gitleaks may both surface
  ['find:private-key-file', 'canonical:private-key-on-disk'],
  ['gitleaks:private-key', 'canonical:private-key-on-disk'],
]);

/** Resolve a raw `(tool, rule)` pair to its canonical rule id. */
export function canonicalRuleFor(tool: string, rule: string): string {
  return CANONICAL_RULE_MAP.get(`${tool}:${rule}`) ?? `raw:${tool}:${rule}`;
}

/**
 * Width of the line-number bucket used by code-finding fingerprints.
 * Tools report the same construct at slightly different lines (one
 * tool on the declaration, another on the assignment). Bucketing
 * absorbs that drift without collapsing unrelated findings on
 * nearby lines.
 */
export const CODE_FINGERPRINT_LINE_WINDOW = 3;

/**
 * Bucket a line number to its canonical line-window value. Findings
 * sharing the same `(canonicalRule, file, lineWindow)` tuple share a
 * fingerprint.
 *
 * Note on boundary cases: the aggregator additionally probes the two
 * neighbor buckets (±lineWindow) to catch adjacent findings that
 * straddle a bucket boundary; that lookup lives in the aggregator
 * because it owns the merge policy, not here.
 */
export function lineWindowFor(line: number): number {
  return Math.floor(line / CODE_FINGERPRINT_LINE_WINDOW) * CODE_FINGERPRINT_LINE_WINDOW;
}

/**
 * Stable 16-char hex hash of `(canonicalRule, file, lineWindow)`.
 * NUL-separated so distinct tuples can't collide via concatenation
 * tricks. Same byte format as `computeFingerprint` so dep-vuln and
 * code-finding fingerprints share a downstream type contract.
 */
export function computeCodeFingerprint(canonicalRule: string, file: string, line: number): string {
  const input = `${canonicalRule}\0${file}\0${lineWindowFor(line)}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

// ─── Content-anchored finding identity (D-G5, scheme v2) ─────────────────────
// The line-based fingerprint above re-mints identity whenever a finding
// shifts more than CODE_FINGERPRINT_LINE_WINDOW lines, which strands
// allowlist entries + churns baselines on unrelated edits. The
// content-anchored scheme replaces the line component with an anchor
// derived from WHAT the finding is, not WHERE it sits:
//
//   secret → the salted HMAC of the value (computeSecretHmac) — already
//            location-independent; identical values collapse (accepted).
//   code   → codeContentAnchor(scope, span, ordinal): the normalized
//            matched span, scoped to its enclosing symbol when the graph
//            resolves one (else file-level), with an ordinal to keep
//            identical constructs in one scope distinct.
//   config → '' — identity is just (canonicalRule, file); inherently
//            line-independent (a file is tracked / on disk or it isn't).
//
// `line` becomes display metadata only. These primitives are additive;
// the dispatch + aggregator flip to them at the migration boundary
// (D-G5 step 4). See tmp/benchmark/DG5-content-anchored-identity-spec.md.

/**
 * Normalize a matched code span so cosmetic reformatting (reindentation,
 * collapsed vs expanded whitespace, trailing space) doesn't re-mint
 * identity. Runs of whitespace collapse to a single space; ends trimmed.
 * Deliberately conservative — it does NOT strip comments or rename
 * identifiers, so a real change to the construct still re-mints.
 */
export function normalizeSpan(span: string): string {
  return span.replace(/\s+/g, ' ').trim();
}

/** 16-char hex hash of a normalized matched span. */
export function spanHash(span: string): string {
  return createHash('sha1').update(normalizeSpan(span)).digest('hex').slice(0, 16);
}

/**
 * Build the content anchor for a CODE finding: `scope\0spanHash\0ordinal`.
 * `scope` is the enclosing symbol (graph-resolved) or '' (file-level
 * fallback). `ordinal` is the index among findings sharing the same
 * `(scope, spanHash)` in document order, so identical constructs in one
 * scope stay distinct. NUL-separated so the parts can't collide via
 * concatenation.
 */
export function codeContentAnchor(scope: string, span: string, ordinal: number): string {
  return codeContentAnchorFromHash(scope, spanHash(span), ordinal);
}

/**
 * Build a code content anchor from an ALREADY-HASHED span. The gather
 * boundary hashes the matched span once (`spanHash`) and carries only
 * that 16-char digest downstream — never the raw source text — so the
 * matched code never bloats reports or rides through the dashboard /
 * JSON surfaces. The aggregator, which knows the enclosing `scope` (D-G5
 * step 3 pre-pass) and the in-scope `ordinal`, assembles the final
 * anchor from that carried digest via this helper. Equivalent to
 * `codeContentAnchor` when fed `spanHash(span)`.
 */
export function codeContentAnchorFromHash(
  scope: string,
  spanHashHex: string,
  ordinal: number,
): string {
  return `${scope}\0${spanHashHex}\0${ordinal}`;
}

/**
 * Content-anchored finding fingerprint (scheme v2). Identity is
 * `(canonicalRule, file, contentAnchor)` — the anchor carries the
 * stable, location-independent content (built by the caller per kind:
 * secret=HMAC, code=`codeContentAnchor(...)`, config=''). A finding that
 * moves to a new line keeps its fingerprint; it re-mints only when the
 * matched content (or, for code, its enclosing symbol) changes.
 */
export function computeContentFingerprint(
  canonicalRule: string,
  file: string,
  contentAnchor: string,
): string {
  const input = `${canonicalRule}\0${file}\0${contentAnchor}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

// ─── Secret HMAC primitive ───────────────────────────────────────────────────

/**
 * HMAC-SHA256 of a detected secret value, keyed by a per-repo salt.
 * The output is 16-char lowercase hex (first 8 bytes of the 32-byte
 * HMAC) so it shares the byte format of the other fingerprint helpers
 * and can be embedded inline in reports without taking real estate.
 *
 * Cryptographic posture: HMAC (not bare hash) so the producer cannot
 * recover the secret from its identity even if the salt is leaked,
 * and the salt cannot be recovered from the identity even if the
 * secret is known. Truncating to 8 bytes is safe at repo scale —
 * collision probability for distinct secrets is ~2^-32 per pair,
 * negligible for any realistic finding set.
 *
 * Used by the secret-hmac identity scheme: a leaked token that moves
 * files between runs produces the same HMAC, so the matcher can
 * recognize "same secret, different location" as a relocated finding
 * rather than a deleted+added pair. The salt is per-repo so
 * cross-repo identity collisions are impossible (the same secret in
 * two repos hashes to two different HMACs).
 *
 * The producer never stores the secret value itself — only the HMAC.
 * That's the whole reason this scheme is preferred over a bare
 * content hash of the secret: zero secret-recovery risk in the
 * baseline file.
 */
export function computeSecretHmac(secret: string, salt: string): string {
  return createHmac('sha256', salt).update(secret).digest('hex').slice(0, 16);
}
