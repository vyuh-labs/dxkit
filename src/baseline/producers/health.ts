/**
 * Health → baseline-entry producer.
 *
 * One kind today: `large-file` — source files whose line count exceeds the
 * resolved large-file threshold. Identity is per-file: the binary "this file is
 * over the threshold" signal is what guardrails act on. Crossing back under the
 * threshold removes the identity; crossing back over re-adds it.
 *
 * The producer does NOT re-apply the threshold — it reads
 * `HealthMetrics.largestFiles`, which the canonical generic-metrics gather has
 * ALREADY filtered to files over `HealthMetrics.largeFileThreshold` (the one
 * application point). So the per-file identity set here sums exactly to the
 * `filesOver500Lines` aggregate, and both honor a
 * `.dxkit/policy.json:largeFileThreshold` override with no second threshold
 * living in this file (CLAUDE.md Rule 2 — one concept, one code path).
 */

import { identityFor } from '../finding-identity';
import type { RichBaselineEntry, LargeFileIdentityInput } from '../types';
import type { HealthMetrics } from '../../analyzers/types';

/**
 * Build `large-file` entries from the canonical `HealthMetrics`. `largestFiles`
 * is already threshold-filtered upstream, so this is a pure one-entry-per-file
 * projection.
 */
export function largeFilesToBaselineEntries(metrics: HealthMetrics): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  for (const f of metrics.largestFiles) {
    const input: LargeFileIdentityInput = { kind: 'large-file', file: f.path };
    out.push({ id: identityFor(input), kind: 'large-file', file: f.path });
  }
  return out;
}
