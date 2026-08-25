/**
 * Custom-check → baseline-entry producer.
 *
 * Turns the failures the custom-check runner captured (user-declared checks +
 * built-in lint) into `custom-check` baseline entries, so a PRE-EXISTING check
 * failure is grandfathered and only a NET-NEW one gates. Identity comes from the
 * canonical `identityFor` (Rule 9): located findings hash (check, file,
 * lineWindow, rule); binary findings hash the check name.
 *
 * The findings are gathered ONCE by the orchestrator (into
 * `ProducerContext.customCheckFindings`) and passed here — this producer is a
 * pure map apart from the best-effort content-hash read, never a shell-out.
 *
 * Content-hash stamping lives in the orchestrator (`stampEntries` in
 * content-stamp.ts): this producer emits bare entries. Within one identity
 * bucket (the shared 3-line window) the entry records the MINIMUM reported
 * line, so the stamped window is independent of the linter's output order
 * (two occurrences reported in either order yield one hash).
 *
 * Migration: baselines written before the stamp scheme carry no
 * `contentHash` on custom-check entries. The matcher degrades to the git
 * and identity passes, and the update/migrate lane restamps them at the
 * baseline's anchor commit (`restampAtCommit`).
 *
 * BINARY findings (no `file`) are whole-command pass/fail with no location;
 * they carry no hash by construction.
 */

import { identityFor } from '../finding-identity';
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import type { RichBaselineEntry } from '../types';

export function customCheckFindingsToBaselineEntries(
  findings: readonly CustomCheckFinding[],
): RichBaselineEntry[] {
  // ONE entry per identity. Located identity buckets lines into the shared
  // 3-line window (Rule 9), so a linter reporting the same rule on adjacent
  // lines mints the SAME fingerprint N times — and the multiset survived
  // into the verdict: a real PR was reported as "206 new regressions" over
  // 137 unique fingerprints (69 duplicate rows), inflating the headline by
  // 50%. The fingerprint is the gate's unit (the allowlist waives by
  // fingerprint), so it is the count's unit too; extra occurrences inside
  // one window are disclosed on the entry, never counted as findings.
  const byId = new Map<string, { entry: RichBaselineEntry; occurrences: number }>();
  for (const f of findings) {
    const id = identityFor({
      kind: 'custom-check',
      check: f.check,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.rule !== undefined ? { rule: f.rule } : {}),
    });
    const hit = byId.get(id);
    if (hit) {
      hit.occurrences += 1;
      // Minimum-line rule: the bucket's recorded line (and thus the stamped
      // window) must not depend on which occurrence the linter printed first.
      if (
        f.line !== undefined &&
        'line' in hit.entry &&
        typeof hit.entry.line === 'number' &&
        f.line < hit.entry.line
      ) {
        hit.entry = { ...hit.entry, line: f.line };
      }
      continue;
    }
    byId.set(id, {
      occurrences: 1,
      entry: {
        id,
        kind: 'custom-check' as const,
        check: f.check,
        blocking: f.blocking,
        ...(f.file !== undefined ? { file: f.file } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.rule !== undefined ? { rule: f.rule } : {}),
        ...(f.message !== undefined ? { message: f.message } : {}),
      },
    });
  }
  return [...byId.values()].map(({ entry, occurrences }) =>
    occurrences > 1 && 'message' in entry && entry.message !== undefined
      ? { ...entry, message: `${entry.message} (${occurrences} occurrences in this line window)` }
      : entry,
  );
}
