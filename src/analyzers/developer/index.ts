/**
 * Developer activity analyzer — public API.
 * Orthogonal to health (no dimension score).
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed } from '../tools/timing';
import {
  gatherContributors,
  gatherCommitQuality,
  gatherHotFiles,
  gatherVelocity,
  gatherSummary,
} from './gather';
import { DevReport, ContributorStats } from './types';

export type { DevReport, ContributorStats, HotFile, CommitQuality, WeeklyVelocity } from './types';

export interface AnalyzeDevActivityOptions {
  verbose?: boolean;
}

export function analyzeDevActivity(
  repoPath: string,
  since?: string,
  options: AnalyzeDevActivityOptions = {},
): DevReport {
  const verbose = !!options.verbose;
  const stack = detect(repoPath);
  // Default: last 3 months
  const sinceDate =
    since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const summary = timed('summary', verbose, () => gatherSummary(repoPath, sinceDate));
  const contributors = timed('contributors', verbose, () =>
    gatherContributors(repoPath, sinceDate),
  );
  const commitQuality = timed('commit-quality', verbose, () =>
    gatherCommitQuality(repoPath, sinceDate),
  );
  const hotFiles = timed('hot-files', verbose, () => gatherHotFiles(repoPath, sinceDate));
  const velocity = timed('velocity', verbose, () => gatherVelocity(repoPath, sinceDate));

  const nonMerge = summary.totalCommits - summary.mergeCommits;
  const mergeRatio =
    summary.totalCommits > 0
      ? Math.round((summary.mergeCommits / summary.totalCommits) * 1000) / 1000
      : 0;

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    period: { since: sinceDate, until: new Date().toISOString().slice(0, 10) },
    summary: {
      totalCommits: summary.totalCommits,
      nonMergeCommits: nonMerge,
      mergeCommits: summary.mergeCommits,
      mergeRatio,
      contributors: contributors.length,
    },
    contributors,
    commitQuality,
    hotFiles,
    velocity,
    toolsUsed: ['git'],
  };
}

export function formatDevReport(report: DevReport, elapsed: string): string {
  const L: string[] = [];

  L.push('# Developer Activity Report');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Period:** ${report.period.since} to ${report.period.until}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');
  L.push('---');
  L.push('');

  // Executive summary
  const s = report.summary;
  L.push('## Executive Summary');
  L.push('');
  L.push(
    `**${s.totalCommits} commits** (${s.nonMergeCommits} non-merge, ${s.mergeCommits} merge) ` +
      `from **${s.contributors} contributors**. ` +
      `Merge ratio: ${(s.mergeRatio * 100).toFixed(1)}%. ` +
      `Commit message quality: ${report.commitQuality.conventionalPercent}% conventional.`,
  );
  L.push('');
  L.push('---');
  L.push('');

  // Contributors
  L.push('## 1. Developer Contributions');
  L.push('');
  L.push('| Rank | Developer | Commits | +Lines | -Lines | Net | Merges |');
  L.push('|------|-----------|---------|--------|--------|-----|--------|');
  report.contributors.forEach((c, i) => {
    const total = c.commits + c.mergeCommits;
    L.push(
      `| ${i + 1} | ${c.name} | ${total} | +${c.linesAdded.toLocaleString()} | -${c.linesRemoved.toLocaleString()} | ${c.netChange >= 0 ? '+' : ''}${c.netChange.toLocaleString()} | ${c.mergeCommits} |`,
    );
  });
  L.push('');
  L.push('---');
  L.push('');

  // Commit quality
  const q = report.commitQuality;
  L.push('## 2. Commit Message Quality');
  L.push('');
  L.push('| Type | Count | % |');
  L.push('|------|-------|---|');
  L.push(`| Conventional (feat:, fix:, etc.) | ${q.conventional} | ${q.conventionalPercent}% |`);
  L.push(
    `| Descriptive | ${q.descriptive} | ${q.total > 0 ? ((q.descriptive / q.total) * 100).toFixed(1) : 0}% |`,
  );
  L.push(`| Vague | ${q.vague} | ${q.total > 0 ? ((q.vague / q.total) * 100).toFixed(1) : 0}% |`);
  L.push('');
  if (q.conventionalPercent < 10) {
    L.push(
      '> **Poor commit message quality.** Consider adopting [Conventional Commits](https://www.conventionalcommits.org/) for automated changelogs and clearer git history.',
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Hot files
  L.push('## 3. Hot Files (Most Changed)');
  L.push('');
  L.push('| File | Changes |');
  L.push('|------|---------|');
  for (const f of report.hotFiles) {
    L.push(`| \`${f.path}\` | ${f.changes} |`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Velocity
  L.push('## 4. Weekly Velocity');
  L.push('');
  if (report.velocity.length > 0) {
    L.push('| Week | Commits |');
    L.push('|------|---------|');
    for (const v of report.velocity) {
      const bar = '█'.repeat(Math.min(Math.round(v.commits / 2), 30));
      L.push(`| ${v.week} | ${v.commits} ${bar} |`);
    }
    const avgPerWeek =
      report.velocity.length > 0
        ? Math.round(
            report.velocity.reduce((sum, v) => sum + v.commits, 0) / report.velocity.length,
          )
        : 0;
    L.push('');
    L.push(`**Average:** ${avgPerWeek} commits/week.`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return L.join('\n');
}
