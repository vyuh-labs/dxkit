/**
 * Malicious-advisory classification — ONE source of truth (the mirror of
 * `benign.ts` at the other end of the severity scale). A dependency
 * advisory that reports the package itself as malware (a compromised
 * release, a trojaned version, install-time malicious code) is a
 * different class from a vulnerability: install-time malware executes at
 * `npm install`, so "is the vulnerable function reachable from my code"
 * is the wrong lens entirely, and CVSS often under-scores or omits it
 * (OSV `MAL-*` entries frequently carry no score at all).
 *
 * The guardrail consults this predicate to drive the
 * `newMaliciousDependency` block rule: a NET-NEW dependency carrying a
 * malicious-code advisory blocks under every posture, including
 * `security-only`, regardless of CVSS severity.
 *
 * Every branch is grounded in a real feed (verified against the July 2025
 * eslint-config-prettier compromise, CVE-2025-54313):
 *   - OSV's dedicated malicious-package namespace: id/alias `MAL-….`
 *     (osv-scanner reports `MAL-2025-6022` for the incident).
 *   - The CWE malicious-code family, which npm audit attaches
 *     (`CWE-506` on the incident's GHSA advisory).
 *   - The advisory-title conventions both ecosystems use: OSV's
 *     "Malicious code in <pkg>" and GitHub's "… have embedded malicious
 *     code".
 *
 * Bias: this predicate BLOCKS, so it is precision-biased — the text
 * branch requires "malicious" adjacent to code/package/version, which a
 * normal vulnerability description ("fails to sanitize malicious input")
 * does not produce. A missed malware advisory still surfaces through the
 * ordinary severity rules; a false positive here would block a clean
 * dependency, which is the costlier error.
 */

/**
 * The CWE malicious-code family: CWE-506 "Embedded Malicious Code" and its
 * children, which occupy the contiguous id range 506–512 (507 Trojan
 * Horse, 508 Non-Replicating, 509 Replicating, 510 Trapdoor, 511
 * Logic/Time Bomb, 512 Spyware). Checked as a RANGE so the family is
 * complete by construction — a hand-picked set is exactly where a member
 * gets forgotten (the first draft of this file missed 508/509).
 *
 * Maintenance posture: this subtree has been unchanged since CWE 1.0
 * (2008), so the range is effectively static — and it is deliberately the
 * SECONDARY signal. The signal that actually evolves (which packages are
 * malicious) is ecosystem-maintained for us: OSV's `MAL-*` namespace,
 * fed by OpenSSF's malicious-packages database and matched above by id.
 * The CWE and title branches exist for feeds that carry no MAL id
 * (GitHub advisories via npm audit, ingested SARIF), as defense in depth.
 */
function isMaliciousCwe(cwe: string): boolean {
  const m = /^CWE-(\d+)$/i.exec(cwe.trim());
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 506 && n <= 512;
}

const MAL_NAMESPACE = /^MAL-\d{4}-\d+/i;

/** "Malicious code in x", "… have embedded malicious code",
 *  "malicious version(s) of …" — never bare "malicious input". */
const MALICIOUS_TEXT = /\bmalicious\s+(code|package|version)/i;

export interface MaliciousAdvisorySignals {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly cwes?: readonly string[];
}

export function isMaliciousAdvisory(f: MaliciousAdvisorySignals): boolean {
  if (MAL_NAMESPACE.test(f.id)) return true;
  if (f.aliases?.some((a) => MAL_NAMESPACE.test(a))) return true;
  if (f.cwes?.some(isMaliciousCwe)) return true;
  if (f.summary && MALICIOUS_TEXT.test(f.summary)) return true;
  return false;
}
