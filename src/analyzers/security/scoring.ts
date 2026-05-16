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
  /**
   * D025b (2.4.7): true if at least one active pack's depVulns gather
   * reached success OR cleanly reported `no-manifest`; false if any
   * pack returned `unavailable` (tool absent / no output / parse fail).
   *
   * When false, `scoreSecurityFromInput` caps the final score at
   * `DEP_VULNS_UNAVAILABLE_CAP` (65) regardless of how clean the other
   * signals are. The cap closes the F4 baseline lie (dpl-studio:
   * Security 100/100 on 133 unscanned NuGet refs) — dxkit can't
   * honestly claim a top-tier score when it couldn't actually scan
   * the deps.
   *
   * Adapters MUST populate this from `DepVulnSummary.available`:
   *   - `toSecurityScoreInput` (health side, security/shallow.ts)
   *   - `countsFromReport` (standalone side, security/actions.ts) —
   *     plumbed in D025d (next commit, same sub-branch).
   */
  depVulnsAvailable: boolean;
}

/**
 * Score ceiling applied when `depVulnsAvailable === false`. Picked
 * after the dpl-studio F4 baseline forensic suggested "cap at
 * ~60-70/100." 65 is the midpoint — close enough to "C grade / fair"
 * that no customer reads it as "excellent" but high enough that other
 * security signals (secrets, semgrep, TLS) can still subtract from it
 * meaningfully when they ALSO have issues. Compare F-RPT-2's testing
 * dimension cap at 35/100, which was more aggressive because no
 * coverage data means zero signal; here the rest of the security
 * signal chain still contributes, so the cap is less severe.
 */
export const DEP_VULNS_UNAVAILABLE_CAP = 65;

/**
 * C2.2 / D098 (2.4.7 Phase C2): score ceiling applied when ANY of:
 *   - `secretFindings > 0` (gitleaks found hardcoded credentials)
 *   - `privateKeyFiles > 0` (`.key` / `.pem` files on disk)
 *   - `envFilesInGit > 0` (`.env` tracked in git history)
 *
 * Origin: web-client baseline scored 60/100 "Good" despite 4 hardcoded
 * secrets + 1 `.env` in git — credentials exposed in source-control
 * are a foundational trust failure, not a "Good" status. Health
 * customers reading the score made remediation-deferral decisions
 * because "60/100 Good" reads as deprioritisable.
 *
 * Rationale for 40: matches the status-threshold boundary (≥ 40 is
 * "Fair", < 40 is "Poor"). A repo with leaked secrets cannot honestly
 * claim better than "Fair" regardless of other signals — credentials
 * once committed are presumed compromised even after rotation
 * (history walks pull them). The cap is high enough that fully clean
 * everything else still surfaces "Fair" (40), low enough that no
 * stakeholder reads it as "this is acceptable."
 *
 * Compare DEP_VULNS_UNAVAILABLE_CAP = 65 — the dep-availability cap
 * is "we couldn't scan, so we can't say it's perfect" (uncertain).
 * The secrets cap is "we ARE certain credentials leaked" (definite),
 * so the ceiling is more aggressive.
 */
export const SECRETS_PRESENT_CAP = 40;

/**
 * Score ceiling applied when any HIGH or CRITICAL code finding is
 * open. Without it, a repo with one outstanding HIGH code finding
 * (e.g. a TLS-validation-disabled call site) scored in the high
 * 80s / low 90s — numerically correct given the penalty schedule
 * but the "Excellent" label read as "you're done" while a real
 * HIGH was still open and concrete. Customer trusts the headline
 * and ships.
 *
 * Rationale for 75: matches the status-threshold for "Good"
 * (60-79). A repo with an outstanding HIGH (or worse) code
 * finding cannot honestly claim "Excellent" (>= 80) — the
 * finding is concrete, file-and-line-specific, and unfixed.
 * 75 lets the dimension still read as "Good" (the finding is
 * fixable + scoped), but no longer as "Excellent."
 *
 * Compare DEP_VULNS_UNAVAILABLE_CAP = 65 (uncertain) and
 * SECRETS_PRESENT_CAP = 40 (definite trust failure). This cap
 * sits between them: definite but bounded — a code finding is
 * concrete (definite) but less existential than a leaked
 * credential.
 */
export const CODE_FINDING_HIGH_PLUS_OPEN_CAP = 75;

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

  // D025b honesty cap: when dxkit couldn't actually scan the deps,
  // the dimension can't honestly claim a top-tier score regardless
  // of how clean the other signals are. Applied AFTER all penalties
  // so the cap is a ceiling, not a floor — a repo with both
  // unavailable deps AND a critical-secret leak still scores below
  // 65 (the secret leak's -25 wins over the cap). Both penalties +
  // cap compose monotonically.
  let final = Math.max(0, Math.min(100, score));
  if (!input.depVulnsAvailable && final > DEP_VULNS_UNAVAILABLE_CAP) {
    final = DEP_VULNS_UNAVAILABLE_CAP;
  }
  // Outstanding HIGH/CRITICAL code finding cap. A concrete,
  // file-and-line-specific code-pattern finding above HIGH
  // severity cannot honestly leave the dimension reading as
  // "Excellent" (>= 80). Applied before the secrets cap so the
  // latter (stronger) ceiling still wins when both apply.
  if (
    (input.codeFindings.high > 0 || input.codeFindings.critical > 0) &&
    final > CODE_FINDING_HIGH_PLUS_OPEN_CAP
  ) {
    final = CODE_FINDING_HIGH_PLUS_OPEN_CAP;
  }
  // Secrets-in-source cap. Any committed credential (hardcoded
  // secret, private key on disk, or .env in git) is a
  // foundational trust failure that bounds the dimension at ≤ 40
  // ("Fair" or worse) regardless of how clean other signals are.
  // Applied last so it's a ceiling that composes with everything
  // else.
  if (
    (input.secretFindings > 0 || input.privateKeyFiles > 0 || input.envFilesInGit > 0) &&
    final > SECRETS_PRESENT_CAP
  ) {
    final = SECRETS_PRESENT_CAP;
  }
  return { score: final };
}
