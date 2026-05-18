/**
 * Quality → baseline-entry producer.
 *
 * Two kinds today:
 *
 *   - `duplication` — jscpd-detected clone pairs from
 *     `CapabilityReport.duplication.topClones`. The clone detector
 *     emits each pair as `{ a: { file, ... }, b: { file, ... },
 *     tokens, lines }`; identity is `(fileA, fileB, tokens)` with file
 *     order normalized inside `identityFor` so reversed pairs hash
 *     identically.
 *
 *   - `stale-file` — `.swp`, `.bak`, `.orig`, `.tmp`, `.swo`, `.pyc`,
 *     `.log` files tracked in git. The producer accepts the file
 *     list directly (the orchestrator passes
 *     `gatherHygieneMarkers(cwd).staleFiles`) so the producer stays
 *     pure and the I/O lives in the canonical hygiene gather.
 *
 * Two kinds intentionally NOT produced yet:
 *
 *   - `god-file` — the `QualityMetrics.topGodFiles` field is
 *     forward-declared but no analyzer populates it today. Lights
 *     up when graphify surfaces per-file complexity offenders.
 *
 *   - `hygiene` — per-occurrence locations (file + line + marker
 *     kind) require extending `gatherHygieneMarkers` to emit
 *     positions, not just counts. Pending in a follow-up commit.
 */

import { identityFor } from '../finding-identity';
import type { BaselineEntry, DuplicationIdentityInput, StaleFileIdentityInput } from '../types';
import type { DuplicationResult } from '../../languages/capabilities/types';

/** Suffix set the hygiene gather flags as stale on-disk artifacts.
 *  Mirror of the shell glob in `gatherHygieneMarkers`; lives here
 *  so the producer can derive the per-file suffix without re-parsing
 *  the path. */
const STALE_SUFFIXES = new Set(['swp', 'swo', 'bak', 'orig', 'tmp', 'log', 'pyc']);

/** Build `duplication` entries from a jscpd-style envelope. */
export function duplicationToBaselineEntries(
  duplication: DuplicationResult | undefined,
): BaselineEntry[] {
  if (!duplication) return [];
  const out: BaselineEntry[] = [];
  for (const clone of duplication.topClones) {
    const input: DuplicationIdentityInput = {
      kind: 'duplication',
      fileA: clone.a.file,
      fileB: clone.b.file,
      lines: clone.lines,
      startLineA: clone.a.startLine,
      startLineB: clone.b.startLine,
    };
    out.push({
      id: identityFor(input),
      kind: 'duplication',
      fileA: clone.a.file,
      fileB: clone.b.file,
      lines: clone.lines,
      startLineA: clone.a.startLine,
      startLineB: clone.b.startLine,
    });
  }
  return out;
}

/**
 * Build `stale-file` entries from a list of repo-relative paths.
 * Files with a suffix outside the canonical stale set are skipped
 * (defensive — the caller's gather should already have filtered).
 */
export function staleFilesToBaselineEntries(staleFiles: ReadonlyArray<string>): BaselineEntry[] {
  const out: BaselineEntry[] = [];
  for (const file of staleFiles) {
    const dot = file.lastIndexOf('.');
    if (dot < 0) continue;
    const suffix = file.slice(dot + 1).toLowerCase();
    if (!STALE_SUFFIXES.has(suffix)) continue;
    const input: StaleFileIdentityInput = { kind: 'stale-file', file, suffix };
    out.push({ id: identityFor(input), kind: 'stale-file', file, suffix });
  }
  return out;
}
