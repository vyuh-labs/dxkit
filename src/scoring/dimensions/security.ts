/**
 * Security dimension — declarative scoring spec.
 *
 * Methodology: severity-dominant rating per ISO/IEC 5055 (automated
 * source code quality measures, CISQ-driven) layered with CVSS v4
 * (FIRST.org) for vulnerability severity bands. The spec encodes:
 *
 *   - Penalty deductions for secrets, private keys, `.env` in git,
 *     code-pattern findings (semgrep et al), and dependency
 *     vulnerabilities. Each penalty surfaces as a discrete Deduction
 *     with a human-readable reason.
 *   - Cap rules that bound the rating when specific blocker classes
 *     are present (see `src/scoring/STANDARDS.md` for the cap
 *     taxonomy):
 *       trust-broken (40)        — committed credentials
 *       uncertainty (65)         — dep-vuln scanner did not run
 *       fixable-finding (79)     — open HIGH/CRITICAL code finding
 *
 * The evaluator (`evaluateSpec`) consumes this spec + a
 * `SecurityScoreInput` and produces the canonical `ScoreResult`. Both
 * the health audit's Security dimension and the standalone
 * vulnerability scan call the same path — same input ⇒ same number
 * by construction.
 *
 * Adapters that build `SecurityScoreInput` from their domain data:
 *
 *   - Health side: `src/analyzers/security/shallow.ts:toSecurityScoreInput`
 *     reads from `ScoreInput { metrics, capabilities }`. Falls back
 *     to grep-based HealthMetrics counts when `capabilities.codePatterns`
 *     is absent (semgrep unavailable).
 *   - Standalone side: `src/analyzers/security/actions.ts:countsFromReport`
 *     reads from `SecurityReport.findings` by partitioning on rule +
 *     category.
 *
 * Both adapters land on this same `SecurityScoreInput` shape; both
 * dispatch through the same spec; both observe identical scores.
 */

import type { DimensionScoringSpec } from '../spec';

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
   * True if at least one active pack's depVulns gather reached
   * success OR cleanly reported `no-manifest`; false if any pack
   * returned `unavailable` (tool absent / no output / parse fail).
   *
   * When false, the `dep-vulns-unavailable` cap fires and bounds
   * the score at the uncertainty tier ceiling regardless of other
   * signals — dxkit can't honestly claim a top-tier score when it
   * couldn't actually scan the deps.
   *
   * Adapters MUST populate this from `DepVulnSummary.available`.
   */
  depVulnsAvailable: boolean;
  /**
   * Pre-2.10 the unavailability cap was asymmetric — a missing
   * dep-vuln scan capped at the uncertainty tier while missing
   * secret/code scanners silently scored as "0 findings". An upgrade
   * that merely turned the secret scanners ON then read as a score
   * drop on an unchanged commit. These two flags give
   * every measurement axis the same honest treatment: scanner didn't
   * run → uncertainty cap, never a confident clean score.
   *
   * Same attempted-and-failed semantics as `depVulnsAvailable`:
   * false ONLY when the gather was attempted and no provider
   * succeeded. "No active provider" stays vacuously true.
   */
  secretsAvailable: boolean;
  /** See `secretsAvailable` — same contract for the semgrep /
   *  code-patterns axis. */
  codePatternsAvailable: boolean;
}

/**
 * Helper: render a count phrase with proper plural ("1 secret" /
 * "5 secrets"). Used by penalty + cap reason builders.
 */
function plural(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export const SECURITY_SCORING_SPEC: DimensionScoringSpec<SecurityScoreInput> = {
  dimension: 'security',
  methodology: 'iso-iec-5055-severity-dominant',
  baseline: 100,
  penalties: [
    {
      id: 'secrets-present',
      describe: (i) => `${plural(i.secretFindings, 'hardcoded secret')} detected`,
      applies: (i) => i.secretFindings > 0,
      delta: (i) => (i.secretFindings > 10 ? -25 : i.secretFindings > 5 ? -20 : -15),
    },
    {
      id: 'private-key-files',
      describe: (i) => `${plural(i.privateKeyFiles, 'private key / cert file')} on disk`,
      applies: (i) => i.privateKeyFiles > 0,
      delta: () => -20,
    },
    {
      id: 'env-files-in-git',
      describe: (i) => `${plural(i.envFilesInGit, '.env file')} tracked in git`,
      applies: (i) => i.envFilesInGit > 0,
      delta: () => -10,
    },
    {
      id: 'code-findings-critical',
      describe: (i) =>
        `${plural(i.codeFindings.critical, 'CRITICAL code finding')} (static analysis)`,
      applies: (i) => i.codeFindings.critical > 0,
      delta: (i) => (i.codeFindings.critical > 10 ? -25 : i.codeFindings.critical > 5 ? -20 : -15),
    },
    {
      id: 'code-findings-high',
      describe: (i) => `${plural(i.codeFindings.high, 'HIGH code finding')} (static analysis)`,
      applies: (i) => i.codeFindings.high > 0,
      delta: (i) => (i.codeFindings.high > 5 ? -10 : -5),
    },
    {
      id: 'code-findings-medium',
      describe: (i) => `${plural(i.codeFindings.medium, 'MEDIUM code finding')} (static analysis)`,
      applies: (i) => i.codeFindings.medium > 10,
      delta: () => -5,
    },
    {
      id: 'dep-vulns-critical',
      describe: (i) => `${plural(i.depVulns.critical, 'CRITICAL dependency vulnerability')}`,
      applies: (i) => i.depVulns.critical > 0,
      delta: () => -15,
    },
    {
      id: 'dep-vulns-high',
      describe: (i) => `${plural(i.depVulns.high, 'HIGH dependency vulnerability')}`,
      applies: (i) => i.depVulns.high > 0,
      delta: (i) => (i.depVulns.high > 5 ? -10 : -5),
    },
  ],
  caps: [
    {
      id: 'secrets-present',
      tier: 'trust-broken',
      describe: (i) => {
        const parts: string[] = [];
        if (i.secretFindings > 0) parts.push(plural(i.secretFindings, 'hardcoded secret'));
        if (i.privateKeyFiles > 0) parts.push(plural(i.privateKeyFiles, 'private key file'));
        if (i.envFilesInGit > 0) parts.push(plural(i.envFilesInGit, '.env in git'));
        return `committed credentials present: ${parts.join(' + ')}`;
      },
      applies: (i) => i.secretFindings > 0 || i.privateKeyFiles > 0 || i.envFilesInGit > 0,
    },
    {
      id: 'dep-vulns-unavailable',
      tier: 'uncertainty',
      describe: () => `dependency vulnerability scan did not run`,
      applies: (i) => !i.depVulnsAvailable,
    },
    {
      id: 'secrets-unavailable',
      tier: 'uncertainty',
      describe: () => `secret scan did not run`,
      applies: (i) => !i.secretsAvailable,
    },
    {
      id: 'code-patterns-unavailable',
      tier: 'uncertainty',
      describe: () => `static-analysis (code-pattern) scan did not run`,
      applies: (i) => !i.codePatternsAvailable,
    },
    {
      id: 'high-plus-code-open',
      tier: 'fixable-finding',
      describe: (i) => {
        const total = i.codeFindings.critical + i.codeFindings.high;
        return `${plural(total, 'open HIGH+ code finding')}`;
      },
      applies: (i) => i.codeFindings.critical > 0 || i.codeFindings.high > 0,
    },
  ],
};
