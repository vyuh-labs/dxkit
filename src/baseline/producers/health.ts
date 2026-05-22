/**
 * Health → baseline-entry producer.
 *
 * One kind today: `large-file` — source files whose line count
 * exceeds the canonical large-file threshold (500 lines). Identity
 * is per-file: the binary "this file is over the threshold" signal
 * is what guardrails act on. Crossing back under the threshold
 * removes the identity; crossing back over re-adds it.
 *
 * Producer reads from `HealthMetrics.largestFiles`, which is already
 * an `Array<{ path, lines }>` produced by the canonical generic-
 * metrics gather. The 500-line threshold matches the
 * `filesOver500Lines` aggregate the same gather emits — keeping the
 * two in sync ensures the per-file identity set sums to the
 * aggregate count.
 */

import { identityFor } from '../finding-identity';
import type { RichBaselineEntry, LargeFileIdentityInput } from '../types';
import type { HealthMetrics } from '../../analyzers/types';

/** Canonical large-file threshold — file is "too large" at strictly
 *  more than this many lines. Mirror of the constant the generic-
 *  metrics gather already uses; documented as part of the file-size
 *  signal in the CLAUDE.md maintainability surface. */
export const LARGE_FILE_THRESHOLD_LINES = 500;

/**
 * Build `large-file` entries from the canonical `HealthMetrics`.
 * Files with `lines <= threshold` are skipped so the identity set
 * matches the user-facing aggregate count.
 */
export function largeFilesToBaselineEntries(metrics: HealthMetrics): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  for (const f of metrics.largestFiles) {
    if (f.lines <= LARGE_FILE_THRESHOLD_LINES) continue;
    const input: LargeFileIdentityInput = { kind: 'large-file', file: f.path };
    out.push({ id: identityFor(input), kind: 'large-file', file: f.path });
  }
  return out;
}
