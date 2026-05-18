/**
 * Tests → baseline-entry producer.
 *
 * Two kinds today:
 *
 *   - `test-gap` — non-test source files lacking a matching test, as
 *     reported by `analyzeTestGaps`. Each gap carries a risk tier
 *     (`critical | high | medium | low`); the tier is part of identity
 *     so a file moving between tiers (CRITICAL → HIGH, or vice
 *     versa) registers as a fresh finding rather than a silent
 *     persisted one — the right signal for "this file's testing
 *     situation got worse."
 *
 *   - `test-file-degradation` — test files present but not actively
 *     exercising the system under test (commented-out, empty body,
 *     schema-only stubs). The degradation status is part of identity
 *     for the same reason: a file moving from `'empty'` to
 *     `'schema-only'` is a different signal.
 *
 * Producer is pure over its input; the orchestrator calls
 * `analyzeTestGaps(cwd)` (which itself shares the canonical
 * `AnalysisResult` cache so it doesn't re-gather what the security
 * producer already triggered).
 */

import { identityFor } from '../finding-identity';
import type {
  BaselineEntry,
  TestFileDegradationIdentityInput,
  TestGapIdentityInput,
} from '../types';
import type { TestGapsReport } from '../../analyzers/tests/types';

/**
 * Build `test-gap` + `test-file-degradation` entries from a
 * `TestGapsReport`. Active test files (status: 'active') are not
 * emitted — they're the healthy case. Source files WITH a matching
 * test are not emitted — they're not a gap. Output preserves the
 * report's iteration order so re-runs against the same scan are
 * byte-stable.
 */
export function testGapsToBaselineEntries(report: TestGapsReport): BaselineEntry[] {
  const out: BaselineEntry[] = [];

  for (const gap of report.gaps) {
    // Defensive: `gaps` already excludes files with a matching test,
    // but guard anyway so a future report-shape change can't silently
    // double-up.
    if (gap.hasMatchingTest) continue;
    const input: TestGapIdentityInput = {
      kind: 'test-gap',
      file: gap.path,
      risk: gap.risk,
    };
    out.push({ id: identityFor(input), kind: 'test-gap', file: gap.path, risk: gap.risk });
  }

  for (const tf of report.testFiles) {
    if (tf.status === 'active') continue;
    const input: TestFileDegradationIdentityInput = {
      kind: 'test-file-degradation',
      file: tf.path,
      status: tf.status,
    };
    out.push({
      id: identityFor(input),
      kind: 'test-file-degradation',
      file: tf.path,
      status: tf.status,
    });
  }

  return out;
}
