/**
 * `vyuh-dxkit metrics [path] [--since <ref|date>] [--json]` — the champion's
 * ROI report (#33 Layer 1).
 *
 * Reads the append-only loop ledger (`.dxkit/loop/ledger.jsonl`) and reports
 * what the gate STOPPED: net-new findings intercepted before merge, per week,
 * by category. The headline number is interceptions — a count of events the
 * guardrail actually blocked, so it can't be inflated. `--since` scopes the
 * window to a git ref (resolved to its commit date) or an ISO date, for a
 * "since we adopted dxkit" / "this quarter" cut.
 *
 * A thin renderer over the pure reducer in `src/loop/metrics.ts`; the ledger
 * read + `--since` resolution are the only I/O here.
 */
import { execFileSync } from 'child_process';
import * as logger from './logger';
import { readLedger } from './loop/ledger';
import { computeMetrics, type MetricsReport } from './loop/metrics';
import { readReportHistory } from './reports/snapshot';
import { renderTrendText } from './reports/render';
import { latestDeltas, type ReportHistoryEntry } from './reports/history';
import { loadPolicyFromCwd } from './baseline/policy';

export interface MetricsOptions {
  /** A git ref (resolved to its commit date) or an ISO date; scopes the window. */
  readonly since?: string;
  readonly json?: boolean;
}

export async function runMetrics(cwd: string, opts: MetricsOptions = {}): Promise<void> {
  const events = readLedger(cwd);
  const since = resolveSince(cwd, opts.since);
  const report = computeMetrics(events, { sinceMs: since.ms });
  // The score-over-time trend (published on merge to the dxkit-reports ref) is
  // the OUTCOME half of ROI — what the gate blocked (ledger) plus how the score
  // actually moved. Only read it when the repo has a `reports` policy: the read
  // does a `git fetch` of the anchor ref, and `metrics` must stay a local,
  // offline-friendly command for the (common) repo that never enabled reports.
  const usesReports = Object.keys(loadPolicyFromCwd(cwd).reports ?? {}).length > 0;
  const trend = usesReports ? readReportHistory(cwd) : [];

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'metrics.v1',
          since: since.label ?? null,
          ...report,
          trend: trendJson(trend),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  render(report, since);
  renderTrend(trend);
}

/** Compact JSON view of the trend: the full series plus the latest merge's
 *  per-dimension movement (the "score moved X→Y" the renderers show). */
function trendJson(entries: readonly ReportHistoryEntry[]): {
  snapshots: number;
  latest: ReportHistoryEntry | null;
  deltas: ReturnType<typeof latestDeltas>['deltas'];
} {
  const { cur, deltas } = latestDeltas(entries);
  return { snapshots: entries.length, latest: cur ?? null, deltas };
}

function renderTrend(entries: readonly ReportHistoryEntry[]): void {
  const lines = renderTrendText(entries);
  if (lines.length === 0) return;
  gap();
  logger.header('Score over time');
  logger.info(lines[0]);
  for (const l of lines.slice(1)) logger.dim(l);
  gap();
  logger.dim('Published on merge to the `dxkit-reports` ref (policy.json:reports.onMerge).');
  logger.dim('Full trend: `vyuh-dxkit report history`.');
}

interface ResolvedSince {
  /** Epoch ms cutoff, or undefined for all-history. */
  readonly ms?: number;
  /** Human label of what `--since` resolved to (for the header). */
  readonly label?: string;
  /** Non-fatal note when `--since` couldn't be resolved (ignored → all history). */
  readonly warning?: string;
}

/** Resolve `--since` to an epoch-ms cutoff. Accepts an ISO date directly, else
 *  treats the value as a git ref and reads its committer date. An unresolvable
 *  value is a soft failure: no filter, with a note. */
function resolveSince(cwd: string, since?: string): ResolvedSince {
  const raw = since?.trim();
  if (!raw) return {};

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return { ms: asDate, label: `date ${raw}` };
  }

  try {
    const iso = execFileSync('git', ['show', '-s', '--format=%cI', raw], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return { ms, label: `${raw} (${iso.slice(0, 10)})` };
  } catch {
    // fall through
  }
  return {
    warning: `could not resolve --since \`${raw}\` as a date or git ref — reporting all history`,
  };
}

/** A clean blank separator line (plain `logger.info('')` prints a stray arrow). */
function gap(): void {
  process.stdout.write('\n');
}

function render(r: MetricsReport, since: ResolvedSince): void {
  logger.header('dxkit metrics — findings stopped before merge');
  if (since.warning) logger.warn(since.warning);

  if (r.events === 0) {
    logger.info('No loop-gate activity recorded yet.');
    logger.dim(
      '  The ledger fills as the guardrail runs in an autonomous loop (Stop-gate) — ' +
        'run `vyuh-dxkit loop doctor` to confirm wiring.',
    );
    return;
  }

  const window =
    since.label !== undefined
      ? `since ${since.label}`
      : r.span.from
        ? `${r.span.from.slice(0, 10)} → ${(r.span.to ?? r.span.from).slice(0, 10)}`
        : 'all history';
  logger.dim(`  Window: ${window} · ${r.events} gate event(s)`);

  gap();
  logger.info(`${logger.bold(String(r.interceptions))} findings intercepted (blocked pre-merge)`);
  logger.dim(`  across ${r.blockedCompletions} blocked completion(s)`);
  if (r.warnings > 0) logger.dim(`  ${r.warnings} warning(s) surfaced (non-blocking)`);
  logger.dim(`  ${r.cleanStops} clean stop(s)`);
  if (r.repairedAfterBlock > 0 || r.unrepairedSessions > 0) {
    logger.dim(
      `  repaired after a block: ${r.repairedAfterBlock} session(s)` +
        (r.unrepairedSessions > 0 ? ` · ${r.unrepairedSessions} left unrepaired` : ''),
    );
  }

  if (r.blockedByCategory.length > 0) {
    gap();
    logger.info('Intercepted by category:');
    for (const c of r.blockedByCategory) logger.dim(`  ${c.category.padEnd(16)} ${c.count}`);
    if (r.eventsMissingCategoryData > 0) {
      logger.dim(
        `  (${r.eventsMissingCategoryData} older event(s) counted but not attributable to a category)`,
      );
    }
  }

  if (r.warnedByCategory.length > 0) {
    gap();
    logger.info('Warned by category:');
    for (const c of r.warnedByCategory) logger.dim(`  ${c.category.padEnd(16)} ${c.count}`);
  }

  if (r.weekly.length > 0) {
    gap();
    logger.info('Weekly interception series:');
    logger.dim(
      `  ${'week'.padEnd(10)} ${'intercepted'.padStart(11)}  ${'blocked'.padStart(7)}  ${'warned'.padStart(6)}  ${'clean'.padStart(5)}`,
    );
    for (const w of r.weekly) {
      logger.dim(
        `  ${w.week.padEnd(10)} ${String(w.interceptions).padStart(11)}  ${String(w.blocked).padStart(7)}  ${String(w.warned).padStart(6)}  ${String(w.clean).padStart(5)}`,
      );
    }
  }

  gap();
  logger.dim('Interceptions are the ungameable ROI number — findings the gate stopped that');
  logger.dim('would otherwise have reached the base branch. `--json` for a dashboard feed.');
}
