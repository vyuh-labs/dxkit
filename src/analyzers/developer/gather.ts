/**
 * Developer activity gathering — all git-based, no external tools.
 *
 * Tool: git (log, shortlog, blame)
 */
import { run } from '../tools/runner';
import { ContributorStats, HotFile, CommitQuality, WeeklyVelocity } from './types';

// ─── Contributors ───────────────────────────────────────────────────────────

export function gatherContributors(cwd: string, since: string): ContributorStats[] {
  // Get commit count per author
  const shortlog = run(
    `git shortlog -sn --no-merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (!shortlog) return [];

  const contributors = new Map<string, ContributorStats>();

  for (const line of shortlog.split('\n').filter((l) => l.trim())) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) {
      contributors.set(match[2], {
        name: match[2],
        commits: parseInt(match[1]),
        linesAdded: 0,
        linesRemoved: 0,
        netChange: 0,
        mergeCommits: 0,
      });
    }
  }

  // Get lines added/removed per author via numstat
  const numstat = run(
    `git log --numstat --format='AUTHOR:%aN' --since='${since}' --no-merges HEAD 2>/dev/null`,
    cwd,
    60000,
  );

  if (numstat) {
    let currentAuthor = '';
    for (const line of numstat.split('\n')) {
      if (line.startsWith('AUTHOR:')) {
        currentAuthor = line.replace('AUTHOR:', '');
      } else {
        const m = line.match(/^(\d+)\s+(\d+)\s+/);
        if (m && currentAuthor) {
          const stats = contributors.get(currentAuthor);
          if (stats) {
            stats.linesAdded += parseInt(m[1]);
            stats.linesRemoved += parseInt(m[2]);
          }
        }
      }
    }
  }

  // Get merge commit count per author
  const mergeLog = run(
    `git log --format='%aN' --merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (mergeLog) {
    for (const name of mergeLog.split('\n').filter((l) => l.trim())) {
      const stats = contributors.get(name);
      if (stats) {
        stats.mergeCommits++;
      } else {
        // Merge-only contributor
        contributors.set(name, {
          name,
          commits: 0,
          linesAdded: 0,
          linesRemoved: 0,
          netChange: 0,
          mergeCommits: 1,
        });
      }
    }
  }

  // Compute net change
  for (const stats of contributors.values()) {
    stats.netChange = stats.linesAdded - stats.linesRemoved;
  }

  // Sort by total commits (non-merge + merge) descending
  return Array.from(contributors.values()).sort(
    (a, b) => b.commits + b.mergeCommits - (a.commits + a.mergeCommits),
  );
}

// ─── Commit quality ─────────────────────────────────────────────────────────

const CONVENTIONAL_RE =
  /^(feat|fix|chore|docs|style|refactor|perf|test|ci|build|revert)(\(.+\))?!?:/i;
const VAGUE_RE = /^(update|fix|change|wip|tmp|test|minor|misc|stuff|cleanup|tweaks?)$/i;

export function gatherCommitQuality(cwd: string, since: string): CommitQuality {
  const messages = run(
    `git log --format='%s' --no-merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (!messages)
    return { conventional: 0, descriptive: 0, vague: 0, total: 0, conventionalPercent: 0 };

  const lines = messages.split('\n').filter((l) => l.trim());
  let conventional = 0;
  let vague = 0;

  for (const msg of lines) {
    if (CONVENTIONAL_RE.test(msg.trim())) {
      conventional++;
    } else if (VAGUE_RE.test(msg.trim()) || msg.trim().split(/\s+/).length <= 2) {
      vague++;
    }
  }

  const total = lines.length;
  const descriptive = total - conventional - vague;
  return {
    conventional,
    descriptive,
    vague,
    total,
    conventionalPercent: total > 0 ? Math.round((conventional / total) * 1000) / 10 : 0,
  };
}

// ─── Hot files ──────────────────────────────────────────────────────────────

export function gatherHotFiles(cwd: string, since: string, top = 15): HotFile[] {
  const raw = run(
    `git log --name-only --format='' --since='${since}' --no-merges HEAD 2>/dev/null | sort | uniq -c | sort -rn | head -${top}`,
    cwd,
    30000,
  );
  if (!raw) return [];

  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      return m ? { path: m[2], changes: parseInt(m[1]) } : null;
    })
    .filter((x): x is HotFile => x !== null && !x.path.includes('package-lock'));
}

// ─── Weekly velocity ────────────────────────────────────────────────────────

export function gatherVelocity(cwd: string, since: string): WeeklyVelocity[] {
  const raw = run(`git log --format='%aI' --since='${since}' HEAD 2>/dev/null`, cwd, 30000);
  if (!raw) return [];

  const weekCounts = new Map<string, number>();
  for (const dateStr of raw.split('\n').filter((l) => l.trim())) {
    const date = new Date(dateStr);
    // ISO week: YYYY-Www
    const year = date.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const weekNum = Math.ceil(
      ((date.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7,
    );
    const week = `${year}-W${String(weekNum).padStart(2, '0')}`;
    weekCounts.set(week, (weekCounts.get(week) || 0) + 1);
  }

  return Array.from(weekCounts.entries())
    .map(([week, commits]) => ({ week, commits }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

// ─── Vague commit examples (for detailed report) ──────────────────────────

const VAGUE_RE_EXPORT = /^(update|fix|change|wip|tmp|test|minor|misc|stuff|cleanup|tweaks?)$/i;

export function gatherVagueCommitExamples(cwd: string, since: string, limit = 15): string[] {
  const messages = run(
    `git log --format='%s' --no-merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (!messages) return [];
  const vague: string[] = [];
  for (const msg of messages.split('\n').filter((l) => l.trim())) {
    const trimmed = msg.trim();
    if (VAGUE_RE_EXPORT.test(trimmed) || trimmed.split(/\s+/).length <= 2) {
      vague.push(trimmed);
      if (vague.length >= limit) break;
    }
  }
  return vague;
}

// ─── Summary counts ─────────────────────────────────────────────────────────

export function gatherSummary(
  cwd: string,
  since: string,
): { totalCommits: number; mergeCommits: number } {
  const total = parseInt(
    run(`git rev-list --count --since='${since}' HEAD 2>/dev/null`, cwd) || '0',
  );
  const merges = parseInt(
    run(`git rev-list --count --merges --since='${since}' HEAD 2>/dev/null`, cwd) || '0',
  );
  return { totalCommits: total, mergeCommits: merges };
}
