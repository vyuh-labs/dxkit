/**
 * Pure presentation of the report-history trend — the "score moved X→Y" surfaces
 * that make the on-merge snapshots (src/reports/snapshot.ts) actually deliver
 * value. Two renderers, ONE delta primitive (`latestDeltas` in history.ts):
 *
 * - `renderHistoryMarkdown` → a GitHub-flavored block for `$GITHUB_STEP_SUMMARY`
 *   (the reports-refresh workflow appends it after each merge) or a PR comment.
 * - `renderTrendText` → a compact terminal section `vyuh-dxkit metrics` prints
 *   under the interception ROI, so the champion report shows BOTH what the gate
 *   blocked and how the score moved.
 *
 * Pure (no I/O): the CLI + workflow read `report-history.jsonl` off the
 * `dxkit-reports` anchor and hand the parsed entries in.
 */
import { SCORE_KEYS, latestDeltas, type ReportHistoryEntry, type ReportScores } from './history';

const DIM_LABELS: Record<keyof ReportScores, string> = {
  overall: 'Overall',
  security: 'Security',
  quality: 'Quality',
  tests: 'Tests',
  documentation: 'Docs',
  maintainability: 'Maintainability',
  developerExperience: 'Developer Experience',
};

function score(v: number | null): string {
  return v == null ? '—' : String(v);
}

/** A signed movement token: `▲3` / `▼2` / `=` / '' when there is no comparable
 *  prior. Text + markdown share it so the arrow convention is identical. */
export function deltaToken(delta: number | null): string {
  if (delta == null) return '';
  if (delta > 0) return `▲${delta}`;
  if (delta < 0) return `▼${Math.abs(delta)}`;
  return '=';
}

/** Headline sentence for the latest merge's overall movement. */
function overallHeadline(entries: readonly ReportHistoryEntry[]): string {
  const { prev, cur, deltas } = latestDeltas(entries);
  if (!cur) return 'No report snapshots yet.';
  const overall = deltas.find((d) => d.key === 'overall');
  const now = score(cur.scores.overall);
  if (!prev || !overall || overall.delta == null) {
    return `Overall health: **${now}**`;
  }
  return `Overall health: **${score(overall.from)} → ${now}** (${deltaToken(overall.delta)})`;
}

export interface TrendRenderOptions {
  /** Cap the recent-snapshot table to the last N entries (default 10). */
  readonly limit?: number;
}

/**
 * GitHub-flavored markdown: a headline, a per-dimension delta table for the
 * latest merge, and a compact recent-overall trend. Suitable for
 * `$GITHUB_STEP_SUMMARY` and PR comments. Never throws on empty input.
 */
export function renderHistoryMarkdown(
  entries: readonly ReportHistoryEntry[],
  opts: TrendRenderOptions = {},
): string {
  if (entries.length === 0) {
    return '### dxkit — score over time\n\n_No report snapshots on the `dxkit-reports` ref yet._\n';
  }
  const { prev, cur, deltas } = latestDeltas(entries);
  const lines: string[] = ['### dxkit — score over time', '', overallHeadline(entries), ''];

  // Per-dimension movement for the latest merge.
  lines.push('| Dimension | Previous | Now | Δ |', '| --- | ---: | ---: | :--- |');
  for (const key of SCORE_KEYS) {
    const d = deltas.find((x) => x.key === key)!;
    lines.push(
      `| ${DIM_LABELS[key]} | ${prev ? score(d.from) : '—'} | ${score(d.to)} | ${deltaToken(d.delta) || '—'} |`,
    );
  }

  // Compact recent trend (most-recent last), so the table reads left→right in time.
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const recent = entries.slice(-limit);
  if (recent.length > 1) {
    lines.push('', '<details><summary>Recent snapshots</summary>', '');
    lines.push('| Date | Commit | Overall |', '| --- | --- | ---: |');
    for (const e of recent) {
      lines.push(
        `| ${e.date.slice(0, 10)} | \`${e.sha.slice(0, 12)}\` | ${score(e.scores.overall)} |`,
      );
    }
    lines.push('', '</details>');
  }
  lines.push(
    '',
    `_${cur!.dxkitVersion ? `dxkit ${cur!.dxkitVersion} · ` : ''}${entries.length} snapshot(s) on \`dxkit-reports\`._`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Compact terminal lines for `metrics`: the latest merge's per-dimension
 * movement plus a short overall series. Returns an array of already-formatted
 * lines (the caller dims/prints them); empty array when there is no history.
 */
export function renderTrendText(
  entries: readonly ReportHistoryEntry[],
  opts: TrendRenderOptions = {},
): string[] {
  if (entries.length === 0) return [];
  const { prev, cur, deltas } = latestDeltas(entries);
  const out: string[] = [];
  out.push(overallHeadline(entries).replace(/\*\*/g, ''));

  if (prev) {
    // Only the dimensions that actually moved, so the line stays short.
    const moved = deltas.filter((d) => d.delta != null && d.delta !== 0);
    if (moved.length > 0) {
      out.push(
        '  moved: ' +
          moved.map((d) => `${DIM_LABELS[d.key].toLowerCase()} ${deltaToken(d.delta)}`).join(' · '),
      );
    } else {
      out.push('  no dimension moved since the previous snapshot');
    }
  }

  const limit = opts.limit && opts.limit > 0 ? opts.limit : 6;
  const recent = entries.slice(-limit);
  if (recent.length > 1) {
    out.push(
      '  overall: ' +
        recent.map((e) => `${e.date.slice(5, 10)} ${score(e.scores.overall)}`).join('  '),
    );
  }
  void cur;
  return out;
}
