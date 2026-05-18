/**
 * Pure threshold checks for the `--fail-on-*` flags.
 *
 * Two flag families:
 *
 *   - **`--fail-on-score N`** — fail when the analyzer's headline
 *     score drops below `N`. Applies to commands with a higher-is-
 *     better aggregate score (health.overallScore,
 *     test-gaps.effectiveCoverage).
 *
 *   - **`--fail-on-severity <tier>`** — fail when any finding at the
 *     named tier or higher exists. Applies to commands that report
 *     severity-graded findings (vulnerabilities, bom).
 *
 * These flags are independent of `guardrail check` — they enforce
 * absolute floors that don't require a prior baseline. A team can
 * compose them in CI to layer aggregate-floor gates alongside
 * per-finding regression gates.
 *
 * Pure module: each helper returns a structured verdict. The CLI
 * layer maps the verdict to `process.exit(1)` + a logged reason.
 */

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Ordinal ranking. Higher rank = more severe. Used to decide whether
 * a finding at severity X passes a `--fail-on-severity Y` gate (X
 * fails iff rank(X) >= rank(Y)).
 */
export const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
});

/** Per-severity counts as the analyzers report them. */
export interface SeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

/**
 * Verdict shape shared by both flag families. `fails === true` maps
 * to a non-zero exit code; `reason` is the message the CLI surfaces
 * before exiting.
 */
export interface FailOnVerdict {
  readonly fails: boolean;
  readonly reason?: string;
}

/**
 * Check a higher-is-better score against a minimum threshold.
 *
 * Returns `{ fails: true, reason }` when `score < threshold`.
 * Returns `{ fails: false }` otherwise.
 *
 * `threshold` is parsed from the CLI; the caller validates that it's
 * a finite number in `[0, 100]` (or whatever the score domain is)
 * before invoking. Non-finite or NaN inputs throw — the caller
 * should reject those at parse time.
 */
export function checkFailOnScore(score: number, threshold: number): FailOnVerdict {
  if (!Number.isFinite(score)) {
    throw new Error(`fail-on-score: report score is not a finite number (got ${score})`);
  }
  if (!Number.isFinite(threshold)) {
    throw new Error(`fail-on-score: threshold is not a finite number (got ${threshold})`);
  }
  if (score < threshold) {
    return {
      fails: true,
      reason: `score ${score} is below --fail-on-score threshold ${threshold}`,
    };
  }
  return { fails: false };
}

/**
 * Check whether any finding at `tier` or higher exists in `counts`.
 *
 * Returns `{ fails: true, reason }` when at least one such finding
 * is present. `reason` lists each contributing tier so the user
 * sees *what* triggered the gate without re-reading the report.
 *
 * `tier` must be one of the four canonical severities; any other
 * value throws. The caller should reject malformed input at parse
 * time so the helper can stay pure.
 */
export function checkFailOnSeverity(counts: SeverityCounts, tier: FindingSeverity): FailOnVerdict {
  if (!(tier in SEVERITY_RANK)) {
    throw new Error(
      `fail-on-severity: unknown tier "${tier}" (expected one of: critical, high, medium, low)`,
    );
  }
  const threshold = SEVERITY_RANK[tier];
  const offending: Array<{ readonly severity: FindingSeverity; readonly count: number }> = [];
  const severities: FindingSeverity[] = ['critical', 'high', 'medium', 'low'];
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] < threshold) continue;
    const count = counts[severity];
    if (count > 0) offending.push({ severity, count });
  }
  if (offending.length === 0) return { fails: false };
  const detail = offending.map((o) => `${o.count} ${o.severity}`).join(', ');
  return {
    fails: true,
    reason: `findings at or above --fail-on-severity ${tier}: ${detail}`,
  };
}

/**
 * Parse the `--fail-on-severity` CLI value into a typed tier.
 * Returns `null` for an unrecognized value so the caller can render
 * a helpful error including the user-supplied string. Doing the
 * validation here keeps the CLI parsing site concern-free.
 */
export function parseSeverityTier(raw: string): FindingSeverity | null {
  if (raw === 'critical' || raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw;
  }
  return null;
}

/**
 * Parse the `--fail-on-score` CLI value into a finite number.
 * Returns `null` when the value is missing, non-numeric, NaN, or
 * outside the score domain `[0, 100]`. The CLI converts `null` to a
 * helpful error pointing the user at valid inputs.
 */
export function parseScoreThreshold(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}
