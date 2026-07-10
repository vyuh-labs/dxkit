/**
 * `vyuh-dxkit report snapshot` + `report history` — publish a per-merge score
 * snapshot to the `dxkit-reports` anchor and read the trend back. The publish
 * pipeline (map → fold → anchor write) is `src/reports/snapshot.ts`; this module
 * is the thin CLI adapter: gather the authoritative scores (`analyzeHealth`),
 * pick up the already-rendered `.dxkit/reports/` artifacts, resolve the anchor +
 * retention from `policy.json:reports`, and call the publisher. The on-merge
 * workflow runs `report` (to render the dashboard) then `report snapshot`.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { VERSION } from './constants';
import { analyzeHealth } from './analyzers/health';
import {
  reportToHistoryEntry,
  publishReportSnapshot,
  readReportHistory,
  DEFAULT_REPORTS_REF,
  type SnapshotArtifact,
} from './reports/snapshot';
import type { ReportHistoryEntry } from './reports/history';
import { loadPolicyFromCwd, type ReportsPolicy } from './baseline/policy';
import * as logger from './logger';

/** The repo's `policy.json:reports` block (opt-in), via the one policy loader. */
function readReportsPolicy(cwd: string): ReportsPolicy {
  return loadPolicyFromCwd(cwd).reports ?? {};
}

function gitLine(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/** Collect the `latest/` artifacts already rendered under `.dxkit/reports/`. */
function collectArtifacts(cwd: string): SnapshotArtifact[] {
  const reportsDir = path.join(cwd, '.dxkit', 'reports');
  const out: SnapshotArtifact[] = [];
  const dash = path.join(reportsDir, 'dashboard.html');
  if (fs.existsSync(dash))
    out.push({ path: 'dashboard.html', content: fs.readFileSync(dash, 'utf8') });
  // Newest health-audit markdown, if any.
  try {
    const md = fs
      .readdirSync(reportsDir)
      .filter((f) => /^health-audit-.*\.md$/.test(f) && !f.includes('detailed'))
      .sort()
      .pop();
    if (md)
      out.push({ path: 'health.md', content: fs.readFileSync(path.join(reportsDir, md), 'utf8') });
  } catch {
    /* no reports dir */
  }
  return out;
}

export interface ReportSnapshotOptions {
  readonly cwd: string;
  readonly anchorRef?: string;
  readonly retainHistory?: number;
  readonly json?: boolean;
  /** Compute + print the entry but do not publish (no push). */
  readonly dryRun?: boolean;
  /** ISO timestamp override (tests / determinism). */
  readonly now?: string;
}

export async function runReportSnapshot(opts: ReportSnapshotOptions): Promise<number> {
  const { cwd } = opts;
  const policy = readReportsPolicy(cwd);
  const anchorRef = opts.anchorRef ?? policy.anchorRef ?? DEFAULT_REPORTS_REF;
  const retainHistory = opts.retainHistory ?? policy.retain?.history ?? 0;

  const report = await analyzeHealth(cwd);
  const sha = gitLine(cwd, ['rev-parse', 'HEAD']) || 'unknown';
  const branch = gitLine(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  const date = opts.now ?? new Date().toISOString();

  const entry = reportToHistoryEntry(report, {
    sha,
    date,
    dxkitVersion: VERSION,
    ...(branch ? { branch } : {}),
  });
  const artifacts = collectArtifacts(cwd);

  if (opts.dryRun) {
    const payload = { anchorRef, retainHistory, entry, artifacts: artifacts.map((a) => a.path) };
    if (opts.json) process.stdout.write(JSON.stringify(payload) + '\n');
    else {
      logger.header('report snapshot (dry run)');
      logger.info(
        `  ref: ${anchorRef}  ·  overall: ${entry.scores.overall ?? '—'}  ·  sha: ${sha.slice(0, 12)}`,
      );
      logger.info(`  artifacts: ${artifacts.map((a) => a.path).join(', ') || '(none)'}`);
    }
    return 0;
  }

  const result = publishReportSnapshot({ cwd, anchorRef, entry, artifacts, retainHistory });
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        pushed: result.publish.pushed,
        commit: result.publish.commit,
        reason: result.publish.reason,
        anchorRef: result.anchorRef,
        historyCount: result.historyCount,
        overall: entry.scores.overall,
      }) + '\n',
    );
    return 0;
  }
  logger.header('report snapshot');
  if (result.publish.pushed) {
    logger.success(
      `Published snapshot to ${result.anchorRef} (overall ${entry.scores.overall ?? '—'}, ${result.historyCount} in history).`,
    );
  } else if (result.publish.reason === 'no change') {
    logger.info('No change since the last snapshot — nothing published.');
  } else {
    logger.warn(`Snapshot not published: ${result.publish.reason ?? 'unknown'}.`);
  }
  return 0;
}

const DIMS: Array<{ key: keyof ReportHistoryEntry['scores']; label: string }> = [
  { key: 'overall', label: 'overall' },
  { key: 'security', label: 'sec' },
  { key: 'quality', label: 'qual' },
  { key: 'tests', label: 'test' },
  { key: 'documentation', label: 'docs' },
  { key: 'maintainability', label: 'maint' },
  { key: 'developerExperience', label: 'dx' },
];

function arrow(cur: number | null, prev: number | null | undefined): string {
  if (cur == null || prev == null) return ' ';
  if (cur > prev) return '▲';
  if (cur < prev) return '▼';
  return '=';
}

export interface ReportHistoryCliOptions {
  readonly cwd: string;
  readonly anchorRef?: string;
  readonly json?: boolean;
  readonly limit?: number;
}

export function runReportHistory(opts: ReportHistoryCliOptions): number {
  const policy = readReportsPolicy(opts.cwd);
  const anchorRef = opts.anchorRef ?? policy.anchorRef ?? DEFAULT_REPORTS_REF;
  const history = readReportHistory(opts.cwd, anchorRef);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ anchorRef, entries: history }) + '\n');
    return 0;
  }

  logger.header('report history (score over time)');
  if (history.length === 0) {
    logger.info(
      `  No snapshots on ${anchorRef} yet. Run \`vyuh-dxkit report snapshot\` (or enable`,
    );
    logger.info('  the on-merge reports workflow) to start the trend.');
    return 0;
  }
  const shown = opts.limit && opts.limit > 0 ? history.slice(-opts.limit) : history;
  logger.info(`  ${anchorRef} · ${history.length} snapshot(s), showing ${shown.length}`);
  logger.info('  ' + 'date'.padEnd(12) + DIMS.map((d) => d.label.padEnd(7)).join(''));
  shown.forEach((e, i) => {
    const prev = i > 0 ? shown[i - 1] : undefined;
    const cells = DIMS.map((d) => {
      const v = e.scores[d.key];
      const a = arrow(v, prev?.scores[d.key]);
      return `${v ?? '—'}${a}`.padEnd(7);
    });
    logger.info('  ' + e.date.slice(0, 10).padEnd(12) + cells.join(''));
  });
  return 0;
}
