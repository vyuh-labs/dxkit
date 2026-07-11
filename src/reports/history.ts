/**
 * Report-history record + the pure JSONL codec behind `report snapshot` /
 * `report history`. ONE append-only line per merge is the durable score-over-time
 * primitive: point-in-time reports + the per-session ledger already exist, but
 * nothing tracked dimension scores ACROSS merges. This module is pure (no I/O);
 * the snapshot publisher reads the existing JSONL off the `dxkit-reports` anchor,
 * folds a new entry in here, and hands the serialized result to the anchor
 * writer. `report history` parses it back to render the trend.
 *
 * Forward-compatible: unknown fields on a line are preserved through parse →
 * serialize is NOT attempted (we re-emit our known shape), but the parser
 * tolerates extra keys and skips malformed lines rather than throwing, so a
 * newer dxkit's richer entries never break an older reader.
 */

/** The six dimension scores + the overall, as integers 0–100 (or null when a
 *  dimension was unmeasured at that merge). */
export interface ReportScores {
  readonly overall: number | null;
  readonly security: number | null;
  readonly quality: number | null;
  readonly tests: number | null;
  readonly documentation: number | null;
  readonly maintainability: number | null;
  readonly developerExperience: number | null;
}

/** Optional coarse finding counts, for a "findings over time" secondary series. */
export interface ReportFindingCounts {
  readonly secretsCritical?: number;
  readonly securityHigh?: number;
  readonly depVulnsHigh?: number;
  readonly testGaps?: number;
}

/** One merge's snapshot line on the `dxkit-reports` anchor. */
export interface ReportHistoryEntry {
  /** Merge commit SHA this snapshot was computed at — the entry's identity. */
  readonly sha: string;
  /** ISO-8601 timestamp the snapshot was generated (passed in; never `Date.now`
   *  inside pure code). */
  readonly date: string;
  readonly dxkitVersion: string;
  /** Branch the merge landed on (default branch), for multi-branch repos. */
  readonly branch?: string;
  readonly scores: ReportScores;
  readonly findings?: ReportFindingCounts;
  /** Extension inventory entity counts (extension name → entity kind →
   *  count), captured from committed inventory.v1 snapshots at snapshot
   *  time. Additive: absent for repos without inventory extensions, and
   *  older dxkit readers ignore it. Counts only — the committed snapshot
   *  (with git history) remains the per-entity store. */
  readonly inventory?: Record<string, Record<string, number>>;
}

/** The score keys, in canonical display order — the ONE list every consumer
 *  iterates (parse, delta, render), so a new dimension is added in one place. */
export const SCORE_KEYS: ReadonlyArray<keyof ReportScores> = [
  'overall',
  'security',
  'quality',
  'tests',
  'documentation',
  'maintainability',
  'developerExperience',
];

function isFiniteNumberOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

function coerceScores(raw: unknown): ReportScores | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  for (const k of SCORE_KEYS) {
    const v = o[k];
    if (!isFiniteNumberOrNull(v)) return null; // a malformed score line is skipped whole
    out[k] = v;
  }
  return out as unknown as ReportScores;
}

/** Parse a JSONL blob into entries, skipping blank + malformed lines (a newer
 *  or corrupt line never breaks an older reader). */
export function parseHistory(jsonl: string | null | undefined): ReportHistoryEntry[] {
  if (!jsonl) return [];
  const out: ReportHistoryEntry[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // corrupt line — skip, don't throw
    }
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    const scores = coerceScores(o.scores);
    if (typeof o.sha !== 'string' || typeof o.date !== 'string' || !scores) continue;
    const entry: ReportHistoryEntry = {
      sha: o.sha,
      date: o.date,
      dxkitVersion: typeof o.dxkitVersion === 'string' ? o.dxkitVersion : 'unknown',
      ...(typeof o.branch === 'string' ? { branch: o.branch } : {}),
      scores,
      ...(o.findings && typeof o.findings === 'object'
        ? { findings: o.findings as ReportFindingCounts }
        : {}),
      ...(o.inventory && typeof o.inventory === 'object'
        ? { inventory: o.inventory as Record<string, Record<string, number>> }
        : {}),
    };
    out.push(entry);
  }
  return out;
}

/** One dimension's movement between two snapshots. `delta` is `to - from` only
 *  when both sides are measured; a null on either side leaves `delta` null (an
 *  unmeasured dimension has no honest movement). */
export interface ScoreDelta {
  readonly key: keyof ReportScores;
  readonly from: number | null;
  readonly to: number | null;
  readonly delta: number | null;
}

/** Per-dimension movement from `prev` scores to `cur` scores. Pure. When `prev`
 *  is undefined (the first-ever snapshot) every `from`/`delta` is null. */
export function scoreDeltas(prev: ReportScores | undefined, cur: ReportScores): ScoreDelta[] {
  return SCORE_KEYS.map((key) => {
    const to = cur[key];
    const from = prev ? prev[key] : null;
    const delta = typeof from === 'number' && typeof to === 'number' ? to - from : null;
    return { key, from, to, delta };
  });
}

/** The movement of the most recent merge vs the one before it — the "score moved
 *  X→Y" primitive both the CI job summary and `metrics` read. With <2 entries
 *  there is no prior, so `prev` is undefined and every delta is null. Pure. */
export function latestDeltas(entries: readonly ReportHistoryEntry[]): {
  readonly prev?: ReportHistoryEntry;
  readonly cur?: ReportHistoryEntry;
  readonly deltas: ScoreDelta[];
} {
  if (entries.length === 0) return { deltas: [] };
  const cur = entries[entries.length - 1];
  const prev = entries.length >= 2 ? entries[entries.length - 2] : undefined;
  return { ...(prev ? { prev } : {}), cur, deltas: scoreDeltas(prev?.scores, cur.scores) };
}

/** Serialize entries to JSONL (one compact object per line, trailing newline). */
export function serializeHistory(entries: readonly ReportHistoryEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

/**
 * Fold `entry` into `existing`: replace any prior entry for the same SHA
 * (idempotent re-runs of one merge), keep chronological append order otherwise,
 * then retain only the most recent `retain` entries. `retain <= 0` keeps all.
 * Pure — returns a new array.
 */
export function foldEntry(
  existing: readonly ReportHistoryEntry[],
  entry: ReportHistoryEntry,
  retain: number,
): ReportHistoryEntry[] {
  const withoutDup = existing.filter((e) => e.sha !== entry.sha);
  const merged = [...withoutDup, entry];
  if (retain > 0 && merged.length > retain) {
    return merged.slice(merged.length - retain);
  }
  return merged;
}
