/**
 * The recipe phase's git surface: the small set of operations the runner
 * needs to enforce envelopes and commit per order. Injectable (tests use a
 * fake); the real implementation shells `git` with the one BOT_IDENTITY.
 *
 * "What did the working tree change?" is the canonical concept in
 * `src/baseline/changed-files.ts` (Rule 2.30), so `changedPaths` IS
 * `computeChangedPaths(cwd, 'HEAD')`: the deletions-inclusive projection,
 * with unescaped (non-quoted) paths, diffing HEAD against the working tree
 * (staged + unstaged + untracked), which is exactly the uncommitted set. A `null`
 * from the canonical helper (git itself failed) THROWS here: the phase
 * runner must never enforce an envelope against an unknown tree, and the
 * throw surfaces as a named per-order failure, not a silent pass.
 *
 * This surface only ever touches the paths a recipe changed: a locally
 * dirty tree's pre-existing edits are never staged, committed, or
 * discarded here.
 */
import { execFileSync } from 'child_process';
import { computeChangedPaths } from '../../baseline/changed-files';
import { BOT_IDENTITY } from '../../land-refresh';

export interface RecipeGit {
  /** Repo-relative paths with any uncommitted change (staged, unstaged, or
   *  untracked; deletions included). Throws when the tree state cannot be
   *  determined; the caller records a named failure. */
  changedPaths(): string[];
  /** Discard the uncommitted changes to exactly these paths (restore
   *  tracked content, delete untracked files). Never wider than `paths`. */
  discardPaths(paths: readonly string[]): void;
  /** Stage exactly these paths and commit them with the bot identity. */
  commitPaths(paths: readonly string[], message: string): void;
}

export function realRecipeGit(cwd: string): RecipeGit {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    changedPaths() {
      const paths = computeChangedPaths(cwd, 'HEAD');
      if (paths === null) {
        throw new Error('could not determine the uncommitted working-tree state (git failed)');
      }
      return [...paths];
    },
    discardPaths(paths) {
      if (paths.length === 0) return;
      // Tracked content back to HEAD, one path at a time: a single batched
      // restore aborts wholesale when ANY path is untracked ("pathspec did
      // not match"), leaving tracked edits in place. `--` guards against a
      // path that looks like a flag; clean removes the untracked strays.
      for (const p of paths) {
        try {
          git(['checkout', 'HEAD', '--', p]);
        } catch {
          // Untracked path: nothing to restore; clean below handles it.
        }
      }
      git(['clean', '-fd', '--', ...paths]);
    },
    commitPaths(paths, message) {
      if (paths.length === 0) return;
      git(['add', '--', ...paths]);
      git([
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        'commit',
        '-q',
        '-m',
        message,
      ]);
    },
  };
}
