/**
 * Finding attribution — "who to ask" about a finding, grounded in the
 * active-owner model. The OPT-IN historical counterpart to net-new
 * attribution (a net-new finding's introducer is the PR's own commits;
 * that needs no blame). This module answers it for pre-existing findings
 * via `git blame`, then routes through who is still active.
 *
 * Honesty: `git blame` reports who LAST TOUCHED a line, not necessarily who
 * introduced the finding — a formatter run or a move reassigns it. The
 * provenance line states this; the routing softens it by pointing at the
 * current owner when the blamed author has left.
 *
 * Privacy: emails are the internal join key only. Rendered output is the
 * display name + GitHub @handle, never a raw email (same posture as the
 * ownership model).
 *
 * Shape mirrors `explore/finding-context.ts` so threading `--attribute`
 * through the detailed reports is identical to `--graph-context`.
 */
import { execSync } from 'child_process';
import {
  gatherActiveEmails,
  ownersFor,
  handleFromEmail,
  type FileOwner,
} from '../analyzers/developer/ownership';
import { normalizeEmail } from '../analyzers/developer/gather';
import { locationKey } from '../explore/finding-context';

/** Attribution for one finding location. */
export interface FindingAttribution {
  /** Display name — the author who last touched the line (line-level
   *  findings) or the file's current owner (file-level findings). */
  readonly author: string;
  /** GitHub @handle when resolvable offline. */
  readonly handle?: string;
  /** Short commit sha that last touched the line. Absent for file-level
   *  (owner-based) attribution, which has no single introducing commit. */
  readonly commit?: string;
  /** Whether that person is still active repo-wide. */
  readonly active: boolean;
  /** Line-level: when the blamed author is inactive, the current active
   *  owner of the file to ask instead. Absent for file-level attribution
   *  (the author IS the current owner). */
  readonly currentOwner?: { name: string; handle?: string };
  /** True when this is file-level (owner-based) rather than blame-based. */
  readonly fileLevel?: boolean;
}

export interface DetailedAttribution {
  /** Keyed by `locationKey(file, line)`; only resolved locations present. */
  readonly attributions: Record<string, FindingAttribution>;
}

export interface BuildAttributionOptions {
  /** Budget cap on unique locations blamed (each is a git call). */
  readonly maxFindings?: number;
  /** Active-window for "still around to ask." Default 6 months. */
  readonly activeSince?: string;
  readonly now?: Date;
}

interface BlameLine {
  readonly author: string;
  readonly email: string;
  readonly commit: string;
}

/** Parse `git blame --porcelain -L n,n` output for the author + commit of a
 *  single line. Pure — exported for tests. Returns `null` when the porcelain
 *  has no author (empty / error). */
export function parseBlamePorcelain(out: string): BlameLine | null {
  const lines = out.split('\n');
  const commit = lines[0]?.split(' ')[0];
  let author = '';
  let email = '';
  for (const l of lines) {
    if (l.startsWith('author ')) author = l.slice('author '.length).trim();
    else if (l.startsWith('author-mail '))
      email = l.slice('author-mail '.length).trim().replace(/^<|>$/g, '');
  }
  if (!commit || !author) return null;
  return { author, email, commit: commit.slice(0, 8) };
}

function blameLine(cwd: string, file: string, line: number): BlameLine | null {
  try {
    const out = execSync(
      `git blame --porcelain -L ${line},${line} -- '${file.replace(/'/g, "'\\''")}'`,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parseBlamePorcelain(out);
  } catch {
    return null;
  }
}

/**
 * Build per-finding attribution for a list of locations. Fail-open: returns
 * `undefined` when git produces nothing usable. Only locations with a `line`
 * are blamed (a file-level finding has no single line to attribute).
 */
export function buildAttributionMap(
  cwd: string,
  locations: ReadonlyArray<{ file: string; line?: number }>,
  opts: BuildAttributionOptions = {},
): DetailedAttribution | undefined {
  const max = opts.maxFindings ?? 200;
  const now = opts.now ?? new Date();
  const activeEmails = gatherActiveEmails(cwd, opts.activeSince ?? '6 months ago');

  const attributions: Record<string, FindingAttribution> = {};
  const currentOwnerCache = new Map<string, { name: string; handle?: string } | undefined>();
  let blamed = 0;

  for (const loc of locations) {
    if (blamed >= max) break;
    const key = locationKey(loc.file, loc.line);
    if (key in attributions) continue;

    // File-level finding (no line, e.g. a test gap): attribute to the
    // file's current active owner — "who should test/own this," not who
    // wrote a specific line.
    if (typeof loc.line !== 'number') {
      if (!currentOwnerCache.has(loc.file)) {
        currentOwnerCache.set(loc.file, topActiveOwner(cwd, loc.file, now));
      }
      const owner = currentOwnerCache.get(loc.file);
      if (owner) {
        attributions[key] = {
          author: owner.name,
          ...(owner.handle ? { handle: owner.handle } : {}),
          active: true,
          fileLevel: true,
        };
      }
      continue;
    }

    const bl = blameLine(cwd, loc.file, loc.line);
    blamed++;
    if (!bl) continue;

    const active = activeEmails.has(normalizeEmail(bl.email));
    const handle = handleFromEmail(bl.email);
    let currentOwner: { name: string; handle?: string } | undefined;
    if (!active) {
      if (!currentOwnerCache.has(loc.file)) {
        currentOwnerCache.set(loc.file, topActiveOwner(cwd, loc.file, now));
      }
      currentOwner = currentOwnerCache.get(loc.file);
    }

    attributions[key] = {
      author: bl.author,
      ...(handle ? { handle } : {}),
      commit: bl.commit,
      active,
      ...(currentOwner ? { currentOwner } : {}),
    };
  }

  if (Object.keys(attributions).length === 0) return undefined;
  return { attributions };
}

function topActiveOwner(
  cwd: string,
  file: string,
  now: Date,
): { name: string; handle?: string } | undefined {
  const owners = ownersFor(cwd, [file], { now });
  const top = owners.ranked.find((o: FileOwner) => o.active);
  if (!top) return undefined;
  return { name: top.name, ...(top.githubHandle ? { handle: top.githubHandle } : {}) };
}

/** Compact cell rendering — name/@handle, never email. `—` when unresolved. */
export function formatAttributionCell(attr: FindingAttribution | undefined): string {
  if (!attr) return '—';
  const who = attr.handle ? `@${attr.handle}` : attr.author;
  if (attr.fileLevel) return `${who} (owner)`;
  if (attr.active) return `${who} (active)`;
  if (attr.currentOwner) {
    const owner = attr.currentOwner.handle
      ? `@${attr.currentOwner.handle}`
      : attr.currentOwner.name;
    return `${who} (inactive) → ask ${owner}`;
  }
  return `${who} (inactive)`;
}

/** Provenance + honesty line printed above an attributed section. */
export function attributionProvenanceLine(): string {
  return (
    `_"Who to ask" is the author who LAST TOUCHED the line (\`git blame\`), not ` +
    `necessarily who introduced the finding — a formatter run or a move can reassign ` +
    `it. An inactive author is routed to the file's current active owner. Names + ` +
    `GitHub @handles only; never emails._`
  );
}
