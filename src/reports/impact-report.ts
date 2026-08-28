/**
 * The published impact report (`latest/impact.md` on the `dxkit-reports`
 * anchor, 4.4.7): the shareable score-trend + debt-over-time story, rendered
 * per merge by the snapshot publisher from the SAME folded history it writes.
 *
 * One renderer core, two presenters (Rule 2): every series here comes from
 * the trend module's helpers (`segmentHistory`, `dimensionRows`, `debtRows`,
 * `sparkline`, `computeTrendContext`, `formatTrendContext`), the same core
 * the `report trend` CLI renders; this file only lays them out as markdown.
 *
 * Honesty rules, inherited, not restated: series are segmented at scoring
 * methodology / score-input boundaries and a line is never drawn across one
 * (each boundary renders with its reason); an unmeasured point renders as a
 * gap, never as zero; the latest-merge delta is computed only between the
 * last two COMPARABLE entries. Sanitized by construction: the history holds
 * counts and scores only, so no file path, finding title, or secret-shaped
 * value can reach this page. Deterministic for identical input (no clocks,
 * no environment reads).
 */
import { latestDeltas, type ReportHistoryEntry } from './history';
import { deltaToken } from './render';
import {
  computeTrendContext,
  debtRows,
  dimensionRows,
  formatTrendContext,
  segmentHistory,
  sparkline,
  DEBT_SEVERITIES,
  type TrendSegment,
  type TrendSeriesRow,
} from './trend';

/** Where the report lives on the anchor ref, beside the other `latest/`
 *  artifacts (`git show <reports-ref>:latest/impact.md`, or the anchor
 *  reader). */
export const IMPACT_REPORT_PATH = 'latest/impact.md';

function score(v: number | null): string {
  return v == null ? '—' : String(v);
}

function segmentHeading(seg: TrendSegment): string {
  const from = seg.entries[0].date.slice(0, 10);
  const to = seg.entries[seg.entries.length - 1].date.slice(0, 10);
  const method = seg.unverified
    ? 'methodology unstamped, comparability unverified'
    : `methodology ${seg.methodology}`;
  const n = seg.entries.length;
  return `${from} to ${to} (${n} snapshot${n === 1 ? '' : 's'}, ${method})`;
}

function seriesTable(rows: ReadonlyArray<TrendSeriesRow>): string[] {
  const lines = ['| Series | Trend | First | Latest | Δ |', '| --- | --- | ---: | ---: | :--- |'];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | \`${sparkline(r.values, r.max !== undefined ? { max: r.max } : {})}\` | ` +
        `${score(r.first)} | ${score(r.last)} | ${deltaToken(r.delta) || '—'} |`,
    );
  }
  return lines;
}

/**
 * The latest merge's movement, honestly scoped: the delta between the last
 * two entries ONLY when they sit in the same comparability segment;
 * otherwise the boundary is named instead of a number.
 */
function latestMergeLines(segments: ReadonlyArray<TrendSegment>): string[] {
  const latest = segments[segments.length - 1];
  if (latest.entries.length >= 2) {
    const { cur, deltas } = latestDeltas(latest.entries);
    const moved = deltas.filter((d) => d.key !== 'overall' && d.delta !== null && d.delta !== 0);
    const overall = deltas.find((d) => d.key === 'overall');
    const overallLine =
      overall && overall.delta !== null
        ? `overall ${score(overall.from)} to ${score(overall.to)} (${deltaToken(overall.delta) || '='})`
        : 'overall unmeasured';
    const movedLine =
      moved.length > 0
        ? moved.map((d) => `${d.key} ${score(d.from)} to ${score(d.to)}`).join(', ')
        : 'no dimension moved';
    return [`Latest merge \`${cur!.sha.slice(0, 12)}\`: ${overallLine}; ${movedLine}.`];
  }
  // One entry in the latest segment: either the very first snapshot, or the
  // first one after a boundary. Say which; never diff across the boundary.
  if (segments.length === 1) {
    return ['Latest merge is the first snapshot on record; movement starts with the next one.'];
  }
  return [
    'Latest merge is not comparable to the previous snapshot ' +
      `(${latest.boundary ?? 'comparability boundary'}); movement resumes with the next one.`,
  ];
}

/** Severity breakdown of the latest debt stamp, or null when unmeasured. */
function latestDebtBreakdown(entries: ReadonlyArray<ReportHistoryEntry>): string[] | null {
  const latest = [...entries].reverse().find((e) => e.debt !== undefined);
  if (!latest?.debt) return null;
  const kinds = Object.keys(latest.debt).sort();
  if (kinds.length === 0) return null;
  const lines = [
    `| Debt kind | ${DEBT_SEVERITIES.join(' | ')} |`,
    `| --- | ${DEBT_SEVERITIES.map(() => '---:').join(' | ')} |`,
  ];
  for (const kind of kinds) {
    const cell = latest.debt[kind] ?? {};
    lines.push(`| ${kind} | ${DEBT_SEVERITIES.map((s) => cell[s] ?? 0).join(' | ')} |`);
  }
  return lines;
}

/**
 * Render the full impact report from the (chronological) history. Pure and
 * deterministic; empty history renders the honest empty state.
 */
export function renderImpactReportMarkdown(entries: ReadonlyArray<ReportHistoryEntry>): string {
  const lines: string[] = ['# dxkit impact report', ''];
  if (entries.length === 0) {
    lines.push('_No snapshots yet. The first `report snapshot` starts the series._', '');
    return lines.join('\n');
  }
  const segments = segmentHistory(entries);
  const context = computeTrendContext(entries);
  const first = entries[0];
  const last = entries[entries.length - 1];

  lines.push(
    `_Scores and finding counts per merge, since install (${first.date.slice(0, 10)}), ` +
      `${entries.length} snapshot${entries.length === 1 ? '' : 's'} through ` +
      `\`${last.sha.slice(0, 12)}\` (${last.date.slice(0, 10)}). Counts and scores only._`,
    '',
  );
  if (context !== null) {
    lines.push(formatTrendContext(context), '');
  }

  lines.push(...latestMergeLines(segments), '');

  lines.push('## Score trend since install', '');
  segments.forEach((seg, i) => {
    if (seg.boundary !== undefined) {
      lines.push(
        `> Comparability boundary: ${seg.boundary}. Scores are not compared across it.`,
        '',
      );
    }
    if (segments.length > 1) {
      lines.push(`### Segment ${i + 1}: ${segmentHeading(seg)}`, '');
    }
    const rows = dimensionRows(seg.entries);
    const unmeasured = rows.filter((r) => r.first === null && r.last === null);
    lines.push(...seriesTable(rows.filter((r) => !unmeasured.includes(r))), '');
    if (unmeasured.length > 0) {
      lines.push(`_Unmeasured in this window: ${unmeasured.map((r) => r.label).join(', ')}._`, '');
    }
  });

  lines.push('## Debt over time', '');
  const debt = debtRows(entries);
  if (debt.length === 0) {
    lines.push(
      '_No debt series yet: these snapshots predate the per-kind debt counts. ' +
        'The next merge snapshot starts it._',
      '',
    );
  } else {
    // The debt series spans the WHOLE history on purpose: counts are not
    // score-methodology-dependent, so one series is honest; entries without
    // a stamp chart as gaps.
    lines.push(...seriesTable(debt), '');
    if (entries.some((e) => e.debt === undefined)) {
      lines.push(
        '_Snapshots without a debt stamp (older dxkit versions) chart as gaps, not zero._',
        '',
      );
    }
    const breakdown = latestDebtBreakdown(entries);
    if (breakdown !== null) {
      lines.push('Latest severity breakdown:', '', ...breakdown, '');
    }
  }

  lines.push(
    `_Generated by dxkit ${last.dxkitVersion} at snapshot \`${last.sha.slice(0, 12)}\`; ` +
      'series segmented at scoring-methodology and score-input boundaries._',
    '',
  );
  return lines.join('\n');
}
