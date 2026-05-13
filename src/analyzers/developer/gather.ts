/**
 * Developer activity gathering — all git-based, no external tools.
 *
 * Tool: git (log, shortlog, blame)
 */
import { run } from '../tools/runner';
import { allAutogenSourcePatterns } from '../../languages';
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
  // Pull a wider window than `top` because D061 filtering may drop
  // generated files (designer.cs, .pb.go, etc.). Without overscan we
  // could lose real hot files behind autogen noise.
  const raw = run(
    `git log --name-only --format='' --since='${since}' --no-merges HEAD 2>/dev/null | sort | uniq -c | sort -rn | head -${top * 4}`,
    cwd,
    30000,
  );
  if (!raw) return [];
  const autogenPatterns = allAutogenSourcePatterns();

  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      return m ? { path: m[2], changes: parseInt(m[1]) } : null;
    })
    .filter((x): x is HotFile => {
      if (x === null) return false;
      if (x.path.includes('package-lock')) return false;
      // D061 (2.4.7): drop auto-generated files (designer.cs, .pb.go,
      // *Generated.java, etc.) so hot files reflect human-authored
      // churn, not regeneration noise from IDEs / build steps. Each
      // pack contributes its own `autogeneratedSourcePatterns`; the
      // union drives this filter, so adding a new pack auto-extends it.
      const base = x.path.split('/').pop() ?? '';
      for (const pat of autogenPatterns) {
        if (matchesBasenameGlob(pat, base)) return false;
      }
      return true;
    })
    .slice(0, top);
}

function matchesBasenameGlob(pat: string, base: string): boolean {
  if (!pat.includes('*') && !pat.includes('?')) return pat === base;
  const regex = new RegExp(
    '^' +
      pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return regex.test(base);
}

// ─── Weekly velocity ────────────────────────────────────────────────────────

export function gatherVelocity(cwd: string, since: string): WeeklyVelocity[] {
  const raw = run(`git log --format='%aI' --since='${since}' HEAD 2>/dev/null`, cwd, 30000);
  if (!raw) return [];

  const weekCounts = new Map<string, number>();
  for (const dateStr of raw.split('\n').filter((l) => l.trim())) {
    const date = new Date(dateStr);
    const week = isoWeekKey(date);
    weekCounts.set(week, (weekCounts.get(week) || 0) + 1);
  }

  if (weekCounts.size === 0) return [];

  // D060 (2.4.7): fill empty weeks with 0-row entries between the
  // first and last week that had commits. Pre-fix the velocity table
  // showed `W08 2, W09 1, W10 7, W14 1, W16 6, ...` — silent gaps
  // (W11/W12/W13/W15) implied "data missing" when reality was "zero
  // commits that week." Rendering zero-rows makes cadence honest.
  const weeks = Array.from(weekCounts.keys()).sort();
  const filled: WeeklyVelocity[] = [];
  for (const w of weeksInRange(weeks[0], weeks[weeks.length - 1])) {
    filled.push({ week: w, commits: weekCounts.get(w) ?? 0 });
  }
  return filled;
}

function isoWeekKey(date: Date): string {
  const year = date.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const weekNum = Math.ceil(((date.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Enumerate every ISO `YYYY-Www` between `start` and `end` inclusive,
 * walking week-by-week through the calendar. Spans year boundaries by
 * advancing 7 days at a time and re-deriving the key. The key shape
 * matches `isoWeekKey()` so set lookup against `weekCounts` aligns
 * byte-for-byte.
 */
function* weeksInRange(start: string, end: string): Generator<string> {
  // Reconstruct a date that falls inside `start`'s week — pick midweek
  // (Wednesday) of an anchor day in that week. Simpler than reversing
  // the isoWeekKey formula: just iterate Jan 1 forward.
  const [yStart] = start.split('-W').map(Number);
  const cursor = new Date(yStart, 0, 1);
  // Walk forward until we hit `start`. Bounded by ~53 weeks worst case.
  while (isoWeekKey(cursor) !== start) cursor.setDate(cursor.getDate() + 1);
  // Now emit week keys, advancing 7 days at a time. Stop after `end`.
  let safety = 600; // ~10 years of weeks; far beyond any plausible since-window.
  while (safety-- > 0) {
    const key = isoWeekKey(cursor);
    yield key;
    if (key === end) return;
    cursor.setDate(cursor.getDate() + 7);
  }
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
