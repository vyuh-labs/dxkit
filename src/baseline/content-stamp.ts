/**
 * Content-hash STAMPING: the one place a baseline/current entry gets its
 * `contentHash` (CLAUDE.md Rule 2.30, one concept, one code path).
 *
 * The hash itself is computed by `content-hash.ts` (the only module that may
 * hash, per the Rule 9 `createHash` ban). This module owns the POLICY around
 * calling it — and, since 4.4.5, the WIRING: producers emit bare entries and
 * the orchestrator stamps once, through `stampEntries`, using the same
 * `entryToLocated` projection the matcher consumes. "What is located" and
 * "what gets stamped" are therefore one definition; a new located kind is
 * stamped the day its producer lands, with no per-producer wiring to forget.
 * (The shipped 4.4.4 shape: the security producer stamped through a local
 * closure and the custom-check producer stamped nothing, so one 4-space to
 * 2-space reindent read a repo's whole grandfathered lint backlog as
 * resolved plus dozens of net-new.)
 *
 * WHICH content is hashed matters as much as whether: every scanner reads the
 * WORKING TREE, so a finding's `line` is a working-tree line. The stamp reads
 * the same tree. Reading the file at a commit instead (the 4.4.4 shape) hashed
 * pre-change content at post-change lines on a dirty tree (the loop Stop-gate
 * and pre-push surfaces), so the reformat this scheme exists to survive did
 * not pair while uncommitted, and a same-rule finding newly introduced at a
 * line whose committed window still matched could pair as "persisted". On a
 * clean checkout (baseline create in CI, the guardrail on a PR head) the tree
 * IS the commit, so the two readings agree there and only there.
 *
 * Read policy, decided once here:
 *   - no tree (`cwd` absent): no stamp;
 *   - a whole-file finding (`line <= 0`): no stamp, the window is meaningless;
 *   - a path outside the repo (absolute, or escaping via `..` segments): no
 *     stamp — a finding's `file` is repo-relative by contract;
 *   - a SYMLINK: no stamp — `readFileSync` follows links, and on an untrusted
 *     tree (a fork PR) a committed link must not widen what dxkit reads;
 *   - a file over `CONTENT_STAMP_MAX_BYTES` (10 MB): no stamp — nothing worth
 *     window-hashing is that large, and reading it would pin it in memory;
 *   - an unreadable file (missing, a directory, binary-ish): no stamp.
 * Every no-stamp case degrades to the matcher's git + identity passes.
 *
 * Performance: file content is read once per file per stamping pass and
 * cached as SPLIT LINES, so per-finding work is a 7-line slice + one sha1
 * (a 10k-finding backlog in one file is milliseconds, not seconds).
 *
 * `restampAtCommit` is the MIGRATION sibling: a baseline written before this
 * scheme has located entries with no hash, and its line numbers describe the
 * tree at its anchor commit — so the update/migrate lane may restamp them by
 * reading files AT THAT COMMIT (`git show`), the one place a commit read is
 * correct. It is batched (one read per unique file) and its result is
 * disclosed, never silent.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveInsideRepo } from '../analyzers/tools/paths';
import { computeContentHashFromLines } from './content-hash';
import { entryToLocated } from './entry-to-located';
import type { BaselineEntry, RichBaselineEntry } from './types';

/** Files above this size are never stamped (see the module header). */
export const CONTENT_STAMP_MAX_BYTES = 10 * 1024 * 1024;

/** `(file, line) => contentHash | undefined`, bound to one tree. */
export type ContentStamper = (file: string, line: number) => string | undefined;

/**
 * Build a stamper for the working tree at `cwd`. An absent `cwd` yields a
 * stamper that never stamps, so callers need no branch of their own.
 */
export function contentStamper(cwd: string | undefined): ContentStamper {
  if (!cwd) return () => undefined;
  const lines = new Map<string, readonly string[] | null>();
  const read = (file: string): readonly string[] | null => {
    const hit = lines.get(file);
    if (hit !== undefined) return hit;
    const content = readTreeLines(cwd, file);
    lines.set(file, content);
    return content;
  };
  return (file, line) => {
    if (!(line > 0)) return undefined;
    const fileLines = read(file);
    if (fileLines === null) return undefined;
    return computeContentHashFromLines(fileLines, line);
  };
}

/**
 * Stamp every located entry in `entries` that does not already carry a hash.
 * Locatedness is decided by `entryToLocated` — the exact projection the
 * matcher pairs on — so an entry is stamped iff the content pass could ever
 * read the stamp. Returns a new array; unstamped entries pass through as-is.
 *
 * Called by `runProducers` (both guardrail sides) and `captureFragment`
 * (the per-host capture path) — the two places entries are minted.
 */
export function stampEntries(
  entries: readonly RichBaselineEntry[],
  cwd: string | undefined,
): RichBaselineEntry[] {
  const stamp = contentStamper(cwd);
  return entries.map((entry) => stampOne(entry, stamp));
}

function stampOne(entry: RichBaselineEntry, stamp: ContentStamper): RichBaselineEntry {
  if ('contentHash' in entry && entry.contentHash !== undefined) return entry;
  const loc = entryToLocated(entry);
  if (loc.file === undefined || loc.line === undefined || !(loc.line > 0)) return entry;
  const contentHash = stamp(loc.file, loc.line);
  if (contentHash === undefined) return entry;
  // Safe: every entry variant `entryToLocated` gives a line locator declares
  // an optional `contentHash` (pinned by the relocation-invariant test).
  return { ...entry, contentHash } as RichBaselineEntry;
}

/** What `restampAtCommit` did, for the migrate lane's disclosure. */
export interface RestampResult {
  readonly entries: BaselineEntry[];
  /** Entries that gained a hash. */
  readonly restamped: number;
  /** Located entries left bare (file unreadable at the commit). */
  readonly unreadable: number;
}

/**
 * Restamp a PRE-SCHEME baseline's located entries by reading each file at
 * the baseline's anchor commit — the tree its line numbers describe. Used
 * only by the migrate lane (`vyuh-dxkit update`); the live scan path always
 * stamps from the working tree via `stampEntries`. One `git show` per unique
 * file, cached. A file unreadable at the commit leaves its entries bare
 * (counted, disclosed by the caller), never a throw.
 */
export function restampAtCommit(
  entries: readonly BaselineEntry[],
  cwd: string,
  commitSha: string,
): RestampResult {
  const cache = new Map<string, readonly string[] | null>();
  const readAtCommit = (file: string): readonly string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let content: readonly string[] | null = null;
    try {
      content = execFileSync('git', ['show', `${commitSha}:${file}`], {
        cwd,
        encoding: 'utf8',
        maxBuffer: CONTENT_STAMP_MAX_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).split('\n');
    } catch {
      content = null;
    }
    cache.set(file, content);
    return content;
  };
  let restamped = 0;
  let unreadable = 0;
  const out = entries.map((entry) => {
    if ('contentHash' in entry && entry.contentHash !== undefined) return entry;
    const loc = entryToLocated(entry);
    if (loc.file === undefined || loc.line === undefined || !(loc.line > 0)) return entry;
    const lines = readAtCommit(loc.file);
    if (lines === null) {
      unreadable += 1;
      return entry;
    }
    restamped += 1;
    const contentHash = computeContentHashFromLines(lines, loc.line);
    return { ...entry, contentHash } as BaselineEntry;
  });
  return { entries: out, restamped, unreadable };
}

/**
 * Read a repo-relative file from the working tree as split lines. `null`
 * when the path escapes the repo, is a symlink, exceeds the size cap, or
 * cannot be read as text (see the module header for why each case is a
 * deliberate no-stamp, not an error).
 */
function readTreeLines(cwd: string, file: string): readonly string[] | null {
  const rel = resolveInsideRepo(cwd, file);
  if (rel === null) return null;
  const abs = join(cwd, rel);
  try {
    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.size > CONTENT_STAMP_MAX_BYTES) return null;
    return readFileSync(abs, 'utf8').split('\n');
  } catch {
    return null;
  }
}
