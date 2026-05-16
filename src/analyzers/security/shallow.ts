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
 *   - `codeFindings`     ← `capabilities.securityAggregate.codeBySeverity`
 *                         post-G_v4_8 (C1.3). One source of truth for
 *                         every health vs vuln-scan comparison; closes
 *                         the D086 class of "same metric, different
 *                         totals." Falls back to legacy capability +
 *                         metrics counting only for ScoreInput shapes
 *                         that predate the aggregator field (test
 *                         fixtures, pre-2.4.7 callers).
 *   - `depVulns`         ← `capabilities.securityAggregate.depBySeverity`
 *                         (post-fingerprint-dedup), falling back to
 *                         `capabilities.depVulns.counts` for legacy.
 */
export function toSecurityScoreInput(input: ScoreInput): SecurityScoreInput {
  const m = input.metrics;
  const c = input.capabilities;

  // G_v4_8 (C1.3): when the aggregate is present, code-finding severity
  // counts come from `aggregate.codeBySeverity` — the SAME field
  // `analyzeSecurity` reads. Two consumers, one source. Same input ⇒
  // same number, by construction.
  //
  // Note that the aggregate's code bucket is JUST code-pattern findings
  // (semgrep + tls-bypass-registry, post-dedup). It excludes secrets,
  // private-keys, and `.env`-in-git — those have their own dedicated
  // `secretFindings`/`privateKeyFiles`/`envFilesInGit` axes in the
  // health prose, so they're not in `cf` here. Pre-C1.3 code added
  // `m.tlsDisabledCount` and `m.evalCount` as separate signals; the
  // aggregate now carries the tls-bypass findings directly (with
  // file/line and post-dedup), so those manual adds are gone.
  let codeFindings: { critical: number; high: number; medium: number; low: number };
  if (c.securityAggregate) {
    codeFindings = { ...c.securityAggregate.codeBySeverity };
  } else {
    // Legacy fallback (test fixtures, pre-2.4.7 callers without
    // `securityAggregate`). Mirrors the pre-C1.3 behavior so existing
    // unit tests keep passing. The G_v4_8 gate's smoking-gun
    // (`[f.severity]++`) appears here intentionally — it's the
    // fallback path the gate's allowlist exists for.
    codeFindings = { critical: 0, high: 0, medium: 0, low: 0 };
    if (c.codePatterns) {
      for (const f of c.codePatterns.findings) {
        codeFindings[f.severity]++; // aggregator-ok: legacy fallback when ScoreInput has no securityAggregate (test fixtures)
      }
    } else {
      codeFindings.high += m.evalCount;
    }
    codeFindings.high += m.tlsDisabledCount;
  }

  // G_v4_8 (C1.3): dep-vuln bucket counts come from the aggregate's
  // post-fingerprint-dedup set. Matches vuln-scan + BoM exactly.
  const depCounts = c.securityAggregate
    ? c.securityAggregate.depBySeverity
    : {
        critical: c.depVulns?.counts.critical ?? 0,
        high: c.depVulns?.counts.high ?? 0,
        medium: c.depVulns?.counts.medium ?? 0,
        low: c.depVulns?.counts.low ?? 0,
      };

  return {
    secretFindings: c.secrets?.findings.length ?? 0,
    privateKeyFiles: m.privateKeyFiles,
    envFilesInGit: m.envFilesInGit,
    codeFindings,
    depVulns: depCounts,
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
    // Schema v11: `metrics` surfaces only the non-capability signals
    // that aren't already rolled into the prose's code-findings
    // total. `evalCount` and `tlsDisabledCount` ARE counted in
    // `codeBySeverity` (via the canonical SecurityAggregate), so
    // surfacing them as separate metric rows reads as "26 + 11"
    // when reality is "26 already includes those 11." Drop them
    // from the rendered metric table; they remain available on
    // the raw HealthMetrics for programmatic consumers that need
    // the breakdown.
    metrics: {
      privateKeyFiles: m.privateKeyFiles,
      envFilesInGit: m.envFilesInGit,
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
