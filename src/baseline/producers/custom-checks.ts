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
 * Content-hash scheme (the reformat-survival layer). Every LOCATED entry is
 * stamped with `contentHash` through the shared `contentStamper`: SHA-1[0:16]
 * of the whitespace-normalized 7-line window around the finding, read from the
 * file AT THE ANCHOR COMMIT (`git show <sha>:<file>`), the same scheme the
 * secret / code / config / duplication / stale-allow kinds use. The
 * git-aware matcher keys its content-hash pass on `(rule, contentHash)`; the
 * rule string for a custom-check pair is `check/rule` (or the bare check
 * label), minted identically on both sides by `entryToLocated`. So a
 * whole-file reindent, which moves every line past the 3-line identity window
 * AND rewrites every line in the diff (no line-map image for the git pass),
 * still pairs each grandfathered lint finding with its moved self instead of
 * reading as "resolved" plus "net-new".
 *
 * Migration: baselines written before this scheme carry no `contentHash` on
 * custom-check entries. That degrades to exactly the pre-scheme behavior (the
 * matcher skips a side without a hash; the git and identity passes still
 * run), so no migration step and no rescan are needed. The next baseline
 * refresh stamps the entries.
 *
 * BINARY findings (no `file`) are whole-command pass/fail with no location;
 * they carry no hash by construction.
 */

import { contentStamper, type ContentStampSource } from '../content-stamp';
import { identityFor } from '../finding-identity';
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import type { RichBaselineEntry } from '../types';

export function customCheckFindingsToBaselineEntries(
  findings: readonly CustomCheckFinding[],
  commit?: ContentStampSource,
): RichBaselineEntry[] {
  const stamp = contentStamper(commit);
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
      continue;
    }
    const contentHash =
      f.file !== undefined && f.line !== undefined ? stamp(f.file, f.line) : undefined;
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
        ...(contentHash !== undefined ? { contentHash } : {}),
      },
    });
  }
  return [...byId.values()].map(({ entry, occurrences }) =>
    occurrences > 1 && 'message' in entry && entry.message !== undefined
      ? { ...entry, message: `${entry.message} (${occurrences} occurrences in this line window)` }
      : entry,
  );
}
