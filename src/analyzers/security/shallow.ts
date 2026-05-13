/**
 * Security dimension — health-side adapter over the canonical
 * security scorer.
 *
 * Translates `ScoreInput { metrics, capabilities }` into the
 * `SecurityScoreInput` partition consumed by `scoreSecurityFromInput`,
 * then wraps the resulting score in a full `DimensionScore` (status +
 * details + metrics envelope) for the health audit rollup.
 *
 * D023 closure: this file used to delegate to a separate
 * `scoreSecurity` in `analyzers/scoring.ts`; that function is gone,
 * and the canonical formula now lives in `security/scoring.ts` so
 * both the health audit and the standalone vuln scan compute the
 * same number from the same partitioned inputs.
 */
import { DimensionScore } from '../types';
import { ScoreInput } from '../scoring';
import { SecurityScoreInput, scoreSecurityFromInput } from './scoring';

function status(score: number): DimensionScore['status'] {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'poor';
  return 'critical';
}

/**
 * Build the canonical `SecurityScoreInput` from the health-side
 * `ScoreInput`. Each field maps to its data source:
 *
 *   - `secretFindings`   ← `capabilities.secrets.findings.length` (gitleaks)
 *   - `privateKeyFiles`  ← `metrics.privateKeyFiles` (find on disk)
 *   - `envFilesInGit`    ← `metrics.envFilesInGit` (git ls-files)
 *   - `codeFindings`     ← `capabilities.codePatterns.findings` (semgrep)
 *                         OR fallback to grep-derived HealthMetrics
 *                         (`evalCount` + `tlsDisabledCount`, both attributed
 *                         to HIGH severity) when semgrep is unavailable.
 *                         This preserves pre-2.4.7 health-side coverage
 *                         for environments without semgrep installed.
 *   - `depVulns`         ← `capabilities.depVulns.counts`
 */
export function toSecurityScoreInput(input: ScoreInput): SecurityScoreInput {
  const m = input.metrics;
  const c = input.capabilities;

  const codeFindings = { critical: 0, high: 0, medium: 0, low: 0 };
  if (c.codePatterns) {
    // Semgrep ran (envelope present) — trust the precise severity-
    // tagged findings, including the zero-finding case. For `evalCount`
    // the grep-based fallback is a strict over-approximation (matches
    // the literal text `eval(` inside our own source that *processes*
    // eval-call findings, for example), so when semgrep is available
    // it must win for that signal.
    for (const f of c.codePatterns.findings) {
      codeFindings[f.severity]++;
    }
  } else {
    // Semgrep unavailable. Fall back to the grep-based eval count so
    // environments without semgrep don't lose code-pattern coverage
    // for eval calls.
    codeFindings.high += m.evalCount;
  }

  // D045 (2.4.7): `tlsDisabledCount` is ALWAYS added regardless of
  // semgrep availability. Unlike `evalCount` (which over-matches text
  // mentioning `eval(`), the TLS-bypass patterns are tight class/method
  // names (`ServerCertificateValidationCallback`,
  // `DangerousAcceptAnyServerCertificateValidator`,
  // `InsecureSkipVerify: true`, etc. — per D034 `tlsBypassPatterns`).
  // False-positive rate is near zero. Semgrep's `p/security-audit`
  // ruleset doesn't include these per-language idioms — that's why
  // D034's per-pack registry approach exists. Both signals complement
  // each other.
  //
  // Pre-D045 dpl-studio surfaced `tlsDisabledCount: 1` in the metrics
  // JSON but the Security prose said "0H code findings" (because
  // semgrep ran with 0 findings and silently masked the grep signal).
  codeFindings.high += m.tlsDisabledCount;

  return {
    secretFindings: c.secrets?.findings.length ?? 0,
    privateKeyFiles: m.privateKeyFiles,
    envFilesInGit: m.envFilesInGit,
    codeFindings,
    depVulns: {
      critical: c.depVulns?.counts.critical ?? 0,
      high: c.depVulns?.counts.high ?? 0,
      medium: c.depVulns?.counts.medium ?? 0,
      low: c.depVulns?.counts.low ?? 0,
    },
    // D025b (2.4.7): default to `true` when `depVulnsAvailability` is
    // absent. The field is populated only by `gatherCapabilityReport`
    // (the health path); legacy test fixtures and pre-2.4.7 inputs may
    // omit it. true = "no cap applies" — safer default because the cap
    // is a downgrade; an explicit `false` from the gather is the only
    // signal we trust to apply it.
    depVulnsAvailable: c.depVulnsAvailability?.available ?? true,
  };
}

/**
 * Score-only adapter for action ranking. The health remediation
 * planner builds `RemediationAction<ScoreInput>` patches and calls
 * `rank()` with a per-dimension scorer that maps `ScoreInput` to
 * `{ score }`. Keeping this thin wrapper lets `health/actions.ts`
 * stay symmetric across dimensions without leaking the
 * `SecurityScoreInput` shape into the health-side action code.
 */
export function scoreSecurityFromScoreInput(input: ScoreInput): { score: number } {
  return scoreSecurityFromInput(toSecurityScoreInput(input));
}

/**
 * Health audit's Security dimension entry point. Produces the
 * `DimensionScore` consumed by `health.ts:analyzeHealthInternal` for
 * the dimension rollup, the dashboard summary, and the agent report.
 */
export function scoreSecurityDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const scoreInput = toSecurityScoreInput(input);
  const { score } = scoreSecurityFromInput(scoreInput);

  const secretFindings = scoreInput.secretFindings;
  const cf = scoreInput.codeFindings;
  const depAuditTool = c.depVulns?.tool ?? null;
  const dv = scoreInput.depVulns;

  return {
    score,
    maxScore: 100,
    status: status(score),
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // Secret findings live in `report.capabilities.secrets`; dep-vuln
    // counts + audit-tool name live in `report.capabilities.depVulns`;
    // code-pattern findings live in `report.capabilities.codePatterns`.
    metrics: {
      privateKeyFiles: m.privateKeyFiles,
      evalCount: m.evalCount,
      envFilesInGit: m.envFilesInGit,
      tlsDisabledCount: m.tlsDisabledCount,
    },
    details:
      `${secretFindings} hardcoded secret patterns found` +
      `. ${scoreInput.privateKeyFiles} private key files in repo` +
      `. ${cf.critical}C ${cf.high}H ${cf.medium}M ${cf.low}L code findings` +
      `. ${scoreInput.envFilesInGit} .env files tracked in git` +
      `. Dependency vulns: ${dv.critical} critical, ${dv.high} high, ${dv.medium} medium, ${dv.low} low` +
      (depAuditTool ? ` (${depAuditTool})` : '') +
      '.',
  };
}
