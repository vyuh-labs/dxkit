/**
 * Content-hash STAMPING: the one entry point every producer of a LOCATED
 * finding kind uses to put a `contentHash` on its baseline entries
 * (CLAUDE.md Rule 2.30, one concept, one code path).
 *
 * The hash itself is computed by `content-hash.ts` (the only module that may
 * hash, per the Rule 9 `createHash` ban). This module owns the POLICY around
 * calling it, which every producer used to re-implement as a local closure:
 *
 *   - no commit available (a bare tree, an empty `commitSha`): no stamp;
 *   - a whole-file finding (`line <= 0`, e.g. `.env in git`): no stamp, the
 *     context window would be meaningless;
 *   - the file cannot be read at the commit (binary, deleted, unreachable):
 *     no stamp, the matcher's other passes still work.
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
 * entries through the same producers with `ProducerContext.commitSha`, so the
 * stamp lands on both sides through this one path; nothing here is
 * baseline-only. The arch-check keeps `computeContentHashFromCommit` private
 * to this module so a second stamping policy cannot grow beside it.
 */

import { computeContentHashFromCommit } from './content-hash';

/** Where to read file content from: the repo and the commit its entries are
 *  anchored to. The producer context supplies both. */
export interface ContentStampSource {
  readonly cwd: string;
  readonly commitSha: string;
}

/** `(file, line) => contentHash | undefined`, bound to one source. */
export type ContentStamper = (file: string, line: number) => string | undefined;

/**
 * Build the stamper for a source. `undefined` (or an empty `commitSha`)
 * yields a stamper that never stamps, so a producer needs no branch of
 * its own for the no-commit case.
 */
export function contentStamper(source: ContentStampSource | undefined): ContentStamper {
  if (!source || !source.cwd || !source.commitSha) return () => undefined;
  const { cwd, commitSha } = source;
  return (file, line) => {
    if (!(line > 0)) return undefined;
    return computeContentHashFromCommit(cwd, commitSha, file, line) ?? undefined;
  };
}

/**
 * The stamp source a `ProducerContext`-shaped object provides: `undefined`
 * when the tree has no commit to anchor to (the orchestrator records an empty
 * `commitSha` there), so callers pass it straight into `contentStamper`.
 */
export function contentStampSource(ctx: {
  readonly cwd: string;
  readonly commitSha: string;
}): ContentStampSource | undefined {
  return ctx.commitSha ? { cwd: ctx.cwd, commitSha: ctx.commitSha } : undefined;
}
