/**
 * Canonical security scoring — the single source of truth for the
 * 0-100 security score used by BOTH the health audit's Security
 * dimension and the standalone vulnerability scan.
 *
 * Closes D023: before 2.4.7, the health side and the standalone vuln
 * scan each had their own scoring formula reading different inputs.
 * Same repo, two different numbers, same label. Customer-visible
 * confusion. The hot-patch in d2bc74f renamed the standalone label to
 * "Vulnerability Score" to disambiguate; this commit makes both
 * surfaces compute the same number from the same partitioned inputs.
 *
 * `SecurityScoreInput` is a clean partition of the security signal
 * universe — every finding contributes to exactly one bucket, so the
 * formula can union the two pre-2.4.7 penalty sets without
 * double-counting. The previous standalone formula only severity-
 * counted code findings; the previous health formula only named-
 * penalized config issues. The unified formula sees both classes, so
 * scores may shift on 2.4.7 for repos with general code findings
 * (SQLi/XSS/etc.) that were invisible to the old health formula, or
 * with named config issues (private keys, .env-in-git) that the old
 * standalone formula only counted by severity. Documented in the
 * 2.4.7 CHANGELOG.
 *
 * Adapters live with their data sources:
 *   - Health side: `security/shallow.ts:toSecurityScoreInput` reads
 *     from `ScoreInput { metrics, capabilities }`. Falls back to grep-
 *     based HealthMetrics counts (`evalCount`, `tlsDisabledCount`)
 *     when `capabilities.codePatterns` is absent (semgrep unavailable).
 *   - Standalone side: `security/actions.ts:countsFromReport` reads
 *     from `SecurityReport.findings` by partitioning on rule + category.
 *
 * Both adapters land on this same `SecurityScoreInput`; both call
 * `scoreSecurityFromInput`; both get identical scores. Parity is
 * locked by a test that runs a fixture through both paths.
 */

/** Severity counts shape, kept inline for clarity at call sites. */
interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Clean partition of the security signal universe. Each finding the
 * gather code emits maps to exactly one field — no double-counting,
 * no missed contributions. Both health-side and standalone-side
 * adapters produce this shape.
 */
export interface SecurityScoreInput {
  /** Gitleaks-detected secrets (hardcoded credentials, API keys). */
  secretFindings: number;
  /** Private key / cert files on disk (*.key, *.pem). */
  privateKeyFiles: number;
  /** .env files tracked in git. */
  envFilesInGit: number;
  /**
   * Semgrep code-pattern findings by severity. Includes eval/exec,
   * TLS verification disabled, SQL injection, XSS, CORS, SSRF, and
   * every other static-analysis pattern the active language packs'
   * rulesets cover.
   */
  codeFindings: SeverityCounts;
  /** Dependency-vulnerability counts unioned across active packs. */
  depVulns: SeverityCounts;
}

/**
 * Compute the 0-100 security score from the canonical input shape.
 * Same formula, same inputs, same output — applied by both the health
 * dimension rollup and the standalone vuln scan.
 */
export function scoreSecurityFromInput(input: SecurityScoreInput): { score: number } {
  let score = 100;

  // Secrets (gitleaks). Same thresholds the pre-2.4.7 health formula
  // used; standalone formula previously only counted them through
  // severity buckets — this lifts secrets to a named penalty class.
  if (input.secretFindings > 10) score -= 25;
  else if (input.secretFindings > 5) score -= 20;
  else if (input.secretFindings > 0) score -= 15;

  // Private keys / certs on disk. Always critical regardless of count
  // — one leaked private key compromises the whole system.
  if (input.privateKeyFiles > 0) score -= 20;

  // .env tracked in git. Single named penalty: even one leaked .env
  // is a fixed-cost incident, count doesn't change remediation.
  if (input.envFilesInGit > 0) score -= 10;

  // General code findings (semgrep). Pre-2.4.7 health formula was
  // blind to these (only named eval/TLS via grep-based HealthMetrics);
  // this restores severity-based coverage so SQLi/XSS/CORS/SSRF count.
  const cf = input.codeFindings;
  if (cf.critical > 10) score -= 25;
  else if (cf.critical > 5) score -= 20;
  else if (cf.critical > 0) score -= 15;

  if (cf.high > 5) score -= 10;
  else if (cf.high > 0) score -= 5;

  if (cf.medium > 10) score -= 5;

  // Dep vulns. Both pre-2.4.7 formulas agreed on these thresholds;
  // the unified scorer keeps them unchanged.
  if (input.depVulns.critical > 0) score -= 15;
  if (input.depVulns.high > 5) score -= 10;
  else if (input.depVulns.high > 0) score -= 5;

  return { score: Math.max(0, Math.min(100, score)) };
}
