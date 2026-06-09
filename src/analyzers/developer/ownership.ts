/**
 * Active-owner model — who knows a set of files, and which of them are
 * still around to ask. Shared substrate for finding attribution ("who
 * introduced / who to ask") and reviewer recommendation ("who should
 * review this"). All git-based; `git` is a builtin (tool-registry
 * exemption).
 *
 * The module is split so the ranking logic is testable without git:
 *   - `rankOwners(touches, activeEmails, opts)` — PURE. Given per-commit
 *     authorship touching the files plus the set of currently-active
 *     authors, produces the ranked owners + bus-factor + all-inactive flag.
 *   - `ownersFor(cwd, files, opts)` — IO wrapper. Gathers the touches +
 *     the active-author set via git, then delegates to `rankOwners`.
 *
 * Edge cases (the make-or-break list) all live in `rankOwners`:
 *   - Active = present in the repo-wide recent window. A contributor who
 *     last touched a file two years ago and hasn't committed since is
 *     marked `active: false` (left the team / went quiet) — never silently
 *     recommended.
 *   - Bots excluded (reuses `isBotAuthor`).
 *   - Recency-weighted — a single commit long ago ranks far below sustained
 *     recent work (exponential half-life decay).
 *   - `excludeEmails` drops e.g. the PR author from the ranking.
 *   - `busFactor` surfaces single-point-of-failure ownership.
 *   - `allInactive` lets callers fall back to current ownership / CODEOWNERS
 *     and SAY SO rather than naming someone unreachable.
 *
 * Identity vs output: `email` is the INTERNAL join key (git's stable
 * identity for clustering aliases) — it is NOT for display. Committed
 * output (reports / PR bodies) renders `name` + the GitHub `@handle`
 * (resolved offline from `…@users.noreply.github.com` emails when
 * possible), never the raw email. The handle is both the privacy-safe
 * identifier AND the actionable one — it's @-mentionable and is what
 * `gh pr create --reviewer` consumes. Callers must not surface `email`
 * in any committed artifact.
 */
import { run } from '../tools/runner';
import { isBotAuthor, normalizeEmail } from './gather';

/**
 * Best-effort GitHub handle from a commit email, offline + deterministic.
 * GitHub's privacy-relay emails encode the login:
 *   `username@users.noreply.github.com`        → `username`
 *   `12345+username@users.noreply.github.com`  → `username`
 * Returns `undefined` for any other email (a real handle then needs the
 * GitHub API, which the reviewers CLI may resolve where available).
 */
export function handleFromEmail(email: string): string | undefined {
  const m = email
    .toLowerCase()
    .match(/^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)@users\.noreply\.github\.com$/);
  return m ? m[1] : undefined;
}

/** One commit that touched the queried files. */
export interface CommitTouch {
  readonly name: string;
  readonly email: string;
  /** Author date, ISO 8601 (`%aI`). */
  readonly dateISO: string;
}

/** A ranked owner of the queried files. */
export interface FileOwner {
  readonly name: string;
  /** Internal join key only — git's stable identity. NEVER render this in
   *  committed output; use `name` / `githubHandle` instead. */
  readonly email: string;
  /** GitHub @handle when resolvable offline from the email (privacy-safe,
   *  @-mentionable, feeds `gh --reviewer`). Absent ⇒ render `name`. */
  readonly githubHandle?: string;
  /** Commits (within the knowledge window) touching the queried files. */
  readonly commits: number;
  /** ISO date of this owner's most recent touch of the files. */
  readonly lastTouched: string;
  /** Whether the owner is still active repo-wide (in the recent window). */
  readonly active: boolean;
  /** Recency-weighted score; higher = stronger current ownership. */
  readonly score: number;
}

export interface OwnershipResult {
  /** Owners sorted by score desc. Includes inactive owners (flagged) so
   *  attribution can say "original author inactive" rather than hiding them. */
  readonly ranked: ReadonlyArray<FileOwner>;
  /** Number of distinct ACTIVE owners whose combined score covers ~50% of
   *  the active ownership — a bus-factor signal. 0 when no active owner. */
  readonly busFactor: number;
  /** True when no ACTIVE human owner was found (everyone who knows these
   *  files has gone quiet / left). Callers fall back to current ownership. */
  readonly allInactive: boolean;
}

export interface RankOwnersOptions {
  /** Normalized emails to drop from the ranking (e.g. the PR author). */
  readonly excludeEmails?: ReadonlySet<string>;
  /** "Now" for recency decay — injectable for deterministic tests. */
  readonly now: Date;
  /** Half-life (days) for the recency decay. Default 180 (~2 quarters). */
  readonly halfLifeDays?: number;
}

const DEFAULT_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure ranking core. `activeEmails` is the set of NORMALIZED emails
 * considered currently active (repo-wide recent window). `touches` is one
 * entry per commit that touched the queried files (bots included — they're
 * filtered here).
 */
export function rankOwners(
  touches: ReadonlyArray<CommitTouch>,
  activeEmails: ReadonlySet<string>,
  opts: RankOwnersOptions,
): OwnershipResult {
  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const nowMs = opts.now.getTime();
  const exclude = opts.excludeEmails ?? new Set<string>();

  interface Acc {
    name: string;
    email: string;
    handle?: string;
    commits: number;
    score: number;
    lastTouchedMs: number;
  }
  const byEmail = new Map<string, Acc>();

  for (const t of touches) {
    if (isBotAuthor(t.name, t.email)) continue;
    const key = normalizeEmail(t.email);
    if (exclude.has(key)) continue;
    const touchedMs = Date.parse(t.dateISO);
    if (Number.isNaN(touchedMs)) continue;
    const ageDays = Math.max(0, (nowMs - touchedMs) / MS_PER_DAY);
    const weight = Math.pow(0.5, ageDays / halfLife);
    const handle = handleFromEmail(t.email);
    const existing = byEmail.get(key);
    if (existing) {
      existing.commits += 1;
      existing.score += weight;
      // Keep any resolvable handle, even if it came from a different alias.
      if (!existing.handle && handle) existing.handle = handle;
      if (touchedMs > existing.lastTouchedMs) {
        existing.lastTouchedMs = touchedMs;
        existing.name = t.name; // prefer the name on the most recent commit
      }
    } else {
      byEmail.set(key, {
        name: t.name,
        email: t.email,
        ...(handle ? { handle } : {}),
        commits: 1,
        score: weight,
        lastTouchedMs: touchedMs,
      });
    }
  }

  const ranked: FileOwner[] = [...byEmail.entries()]
    .map(([key, a]) => ({
      name: a.name,
      email: a.email,
      ...(a.handle ? { githubHandle: a.handle } : {}),
      commits: a.commits,
      lastTouched: new Date(a.lastTouchedMs).toISOString().slice(0, 10),
      active: activeEmails.has(key),
      score: a.score,
    }))
    .sort((x, y) => y.score - x.score || y.commits - x.commits || x.name.localeCompare(y.name));

  // Bus factor: among active owners, how many cover ~50% of active score.
  const activeOwners = ranked.filter((o) => o.active);
  const activeTotal = activeOwners.reduce((s, o) => s + o.score, 0);
  let busFactor = 0;
  if (activeTotal > 0) {
    let cum = 0;
    for (const o of activeOwners) {
      busFactor += 1;
      cum += o.score;
      if (cum >= activeTotal * 0.5) break;
    }
  }

  return { ranked, busFactor, allInactive: activeOwners.length === 0 };
}

export interface OwnersForOptions {
  /** Recent-activity window for "active" (git `--since`). Default 6 months. */
  readonly activeSince?: string;
  /** Knowledge-window for who-touched-the-files (git `--since`). Omit for
   *  full history (recency decay handles down-weighting old work). */
  readonly knowledgeSince?: string;
  /** Normalized emails to exclude (e.g. the PR author). */
  readonly excludeEmails?: ReadonlySet<string>;
  readonly now?: Date;
  readonly halfLifeDays?: number;
}

/**
 * Gather ownership for `files` via git, then rank. Returns an empty result
 * (no owners) when git produces nothing — callers treat that as "unknown,"
 * never as "no owners exist."
 */
export function ownersFor(
  cwd: string,
  files: ReadonlyArray<string>,
  opts: OwnersForOptions = {},
): OwnershipResult {
  const now = opts.now ?? new Date();
  if (files.length === 0) {
    return { ranked: [], busFactor: 0, allInactive: true };
  }

  // Per-file authorship: one line per commit touching any of the files.
  // `%x1f` (unit separator) avoids collisions with names/emails.
  const since = opts.knowledgeSince ? `--since='${opts.knowledgeSince}'` : '';
  const pathArgs = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  const logOut = run(
    `git log --no-merges ${since} --format='%aN%x1f%aE%x1f%aI' -- ${pathArgs}`,
    cwd,
    30000,
  );
  const touches: CommitTouch[] = [];
  for (const line of (logOut || '').split('\n')) {
    if (!line.trim()) continue;
    const [name, email, dateISO] = line.split('\x1f');
    if (name && email && dateISO) touches.push({ name, email, dateISO });
  }

  // Active set: anyone with a non-merge commit repo-wide in the recent window.
  const activeSince = opts.activeSince ?? '6 months ago';
  const activeOut = run(`git shortlog -sne --no-merges --since='${activeSince}' HEAD`, cwd, 30000);
  const activeEmails = new Set<string>();
  for (const line of (activeOut || '').split('\n')) {
    const m = line.trim().match(/^\d+\s+.+?\s+<([^>]+)>$/);
    if (m) activeEmails.add(normalizeEmail(m[1]));
  }

  return rankOwners(touches, activeEmails, {
    excludeEmails: opts.excludeEmails,
    now,
    ...(opts.halfLifeDays !== undefined ? { halfLifeDays: opts.halfLifeDays } : {}),
  });
}
