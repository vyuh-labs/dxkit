/**
 * Detailed developer activity report.
 *
 * Observational — there is no score to simulate here (dev-report is about
 * what happened, not what to fix). The detailed report is a richer inventory
 * + flagged observations that agents can turn into recommendations.
 */
import { DevReport } from './types';

export interface DevObservation {
  id: string;
  severity: 'info' | 'warn' | 'action';
  title: string;
  rationale: string;
  /** Optional context values rendered inline (keep primitives only). */
  context?: Record<string, string | number | boolean>;
}

export interface DevDetailedReport extends DevReport {
  schemaVersion: string;
  vagueCommitExamples: string[];
  observations: DevObservation[];
}

/** Derive observations from the report + sample data. */
export function buildObservations(report: DevReport): DevObservation[] {
  const obs: DevObservation[] = [];
  const q = report.commitQuality;
  const s = report.summary;

  if (q.total > 0 && q.conventionalPercent < 20) {
    obs.push({
      id: 'dev.low-conventional-commits',
      severity: 'action',
      title: `Low conventional-commit adoption (${q.conventionalPercent}%)`,
      rationale:
        'Conventional commits (feat:, fix:, etc.) enable automated changelogs and clearer history. Adoption below 20% suggests no enforcement.',
      context: { conventionalPercent: q.conventionalPercent, total: q.total },
    });
  }
  if (q.total > 0 && q.vague / q.total > 0.3) {
    obs.push({
      id: 'dev.vague-commit-messages',
      severity: 'warn',
      title: `${q.vague} vague commit messages (${Math.round((q.vague / q.total) * 100)}%)`,
      rationale:
        'Single-word or placeholder messages ("update", "fix", "wip") make git history unreadable. Enforce minimum message length in a commit-msg hook.',
      context: { vague: q.vague, total: q.total },
    });
  }
  if (s.mergeRatio > 0.3) {
    obs.push({
      id: 'dev.high-merge-ratio',
      severity: 'warn',
      title: `Merge commits are ${Math.round(s.mergeRatio * 100)}% of all commits`,
      rationale:
        'A high merge ratio indicates branch-heavy workflow. Rebase-on-merge or squash-merge keeps history linear and easier to bisect.',
      context: { mergeRatio: s.mergeRatio },
    });
  }
  if (report.contributors.length > 0 && report.contributors.length <= 2) {
    obs.push({
      id: 'dev.bus-factor-risk',
      severity: 'warn',
      title: `Only ${report.contributors.length} active contributor${report.contributors.length === 1 ? '' : 's'} in period`,
      rationale:
        'Low bus factor — knowledge is concentrated. Consider pair programming, code review rotation, or onboarding.',
      context: { contributors: report.contributors.length },
    });
  }
  if (report.hotFiles.length > 0) {
    const hottest = report.hotFiles[0];
    if (hottest.changes >= 20) {
      obs.push({
        id: 'dev.churn-hotspot',
        severity: 'info',
        title: `Churn hotspot: \`${hottest.path}\` (${hottest.changes} changes)`,
        rationale:
          'Frequently-changed files often need refactoring — or are simply high-activity. Cross-reference with quality report for god files or duplication.',
        context: { path: hottest.path, changes: hottest.changes },
      });
    }
  }
  if (report.velocity.length >= 2) {
    const recent = report.velocity.slice(-4);
    const avgRecent = recent.reduce((s, v) => s + v.commits, 0) / recent.length;
    const overall = report.velocity.reduce((s, v) => s + v.commits, 0) / report.velocity.length;
    if (avgRecent < overall * 0.5) {
      obs.push({
        id: 'dev.velocity-drop',
        severity: 'info',
        title: `Velocity dropped in last ${recent.length} weeks (${avgRecent.toFixed(1)}/wk vs ${overall.toFixed(1)} avg)`,
        rationale:
          'A sustained drop could mean shipping elsewhere, team transition, or blocked work. Worth confirming with the team.',
        context: {
          avgRecent: Number(avgRecent.toFixed(1)),
          avgOverall: Number(overall.toFixed(1)),
        },
      });
    }
  }
  return obs;
}

export function buildDevDetailed(
  report: DevReport,
  vagueCommitExamples: string[] = [],
): DevDetailedReport {
  return {
    ...report,
    schemaVersion: '11',
    vagueCommitExamples,
    observations: buildObservations(report),
  };
}

export function formatDevDetailedMarkdown(detailed: DevDetailedReport, elapsed: string): string {
  const L: string[] = [];
  const s = detailed.summary;
  const q = detailed.commitQuality;

  L.push('# Developer Activity — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Period:** ${detailed.period.since} to ${detailed.period.until}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  // Observations — actionable signals
  L.push('## Observations');
  L.push('');
  if (detailed.observations.length === 0) {
    L.push('No notable signals detected.');
  } else {
    L.push('| Severity | Observation |');
    L.push('|----------|-------------|');
    for (const o of detailed.observations) {
      L.push(`| ${o.severity.toUpperCase()} | ${o.title} |`);
    }
    L.push('');
    for (const o of detailed.observations) {
      L.push(`### ${o.title}`);
      L.push(`- **ID:** \`${o.id}\``);
      L.push(`- **Severity:** ${o.severity}`);
      L.push(`- **Why:** ${o.rationale}`);
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Summary
  L.push('## Summary');
  L.push('');
  L.push(
    `**${s.totalCommits} commits** (${s.nonMergeCommits} non-merge, ${s.mergeCommits} merge) from **${s.contributors} contributors**.`,
  );
  L.push(`**Merge ratio:** ${(s.mergeRatio * 100).toFixed(1)}%`);
  L.push(`**Conventional commits:** ${q.conventionalPercent}% of non-merge commits.`);
  L.push('');
  L.push('---');
  L.push('');

  // All contributors
  L.push('## All Contributors');
  L.push('');
  L.push('| Rank | Developer | Commits | Merges | +Lines | -Lines | Net |');
  L.push('|------|-----------|--------:|-------:|-------:|-------:|-----|');
  detailed.contributors.forEach((c, i) => {
    L.push(
      `| ${i + 1} | ${c.name} | ${c.commits} | ${c.mergeCommits} | +${c.linesAdded.toLocaleString()} | -${c.linesRemoved.toLocaleString()} | ${c.netChange >= 0 ? '+' : ''}${c.netChange.toLocaleString()} |`,
    );
  });
  L.push('');
  L.push('---');
  L.push('');

  // Commit quality breakdown
  L.push('## Commit Message Quality');
  L.push('');
  L.push('| Type | Count | % |');
  L.push('|------|------:|---|');
  L.push(`| Conventional | ${q.conventional} | ${q.conventionalPercent}% |`);
  L.push(
    `| Descriptive | ${q.descriptive} | ${q.total > 0 ? ((q.descriptive / q.total) * 100).toFixed(1) : 0}% |`,
  );
  L.push(`| Vague | ${q.vague} | ${q.total > 0 ? ((q.vague / q.total) * 100).toFixed(1) : 0}% |`);
  L.push('');
  if (detailed.vagueCommitExamples.length > 0) {
    L.push('### Sample vague commits');
    L.push('');
    for (const msg of detailed.vagueCommitExamples) {
      L.push(`- \`${msg}\``);
    }
    L.push('');
  }
  L.push('---');
  L.push('');

  // All hot files
  L.push('## Hot Files (Most Changed)');
  L.push('');
  L.push('| File | Changes |');
  L.push('|------|--------:|');
  for (const f of detailed.hotFiles) {
    L.push(`| \`${f.path}\` | ${f.changes} |`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Velocity
  L.push('## Weekly Velocity');
  L.push('');
  if (detailed.velocity.length > 0) {
    L.push('| Week | Commits | Bar |');
    L.push('|------|--------:|-----|');
    for (const v of detailed.velocity) {
      const bar = '█'.repeat(Math.min(Math.round(v.commits / 2), 30));
      L.push(`| ${v.week} | ${v.commits} | ${bar} |`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');

  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ')}`);
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push(
    '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) — detailed mode*',
  );
  return L.join('\n');
}
