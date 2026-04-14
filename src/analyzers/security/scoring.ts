/**
 * Security scoring — internal scorer over finding+dep counts, used for
 * RemediationAction ranking in detailed reports.
 *
 * Distinct from src/analyzers/scoring.ts scoreSecurity() which operates on
 * HealthMetrics for the health dimension rollup. This scorer is scoped to
 * SecurityReport's own shape so remediation actions can simulate deltas
 * without going through HealthMetrics.
 */

/** Counts summarized from a SecurityReport. Patches produce a new snapshot. */
export interface SecurityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  depCritical: number;
  depHigh: number;
  depMedium: number;
  depLow: number;
}

/**
 * 0-100 security score from finding + dep counts.
 * Mirrors the health-side scoreSecurity() thresholds so projected values stay
 * intuitive to users who also read the health report.
 */
export function scoreSecurityCounts(c: SecurityCounts): { score: number } {
  let score = 100;

  if (c.critical > 10) score -= 25;
  else if (c.critical > 5) score -= 20;
  else if (c.critical > 0) score -= 15;

  if (c.high > 5) score -= 10;
  else if (c.high > 0) score -= 5;

  if (c.medium > 10) score -= 5;

  if (c.depCritical > 0) score -= 15;
  if (c.depHigh > 5) score -= 10;
  else if (c.depHigh > 0) score -= 5;

  return { score: Math.max(0, Math.min(100, score)) };
}
