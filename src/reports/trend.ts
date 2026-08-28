/**
 * The trend surface model (impact P3, the #332 read surface): pure helpers
 * that turn the report history into an honest score-over-time story. Three
 * consumers share them (Rule 2, one phrasing everywhere): the `report trend`
 * command, the guardrail Impact section's trend context line, and the
 * dashboard's overall sparkline.
 *
 * The comparability discipline is the projection's, reused, not re-derived:
 * two adjacent snapshots belong to one segment only when their
 * scoring-methodology stamps match AND `describeScoreInputsDrift` (the ONE
 * inputs comparator, `src/reports/history.ts`) sees no drift. A series is
 * never drawn across a boundary; the boundary itself is rendered, with its
 * reason. Unstamped pre-stamping entries group together but are marked
 * unverified: absent evidence is not comparability evidence (Rule 19).
 */
import {
  SCORE_KEYS,
  describeScoreInputsDrift,
  type DebtSeverity,
  type ReportHistoryEntry,
  type ReportScores,
} from './history';

// ─── Segmentation (the comparability discipline applied to a series) ──────

/** A maximal run of adjacent snapshots that are verifiably comparable to
 *  each other (same methodology stamp, same score inputs). */
export interface TrendSegment {
  readonly entries: ReadonlyArray<ReportHistoryEntry>;
  /** The segment's methodology stamp; absent when its entries predate
   *  stamping. */
  readonly methodology?: string;
  /** True when the segment's entries carry no methodology stamp: they group
   *  together (nothing says they differ) but their comparability is
   *  unverified, and every renderer says so. */
  readonly unverified?: true;
  /** Why this segment starts (the boundary vs the PREVIOUS segment's last
   *  entry). Absent on the first segment. */
  readonly boundary?: string;
}

/** The boundary reason between two adjacent snapshots, or null when they are
 *  comparable (the ONE adjacency predicate every trend consumer uses). */
export function describeTrendBoundary(
  prev: ReportHistoryEntry,
  next: ReportHistoryEntry,
): string | null {
  if (prev.methodology !== next.methodology) {
    const name = (m: string | undefined): string => (m === undefined ? 'unstamped' : `'${m}'`);
    return `scoring methodology changed (${name(prev.methodology)} to ${name(next.methodology)})`;
  }
  const drift = describeScoreInputsDrift(prev.scoreInputs, next.scoreInputs);
  return drift === null ? null : drift;
}

/** Split the history (chronological) into comparability segments. Empty
 *  input yields no segments. */
export function segmentHistory(entries: ReadonlyArray<ReportHistoryEntry>): TrendSegment[] {
  const segments: TrendSegment[] = [];
  let current: ReportHistoryEntry[] = [];
  let boundary: string | undefined;
  const flush = (): void => {
    if (current.length === 0) return;
    const methodology = current[0].methodology;
    segments.push({
      entries: current,
      ...(methodology !== undefined ? { methodology } : { unverified: true as const }),
      ...(boundary !== undefined ? { boundary } : {}),
    });
  };
  for (const entry of entries) {
    const prev = current[current.length - 1];
    const reason = prev !== undefined ? describeTrendBoundary(prev, entry) : null;
    if (reason !== null) {
      flush();
      current = [];
      boundary = reason;
    }
    current.push(entry);
  }
  flush();
  return segments;
}

// ─── Sparkline (no external deps, honest fixed scale for scores) ──────────

const SPARK_BLOCKS = '▁▂▃▄▅▆▇█';

/**
 * Render a numeric series as unicode block characters. Scores use the
 * default fixed 0..100 scale so a two-point wiggle never renders as a
 * mountain and sparklines are comparable across dimensions; count series
 * pass their own `max`. Null (unmeasured) renders as `·`, never as zero.
 */
export function sparkline(
  values: ReadonlyArray<number | null>,
  opts: { readonly max?: number } = {},
): string {
  const max = opts.max !== undefined && opts.max > 0 ? opts.max : 100;
  return values
    .map((v) => {
      if (v === null || !Number.isFinite(v)) return '·';
      const clamped = Math.max(0, Math.min(v, max));
      const idx = Math.min(
        SPARK_BLOCKS.length - 1,
        Math.floor((clamped / max) * SPARK_BLOCKS.length),
      );
      return SPARK_BLOCKS[idx];
    })
    .join('');
}

// ─── Series rows (the ONE model the CLI and the impact report render) ─────

/** One rendered series: a labeled value-per-snapshot array with its
 *  endpoints. Both trend presenters (the `report trend` console output and
 *  the published `latest/impact.md`) consume THIS shape, so the series
 *  logic exists once. */
export interface TrendSeriesRow {
  readonly key: string;
  readonly label: string;
  /** One value per snapshot in the segment; null = unmeasured at that
   *  snapshot (an older line predating the series), rendered as a gap. */
  readonly values: ReadonlyArray<number | null>;
  readonly first: number | null;
  readonly last: number | null;
  /** `last - first` when both are measured; null otherwise. */
  readonly delta: number | null;
  /** Sparkline scale max for count series; absent = the fixed 0..100
   *  score scale. */
  readonly max?: number;
}

/** Build one series row from a labeled value array. */
export function seriesRow(
  key: string,
  label: string,
  values: ReadonlyArray<number | null>,
  opts: { readonly countScale?: boolean } = {},
): TrendSeriesRow {
  const measured = values.filter((v): v is number => typeof v === 'number');
  const first = measured.length > 0 ? measured[0] : null;
  const last = measured.length > 0 ? measured[measured.length - 1] : null;
  return {
    key,
    label,
    values,
    first,
    last,
    delta: first !== null && last !== null ? last - first : null,
    ...(opts.countScale ? { max: Math.max(...measured, 1) } : {}),
  };
}

/** The dimension display list, derived from the ONE key list. */
export const TREND_DIMENSIONS: ReadonlyArray<{ key: keyof ReportScores; label: string }> =
  SCORE_KEYS.map((key) => ({
    key,
    label: {
      overall: 'overall',
      security: 'sec',
      quality: 'qual',
      tests: 'test',
      documentation: 'docs',
      maintainability: 'maint',
      developerExperience: 'dx',
    }[key],
  }));

/** Per-dimension score series for one segment's entries. */
export function dimensionRows(entries: ReadonlyArray<ReportHistoryEntry>): TrendSeriesRow[] {
  return TREND_DIMENSIONS.map(({ key, label }) =>
    seriesRow(
      key,
      label,
      entries.map((e) => e.scores[key]),
    ),
  );
}

/** The debt severity order for breakdown rendering. */
export const DEBT_SEVERITIES: ReadonlyArray<DebtSeverity> = ['critical', 'high', 'medium', 'low'];

/** Total count across severities for one kind's debt cell. */
export function debtKindTotal(cell: Readonly<Partial<Record<DebtSeverity, number>>>): number {
  return DEBT_SEVERITIES.reduce((sum, sev) => sum + (cell[sev] ?? 0), 0);
}

/** The debt kinds present anywhere in the series, in stable sorted order. */
export function debtKinds(entries: ReadonlyArray<ReportHistoryEntry>): string[] {
  const kinds = new Set<string>();
  for (const e of entries) for (const kind of Object.keys(e.debt ?? {})) kinds.add(kind);
  return [...kinds].sort();
}

/**
 * The debt-over-time series for one segment's entries: one row per kind
 * (total across severities), count-scaled. An entry without a debt stamp
 * (pre-4.4.7, or a run with no aggregate) AND an entry whose stamp lacks
 * the kind (its scanner did not observe that run, or the kind joined the
 * schema later) both contribute null: unmeasured, never zero. Zero is only
 * ever an explicitly stamped zero.
 */
export function debtRows(entries: ReadonlyArray<ReportHistoryEntry>): TrendSeriesRow[] {
  return debtKinds(entries).map((kind) =>
    seriesRow(
      `debt:${kind}`,
      kind,
      entries.map((e) => {
        // A kind ABSENT from a stamp is unmeasured (its scanner did not
        // observe, or the kind postdates this entry), never zero; only a
        // present cell (which stamps zeros explicitly) charts a number.
        const cell = e.debt?.[kind];
        return cell === undefined ? null : debtKindTotal(cell);
      }),
      { countScale: true },
    ),
  );
}

// ─── The trend context (the Impact section's one line) ────────────────────

/**
 * The trend summary a PR surface can print in one line. Directions are
 * computed WITHIN the latest comparability segment only; the anchor is the
 * first snapshot ON RECORD when the whole series is one comparable segment
 * (never claimed as "install": retention can truncate the record), else the
 * latest segment's start, disclosed.
 */
export interface TrendContext {
  /** Latest measured overall score in the latest segment (null when the
   *  segment never measured one). */
  readonly overall: number | null;
  /** First measured overall score in the latest segment. */
  readonly from: number | null;
  /** Net movement over the latest segment (first measured to last). */
  readonly direction: 'up' | 'down' | 'flat';
  /** ISO date (YYYY-MM-DD) of the latest segment's first snapshot. */
  readonly sinceDate: string;
  /** True when the latest segment reaches back to the FIRST SNAPSHOT ON
   *  RECORD (deliberately not "install": `reports.retain.history` can
   *  truncate the series, so the record's start is the only claim the
   *  data can back). */
  readonly sinceFirstSnapshot: boolean;
  /** Snapshots in the latest (comparable) segment. */
  readonly snapshots: number;
  /** Snapshots across the whole history. */
  readonly totalSnapshots: number;
  /** True when ANY adjacent within-segment pair (any segment) shows an
   *  overall increase: an improvement the record can already show. Cross-
   *  boundary increases do not count (they cannot be attributed to real
   *  movement). Feeds the "first improvement on record" claim. */
  readonly improvementOnRecord: boolean;
  /** The comparability caveat when the latest segment's entries carry no
   *  methodology stamp (comparability unverified). */
  readonly unverified?: true;
}

/** Compute the trend context from the full (chronological) history. Null
 *  when there is no history at all. */
export function computeTrendContext(
  entries: ReadonlyArray<ReportHistoryEntry>,
): TrendContext | null {
  if (entries.length === 0) return null;
  const segments = segmentHistory(entries);
  const latest = segments[segments.length - 1];
  const measured = latest.entries
    .map((e) => e.scores.overall)
    .filter((v): v is number => typeof v === 'number');
  const from = measured.length > 0 ? measured[0] : null;
  const overall = measured.length > 0 ? measured[measured.length - 1] : null;
  const net = from !== null && overall !== null ? overall - from : 0;
  // An improvement on record: any increase between consecutive MEASURED
  // overall values within one segment (the same null-skipping the direction
  // uses, so [24, null, 26] counts). Cross-boundary increases never count.
  let improvementOnRecord = false;
  for (const seg of segments) {
    const vals = seg.entries
      .map((e) => e.scores.overall)
      .filter((v): v is number => typeof v === 'number');
    for (let i = 1; i < vals.length && !improvementOnRecord; i++) {
      if (vals[i] > vals[i - 1]) improvementOnRecord = true;
    }
  }
  return {
    overall,
    from,
    direction: net > 0 ? 'up' : net < 0 ? 'down' : 'flat',
    sinceDate: latest.entries[0].date.slice(0, 10),
    sinceFirstSnapshot: segments.length === 1,
    snapshots: latest.entries.length,
    totalSnapshots: entries.length,
    improvementOnRecord,
    ...(latest.unverified ? { unverified: true as const } : {}),
  };
}

/**
 * The one trend-context phrasing (every surface composes this, none writes
 * its own):
 *
 *   - `Repo trend: overall 24, flat since 2026-07-20 (16 snapshots)`
 *   - up/down variants name both ends (`up from 24`), zero net is "flat"
 *   - a segmented series discloses the comparable window
 *     (`6 of 16 snapshots; earlier ones scored under different methodology
 *     or inputs`)
 *   - `projectedOverallDelta` > 0 with no improvement on record appends the
 *     first-improvement claim (the PR surface hands in the PROJECTED overall
 *     movement; the claim is conditional, "would be", never a fact).
 */
export function formatTrendContext(
  ctx: TrendContext,
  opts: { readonly projectedOverallDelta?: number | null } = {},
): string {
  const overall = ctx.overall === null ? 'unmeasured' : String(ctx.overall);
  const window = ctx.sinceFirstSnapshot
    ? `${ctx.totalSnapshots} snapshots`
    : `${ctx.snapshots} of ${ctx.totalSnapshots} snapshots; earlier ones scored under different methodology or inputs`;
  let line: string;
  if (ctx.snapshots === 1) {
    // A one-point window has no direction: say exactly what exists.
    line =
      ctx.totalSnapshots === 1
        ? `Repo trend: overall ${overall}, one snapshot on record (${ctx.sinceDate})`
        : `Repo trend: overall ${overall}, one comparable snapshot (${ctx.sinceDate}; ${window})`;
  } else if (ctx.overall === null) {
    // No measured overall in the window: no direction claim either.
    line = `Repo trend: overall unmeasured since ${ctx.sinceDate} (${window})`;
  } else {
    const movement =
      ctx.direction === 'up'
        ? `up from ${ctx.from}`
        : ctx.direction === 'down'
          ? `down from ${ctx.from}`
          : 'flat';
    line = `Repo trend: overall ${overall}, ${movement} since ${ctx.sinceDate} (${window})`;
  }
  if (ctx.unverified) {
    line += ' (methodology unstamped on these snapshots, comparability unverified)';
  }
  const projected = opts.projectedOverallDelta;
  if (!ctx.improvementOnRecord && typeof projected === 'number' && projected > 0) {
    line += '; this PR would be the first improvement on record';
  }
  return line;
}
