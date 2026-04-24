/**
 * Composite risk score for dependency advisories.
 *
 * Combines four signals into a single 0–100 number that orders
 * remediation priority without requiring the user to juggle CVSS,
 * EPSS, KEV, and reachability in their head:
 *
 *   - CVSS base severity (how bad if exploited) — 0–10
 *   - EPSS (probability of exploitation in 30d)   — 0.0–1.0
 *   - KEV (CISA confirmed in-the-wild exploit)    — boolean
 *   - reachable (my source imports it)            — true/false/undefined
 *
 * Formula (multiplicative, clamped):
 *
 *   base   = cvss * 10                              (0–100)
 *   kevMul = kev ? 2.0 : 1.0
 *   epssMul = 1 + 2 * epss                          (1.0 – 3.0)
 *   reachMul =
 *       true      → 1.0    (no change)
 *       false     → 0.25   (heavy discount for provably unreachable)
 *       undefined → 0.7    (conservative middle — can't tell, don't zero it)
 *   score = clamp(base * kevMul * epssMul * reachMul, 0, 100)
 *
 * Worked examples:
 *   - Critical (9.8) + KEV + reachable + EPSS 0.5:
 *       98 * 2.0 * 2.0 * 1.0 = 392  →  100
 *   - Critical + not reachable + no KEV + EPSS 0.01:
 *       98 * 1.0 * 1.02 * 0.25 ≈ 25
 *   - Low (2.0) + reachable + no KEV + EPSS 0:
 *       20 * 1.0 * 1.0 * 1.0  = 20
 *   - Medium (5.5) + no signals, reachable unknown:
 *       55 * 1.0 * 1.0 * 0.7  ≈ 39
 *
 * Returns `null` when CVSS is unavailable — callers leave the column
 * blank rather than fabricate a score from partial data. The formula
 * is documented and transparent so reviewers can sanity-check the
 * relative ordering before trusting it. Future 10h.8 Snyk overlay
 * can layer a tool-sourced score on top without changing this OSS
 * baseline.
 *
 * Pure function; no IO, no state. Unit-testable with synthetic inputs.
 */

import type { DepVulnFinding } from '../../languages/capabilities/types';

export interface RiskScoreInputs {
  cvssScore?: number;
  epssScore?: number;
  kev?: boolean;
  reachable?: boolean;
}

/**
 * Compute the composite risk score for one finding, or null when
 * CVSS is missing (we don't fabricate severity from side signals).
 */
export function computeRiskScore(inputs: RiskScoreInputs): number | null {
  const cvss = inputs.cvssScore;
  if (cvss === undefined) return null;

  const base = cvss * 10;
  const kevMul = inputs.kev ? 2.0 : 1.0;
  const epssMul = 1 + 2 * (inputs.epssScore ?? 0);
  const reachMul = inputs.reachable === true ? 1.0 : inputs.reachable === false ? 0.25 : 0.7;

  const raw = base * kevMul * epssMul * reachMul;
  return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
}

/**
 * Convenience: classify a riskScore into a triage tier for render
 * sorting and color-coding. Thresholds picked so most findings land
 * outside "must-fix-now" — the riskScore's job is to make those
 * stand out.
 */
export type RiskTier = 'critical' | 'high' | 'moderate' | 'low' | 'none';

export function riskTier(score: number | null): RiskTier {
  if (score === null) return 'none';
  if (score >= 70) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 15) return 'moderate';
  return 'low';
}

/**
 * Annotate every finding's `riskScore` field in place. Skips findings
 * with no CVSS (riskScore stays unset; renderers handle that as
 * "—" / blank column).
 */
export function scoreFindings(findings: DepVulnFinding[]): void {
  for (const f of findings) {
    const s = computeRiskScore(f);
    if (s !== null) f.riskScore = s;
  }
}
