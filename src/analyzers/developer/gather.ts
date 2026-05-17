/**
 * Developer activity gathering — all git-based, no external tools.
 *
 * Tool: git (log, shortlog, blame)
 */
import { run } from '../tools/runner';
import { allAutogenSourcePatterns } from '../../languages';
import { ContributorStats, HotFile, CommitQuality, WeeklyVelocity } from './types';

// ─── Contributors ───────────────────────────────────────────────────────────

/**
 * True when an author looks like an automation account rather than a
 * human contributor. Common bot patterns: GitHub App naming
 * convention (`[bot]` suffix), known service accounts, and CI-only
 * placeholders (`root`, `unknown`). Bot rows still appear in the
 * leaderboard but get tagged so they don't crowd out human signal.
 */
function isBotAuthor(name: string, email: string): boolean {
  if (/\[bot\]/.test(name)) return true;
  if (/^(dependabot|renovate|github-actions|snyk-bot|deepsource-io)$/i.test(name)) return true;
  if (/^(dependabot|renovate|github-actions|noreply)@/.test(email)) return true;
  if (name === 'root' || name === 'unknown') return true;
  return false;
}

/**
 * Normalize an email for clustering. GitHub's privacy-relay emails
 * (`123456+username@users.noreply.github.com`) sometimes get used
 * alongside the real address; drop the leading `<digits>+` so both
 * collapse to the same cluster key. Lowercase the whole thing so
 * casing differences don't split a cluster.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().replace(/^\d+\+/, '');
}

export function gatherContributors(cwd: string, since: string): ContributorStats[] {
  // Pull name + email together so we can cluster aliases that share a
  // mailbox (e.g. someone committing as "Jane D" from a laptop and
  // "Jane-Doe-Corp" from a corp VPN under the same address). git
  // shortlog -sne emits `  <count>\t<name> <<email>>`.
  const shortlog = run(
    `git shortlog -sne --no-merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (!shortlog) return [];

  interface RawAuthor {
    name: string;
    email: string;
    commits: number;
  }
  const rawAuthors: RawAuthor[] = [];
  for (const line of shortlog.split('\n').filter((l) => l.trim())) {
    const match = line.trim().match(/^(\d+)\s+(.+?)\s+<([^>]+)>$/);
    if (match) {
      rawAuthors.push({ commits: parseInt(match[1]), name: match[2], email: match[3] });
    }
  }

  // Cluster by normalized email. Within each cluster the canonical
  // display name is the one with the most non-merge commits (ties
  // break alphabetically for stability). Aliases that contributed
  // under the same address collapse into one row.
  interface Cluster {
    canonicalName: string;
    canonicalEmail: string;
    aliases: Map<string, number>;
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    mergeCommits: number;
    isBot: boolean;
  }
  const clusters = new Map<string, Cluster>();
  for (const a of rawAuthors) {
    const key = normalizeEmail(a.email);
    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, {
        canonicalName: a.name,
        canonicalEmail: a.email,
        aliases: new Map([[a.name, a.commits]]),
        commits: a.commits,
        linesAdded: 0,
        linesRemoved: 0,
        mergeCommits: 0,
        isBot: isBotAuthor(a.name, a.email),
      });
    } else {
      existing.aliases.set(a.name, (existing.aliases.get(a.name) ?? 0) + a.commits);
      existing.commits += a.commits;
      // Re-derive canonical: alias with the highest non-merge commit
      // count wins (tie-break alphabetical). Stays deterministic
      // across runs since shortlog is sorted.
      let bestName = existing.canonicalName;
      let bestCount = existing.aliases.get(bestName) ?? 0;
      for (const [name, count] of existing.aliases) {
        if (count > bestCount || (count === bestCount && name < bestName)) {
          bestName = name;
          bestCount = count;
        }
      }
      existing.canonicalName = bestName;
      existing.isBot = existing.isBot || isBotAuthor(a.name, a.email);
    }
  }

  // Build a name→cluster index so the numstat / merge-log passes
  // (which still produce per-name lines) route into the right
  // cluster.
  const clusterByName = new Map<string, Cluster>();
  for (const cluster of clusters.values()) {
    for (const alias of cluster.aliases.keys()) {
      clusterByName.set(alias, cluster);
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
          const cluster = clusterByName.get(currentAuthor);
          if (cluster) {
            cluster.linesAdded += parseInt(m[1]);
            cluster.linesRemoved += parseInt(m[2]);
          }
        }
      }
    }
  }

  // Get merge commit count per author. Merge-only contributors (no
  // non-merge commits) won't appear in shortlog so they need their
  // own cluster. Use name+email from %aE so the cluster key matches.
  const mergeLog = run(
    `git log --format='%aN<<<%aE' --merges --since='${since}' HEAD 2>/dev/null`,
    cwd,
    30000,
  );
  if (mergeLog) {
    for (const entry of mergeLog.split('\n').filter((l) => l.trim())) {
      const [name, email] = entry.split('<<<');
      if (!name || !email) continue;
      const key = normalizeEmail(email);
      const existing = clusters.get(key);
      if (existing) {
        existing.mergeCommits++;
        if (!existing.aliases.has(name)) {
          existing.aliases.set(name, 0);
          clusterByName.set(name, existing);
        }
      } else {
        const cluster: Cluster = {
          canonicalName: name,
          canonicalEmail: email,
          aliases: new Map([[name, 0]]),
          commits: 0,
          linesAdded: 0,
          linesRemoved: 0,
          mergeCommits: 1,
          isBot: isBotAuthor(name, email),
        };
        clusters.set(key, cluster);
        clusterByName.set(name, cluster);
      }
    }
  }

  // Project each cluster to the public ContributorStats shape.
  // Aliases other than the canonical name surface as a parenthetical
  // so the reader can see who got merged.
  const out: ContributorStats[] = [];
  for (const cluster of clusters.values()) {
    const otherAliases = [...cluster.aliases.keys()]
      .filter((n) => n !== cluster.canonicalName)
      .sort();
    const displayName =
      otherAliases.length > 0
        ? `${cluster.canonicalName} (aka ${otherAliases.join(', ')})`
        : cluster.canonicalName;
    const labelled = cluster.isBot ? `${displayName} [automated]` : displayName;
    out.push({
      name: labelled,
      commits: cluster.commits,
      linesAdded: cluster.linesAdded,
      linesRemoved: cluster.linesRemoved,
      netChange: cluster.linesAdded - cluster.linesRemoved,
      mergeCommits: cluster.mergeCommits,
    });
  }

  // Sort by total commits (non-merge + merge) descending
  return out.sort((a, b) => b.commits + b.mergeCommits - (a.commits + a.mergeCommits));
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
