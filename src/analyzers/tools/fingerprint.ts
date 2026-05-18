/**
 * Durable per-finding identity across runs — used by both intra-run dedup
 * (the security aggregator collapses cross-tool overlaps via fingerprint)
 * and cross-run diff tooling (baselines compare today's fingerprint set
 * against yesterday's to surface added / removed / persisted findings).
 *
 * Two fingerprint families live here:
 *
 *   1. Dependency-advisory fingerprints — stable hash of
 *      `(package, installedVersion, id)`. Used by `gatherDepVulns` +
 *      BoM. Excludes severity / cvssScore / enrichment fields
 *      (epssScore, kev, reachable, riskScore), producer `tool`, and
 *      `upgradeAdvice` / `upgradePlan` so re-scoring the same advisory
 *      against the same install never mints a new identity.
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
 * Stable 16-char hex fingerprint for one DepVulnFinding. Input tuple
 * is NUL-separated (not present in any legal package / version / id)
 * so distinct tuples can never collide via concatenation tricks.
 *
 * `installedVersion` is normalized to the empty string when absent so
 * version-less findings (rare — some providers omit it when the lock
 * file is missing) still get a deterministic fingerprint instead of
 * mixing an ambient `undefined` into the hash input.
 */
export function computeFingerprint(
  finding: Pick<DepVulnFinding, 'package' | 'installedVersion' | 'id'>,
): string {
  const input = `${finding.package}\0${finding.installedVersion ?? ''}\0${finding.id}`;
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
  // TLS / certificate validation bypass
  ['tls-bypass-registry:tls-validation-disabled', 'canonical:tls-bypass'],
  ['semgrep:bypass-tls-verification', 'canonical:tls-bypass'],
  ['semgrep:nodejsscan.node_tls_reject_unauthorized', 'canonical:tls-bypass'],

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
