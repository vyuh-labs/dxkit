/**
 * Content-hash STAMPING: the one entry point every producer of a LOCATED
 * finding kind uses to put a `contentHash` on its baseline entries
 * (CLAUDE.md Rule 2.30, one concept, one code path).
 *
 * The hash itself is computed by `content-hash.ts` (the only module that may
 * hash, per the Rule 9 `createHash` ban). This module owns the POLICY around
 * calling it, which every producer used to re-implement as a local closure:
 *
 *   - no source (a producer running without a repo path): no stamp;
 *   - a whole-file finding (`line <= 0`, e.g. `.env in git`): no stamp, the
 *     context window would be meaningless;
 *   - the file cannot be read (binary-ish, deleted, outside the tree): no
 *     stamp, the matcher's other passes still work.
 *
 * WHICH content is hashed matters as much as whether: every scanner reads the
 * WORKING TREE, so a finding's `line` is a working-tree line. The stamp reads
 * the same tree. Reading the file at a commit instead (the 4.4.4 shape) hashed
 * pre-change content at post-change lines on a dirty tree (the loop Stop-gate
 * and pre-push surfaces), so the reformat this scheme exists to survive did
 * not pair while uncommitted, and a same-rule finding newly introduced at a
 * line that still hashed to the prior window could pair as "persisted". On a
 * clean checkout (baseline create in CI, the guardrail on a PR head) the tree
 * IS the commit, so the two readings agree there and only there. Reading the
 * tree also costs one file read per file instead of one `git show` process
 * per finding (ten thousand spawns on a real lint backlog).
 *
 * Why one entry point matters: the security producer stamped, the
 * custom-check producer did not, and nothing forced parity. On a real repo
 * that left 0 of ~10k grandfathered lint entries with a hash, so the git-aware
 * matcher's content-hash pass (the ONE pass that survives a whole-file
 * reformat, because it normalizes whitespace) never fired for lint: one
 * reindent read as thousands of "resolved" plus dozens of "net-new" lint
 * findings. Routing every located kind through `contentStamper` means a
 * producer cannot forget to stamp, and `test/baseline/content-stamp-parity.test.ts`
 * pins that every registered producer's line-carrying entries carry a hash.
 *
 * Both sides of the guardrail (baseline create AND the current scan) build
 * entries through the same producers, so the stamp lands on both sides through
 * this one path; nothing here is baseline-only. The arch-check keeps the hash
 * primitive `computeContentHash` private to `content-hash.ts` plus this module
 * so a second stamping policy cannot grow beside it.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';

import { computeContentHash } from './content-hash';

/** Where to read file content from: the repo whose working tree the findings
 *  were scanned on. The producer context supplies it. */
export interface ContentStampSource {
  readonly cwd: string;
}

/** `(file, line) => contentHash | undefined`, bound to one source. */
export type ContentStamper = (file: string, line: number) => string | undefined;

/**
 * Build the stamper for a source. `undefined` yields a stamper that never
 * stamps, so a producer needs no branch of its own for the no-source case.
 * File content is cached per path for the stamper's lifetime: a producer
 * stamps every finding of a file in one pass, so each file is read once.
 */
export function contentStamper(source: ContentStampSource | undefined): ContentStamper {
  if (!source || !source.cwd) return () => undefined;
  const { cwd } = source;
  const cache = new Map<string, string | null>();
  const read = (file: string): string | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    const content = readTreeFile(cwd, file);
    cache.set(file, content);
    return content;
  };
  return (file, line) => {
    if (!(line > 0)) return undefined;
    const content = read(file);
    if (content === null) return undefined;
    return computeContentHash(content, line);
  };
}

/**
 * The stamp source a `ProducerContext`-shaped object provides. A context
 * always carries the tree it scanned, so the stamper always has a source;
 * the commit anchor is not needed to read the tree.
 */
export function contentStampSource(ctx: { readonly cwd: string }): ContentStampSource | undefined {
  return ctx.cwd ? { cwd: ctx.cwd } : undefined;
}

/**
 * Read a repo-relative file from the working tree. `null` when the path
 * escapes the tree (a finding's `file` is repo-relative by contract; an
 * absolute or `..`-prefixed path is not something to hash), or when the
 * file cannot be read as text (missing, a directory, unreadable).
 */
function readTreeFile(cwd: string, file: string): string | null {
  if (isAbsolute(file)) return null;
  const rel = normalize(file);
  if (rel.startsWith('..')) return null;
  const abs = join(cwd, rel);
  if (relative(cwd, abs).startsWith('..')) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
