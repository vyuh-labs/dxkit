/**
 * Advisory fingerprints — durable per-finding identity across runs.
 *
 * The dispatcher's dep-vuln aggregator (src/analyzers/security/gather.ts)
 * stamps every finding with a stable hash of `(package, installedVersion,
 * id)` before scoring + reporting. The same advisory against the same
 * installed version produces the same fingerprint on every run, so
 * consumers (agent-driven upgrade bots, suppressions, CI gates) can diff
 * a current bom against a stored prior to detect:
 *
 *   - new advisories (fingerprint present now, absent before)
 *   - resolved advisories (fingerprint absent now, present before)
 *   - unchanged advisories (fingerprint in both sets)
 *
 * Excluded from the hash:
 *   - severity / cvssScore — re-scoring the same advisory against the
 *     same install must not mint a new identity
 *   - enrichment fields (epssScore, kev, reachable, riskScore) — same
 *     reason; these are signals about the advisory, not part of it
 *   - producer `tool` — the same advisory hit by two producers (e.g.
 *     npm-audit + snyk) should collapse to one identity
 *   - `upgradeAdvice` / `upgradePlan` — resolution suggestions change
 *     across releases of the fix tooling; identity must outlive them
 *
 * Format: 16-char lowercase hex (first 8 bytes of SHA-1). Short enough
 * to embed inline in reports, long enough to make collisions between
 * non-identical tuples effectively impossible for repo-scale sets.
 */

import { createHash } from 'crypto';
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
