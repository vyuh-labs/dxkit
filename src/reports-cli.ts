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
import { gatherInventoryCounts } from './extensions/inventory';
import {
  reportToHistoryEntry,
  publishReportSnapshot,
  readReportHistory,
  DEFAULT_REPORTS_REF,
  type SnapshotArtifact,
} from './reports/snapshot';
import { SCORE_KEYS, type ReportFindingCounts, type ReportHistoryEntry } from './reports/history';
import {
  computeTrendContext,
  debtRows,
  dimensionRows,
  formatTrendContext,
  segmentHistory,
  seriesRow,
  sparkline,
  type TrendSeriesRow,
} from './reports/trend';
import { renderHistoryMarkdown } from './reports/render';
import {
  defaultGhExec,
  resolveRepoSlug,
  updateLandedComment,
  type GhExec,
  type LandedCommentOutcome,
} from './reports/landed-comment';
import { loadPolicyFromCwd, type ReportsPolicy } from './baseline/policy';
import { announceAnchorNotPushed } from './baseline/anchor-publish';
import * as logger from './logger';
import { trustedLocalContext } from './analysis-trust';

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

/** Collect the `latest/` artifacts already rendered under `.dxkit/reports/`.
 *  Exported for tests (the publish path itself is exercised via
 *  `runReportSnapshot`). */
export function collectArtifacts(cwd: string): SnapshotArtifact[] {
  const reportsDir = path.join(cwd, '.dxkit', 'reports');
  const out: SnapshotArtifact[] = [];
  const dash = path.join(reportsDir, 'dashboard.html');
  if (fs.existsSync(dash))
    out.push({ path: 'dashboard.html', content: fs.readFileSync(dash, 'utf8') });
  try {
    const files = fs.readdirSync(reportsDir);
    // Newest health-audit markdown, if any.
    const md = files
      .filter((f) => /^health-audit-.*\.md$/.test(f) && !f.includes('detailed'))
      .sort()
      .pop();
    if (md)
      out.push({ path: 'health.md', content: fs.readFileSync(path.join(reportsDir, md), 'utf8') });
    // Newest CycloneDX SBOM (the bom command always writes one beside its
    // markdown report), published under a stable name so consumers can
    // fetch `latest/sbom.cdx.json` off the reports ref without knowing
    // the run date.
    const sbom = files
      .filter((f) => /^bom-.*\.cdx\.json$/.test(f))
      .sort()
      .pop();
    if (sbom)
      out.push({
        path: 'sbom.cdx.json',
        content: fs.readFileSync(path.join(reportsDir, sbom), 'utf8'),
      });
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
  /**
   * After a successful publish, update the merged PR's guardrail comment
   * with the landed (actual) scores beside the projection it carried
   * (impact surface P2). Best-effort: every failure is a disclosed skip in
   * the output + step summary, never a non-zero exit: the reports lane
   * passes this flag; local runs default off.
   */
  readonly prComment?: boolean;
  /** Injected gh executor for the PR-comment update (tests). */
  readonly ghExec?: GhExec;
}

/** Append a line to the Actions step summary when running under CI.
 *  Best-effort decoration, mirroring the remediate lane's helper. */
function appendStepSummary(line: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, line + '\n\n', 'utf8');
  } catch {
    /* summary is decoration, never a failure */
  }
}

export async function runReportSnapshot(opts: ReportSnapshotOptions): Promise<number> {
  const { cwd } = opts;
  const policy = readReportsPolicy(cwd);
  const anchorRef = opts.anchorRef ?? policy.anchorRef ?? DEFAULT_REPORTS_REF;
  const retainHistory = opts.retainHistory ?? policy.retain?.history ?? 0;

  const report = await analyzeHealth(cwd, { trust: trustedLocalContext() });
  const sha = gitLine(cwd, ['rev-parse', 'HEAD']) || 'unknown';
  const branch = gitLine(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  const date = opts.now ?? new Date().toISOString();

  const inventory = gatherInventoryCounts(cwd);
  const entry = {
    ...reportToHistoryEntry(report, {
      sha,
      date,
      dxkitVersion: VERSION,
      ...(branch ? { branch } : {}),
    }),
    // Extension inventory counts ride the same history entry (additive
    // field) so entity trends chart beside dimension scores.
    ...(inventory ? { inventory } : {}),
  };
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
  // A rejected publish is infrastructure, not a failure to red the job — but it
  // must never be silent (the class that shipped: a ruleset blocked the push,
  // the workflow went green, and no reports ref ever appeared). Announce it the
  // ONE way both publishers do, in JSON and human mode alike.
  const notPushed = !result.publish.pushed && result.publish.reason !== 'no change';

  // The post-merge landed update (impact P2): patch the merged PR's guardrail
  // comment with actual-vs-projected scores. Only after a publish that stands
  // ("no change" republishes the same truth, so the comment is still honest);
  // a REJECTED publish means the entry never landed, so claiming it on a PR
  // would fabricate history.
  let prComment: LandedCommentOutcome | undefined;
  if (opts.prComment) {
    if (notPushed) {
      prComment = {
        status: 'skipped',
        reason: 'snapshot publish was rejected, so there is no landed entry to report',
      };
    } else {
      const exec = opts.ghExec ?? defaultGhExec;
      const slug = resolveRepoSlug(exec);
      prComment = slug
        ? updateLandedComment({
            slug,
            sha,
            entry,
            ...(result.previousEntry ? { prev: result.previousEntry } : {}),
            exec,
          })
        : { status: 'skipped', reason: 'could not resolve the repository slug (owner/repo)' };
    }
    appendStepSummary(
      prComment.status === 'updated'
        ? `dxkit landed scores: updated the guardrail comment on PR #${prComment.prNumber}.`
        : `dxkit landed scores: PR comment skipped (${prComment.reason}).`,
    );
  }

  if (opts.json) {
    if (notPushed) announceAnchorNotPushed(result.anchorRef, result.publish.reason);
    process.stdout.write(
      JSON.stringify({
        pushed: result.publish.pushed,
        commit: result.publish.commit,
        reason: result.publish.reason,
        anchorRef: result.anchorRef,
        historyCount: result.historyCount,
        overall: entry.scores.overall,
        ...(prComment !== undefined ? { prComment } : {}),
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
    announceAnchorNotPushed(result.anchorRef, result.publish.reason);
  }
  if (prComment !== undefined) {
    if (prComment.status === 'updated') {
      logger.success(
        `Updated the guardrail comment on PR #${prComment.prNumber} with landed scores.`,
      );
    } else {
      logger.info(`PR comment skipped: ${prComment.reason}`);
    }
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
  /** Emit a GitHub-flavored markdown block (for `$GITHUB_STEP_SUMMARY` / a PR
   *  comment) instead of the terminal table. */
  readonly markdown?: boolean;
}

export function runReportHistory(opts: ReportHistoryCliOptions): number {
  const policy = readReportsPolicy(opts.cwd);
  const anchorRef = opts.anchorRef ?? policy.anchorRef ?? DEFAULT_REPORTS_REF;
  const history = readReportHistory(opts.cwd, anchorRef);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ anchorRef, entries: history }) + '\n');
    return 0;
  }

  if (opts.markdown) {
    // Raw markdown to stdout so a workflow can redirect it into
    // $GITHUB_STEP_SUMMARY; no logger chrome.
    process.stdout.write(renderHistoryMarkdown(history, opts.limit ? { limit: opts.limit } : {}));
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

// ─── `report trend` (impact P3, the #332 read surface) ────────────────────

export interface ReportTrendCliOptions {
  readonly cwd: string;
  readonly anchorRef?: string;
  readonly json?: boolean;
  /** Injected history reader (tests); production reads the anchor. */
  readonly readHistory?: (cwd: string, anchorRef?: string) => ReportHistoryEntry[];
}

/** Console line for one series row: sparkline + endpoints. Presentation
 *  only; the series itself comes from the ONE trend core (`seriesRow` /
 *  `dimensionRows` / `debtRows`), the same model `latest/impact.md`
 *  renders. */
function seriesLine(row: TrendSeriesRow): string {
  const ends =
    row.first === null || row.last === null
      ? 'unmeasured'
      : row.first === row.last
        ? `${row.last} (flat)`
        : `${row.first} -> ${row.last} (${row.last > row.first ? '+' : ''}${row.last - row.first})`;
  const spark = sparkline(row.values, row.max !== undefined ? { max: row.max } : {});
  return `    ${row.label.padEnd(8)} ${spark}  ${ends}`;
}

/** The finding-count keys, labeled for the secondary series. */
const FINDING_SERIES: Array<{ key: keyof ReportFindingCounts; label: string }> = [
  { key: 'secretsCritical', label: 'secrets' },
  { key: 'securityHigh', label: 'sec-high' },
  { key: 'depVulnsHigh', label: 'dep-high' },
  { key: 'testGaps', label: 'testgaps' },
];

/**
 * `vyuh-dxkit report trend [--json]`: the score-over-time series since
 * install, read off the reports anchor via the ONE history reader. Honesty:
 * the series is SEGMENTED at scoring-methodology / score-input boundaries
 * (the projection's comparability discipline applied to a series); a line is
 * never drawn across incomparable points, and the boundary renders with its
 * reason. Sparklines use a fixed 0..100 scale for scores (a wiggle never
 * reads as a mountain); finding counts scale to their own series maximum
 * with the endpoint numbers carrying the truth.
 */
export function runReportTrend(opts: ReportTrendCliOptions): number {
  const policy = readReportsPolicy(opts.cwd);
  const anchorRef = opts.anchorRef ?? policy.anchorRef ?? DEFAULT_REPORTS_REF;
  const read = opts.readHistory ?? readReportHistory;
  const history = read(opts.cwd, anchorRef);
  const segments = segmentHistory(history);
  const context = computeTrendContext(history);

  if (opts.json) {
    const payload = {
      anchorRef,
      snapshots: history.length,
      ...(history.length > 0 ? { since: history[0].date } : {}),
      segments: segments.map((seg) => ({
        from: seg.entries[0].date,
        to: seg.entries[seg.entries.length - 1].date,
        snapshots: seg.entries.length,
        ...(seg.methodology !== undefined ? { methodology: seg.methodology } : {}),
        ...(seg.unverified ? { unverified: true } : {}),
        ...(seg.boundary !== undefined ? { boundary: seg.boundary } : {}),
        scores: Object.fromEntries(
          SCORE_KEYS.map((key) => [key, seg.entries.map((e) => e.scores[key])]),
        ),
        ...(seg.entries.some((e) => e.findings !== undefined)
          ? {
              findings: Object.fromEntries(
                FINDING_SERIES.filter(({ key }) =>
                  seg.entries.some((e) => typeof e.findings?.[key] === 'number'),
                ).map(({ key }) => [key, seg.entries.map((e) => e.findings?.[key] ?? null)]),
              ),
            }
          : {}),
      })),
      ...(debtRows(history).length > 0
        ? {
            debt: Object.fromEntries(debtRows(history).map((row) => [row.label, row.values])),
          }
        : {}),
      ...(context !== null ? { context } : {}),
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return 0;
  }

  logger.header('report trend (score since install)');
  if (history.length === 0) {
    logger.info(`  No snapshots on ${anchorRef} yet, so there is no trend to draw.`);
    logger.info('  Run `vyuh-dxkit report snapshot` (or enable the on-merge reports');
    logger.info('  workflow, policy.json:reports.onMerge) to start the series.');
    return 0;
  }
  logger.info(
    `  ${anchorRef} · ${history.length} snapshot(s) since ${history[0].date.slice(0, 10)}`,
  );
  segments.forEach((seg, i) => {
    if (seg.boundary !== undefined) {
      logger.info('');
      logger.info(`  -- comparability boundary: ${seg.boundary} --`);
    }
    if (segments.length > 1 || seg.boundary !== undefined) {
      const from = seg.entries[0].date.slice(0, 10);
      const to = seg.entries[seg.entries.length - 1].date.slice(0, 10);
      const method = seg.unverified
        ? 'methodology unstamped, comparability unverified'
        : `methodology ${seg.methodology}`;
      logger.info(
        `  segment ${i + 1}: ${from} -> ${to} (${seg.entries.length} snapshot(s), ${method})`,
      );
    }
    for (const row of dimensionRows(seg.entries)) logger.info(seriesLine(row));
    for (const { key, label } of FINDING_SERIES) {
      const values = seg.entries.map((e) =>
        typeof e.findings?.[key] === 'number' ? e.findings[key]! : null,
      );
      if (!values.some((v) => v !== null)) continue;
      logger.info(seriesLine(seriesRow(key, label, values, { countScale: true })));
    }
  });
  // The debt-over-time series (4.4.7): whole-history on purpose. Finding
  // counts are not scoring-methodology-dependent, so one series is honest;
  // an entry without a debt stamp charts as a gap, never as zero.
  const debt = debtRows(history);
  if (debt.length > 0) {
    logger.info('');
    logger.info('  debt over time (counts by kind):');
    for (const row of debt) logger.info(seriesLine(row));
    if (history.some((e) => e.debt === undefined)) {
      logger.info('    (snapshots without a debt stamp chart as gaps, not zero)');
    }
  }
  if (context !== null) {
    logger.info('');
    logger.info(`  ${formatTrendContext(context)}`);
  }
  return 0;
}
