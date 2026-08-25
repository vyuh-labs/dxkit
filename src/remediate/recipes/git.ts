/**
 * The recipe phase's git surface: the small set of operations the runner
 * needs to enforce envelopes and commit per order. Injectable (tests use a
 * fake); the real implementation shells `git` with the one BOT_IDENTITY,
 * mirroring `../git-ops.ts` (the agent sweep's sibling, separate because
 * the recipe phase works the UNCOMMITTED tree, order by order, and must
 * only ever touch the paths a recipe changed: a locally dirty tree's
 * pre-existing edits are never staged, committed, or discarded here).
 */
import { execFileSync } from 'child_process';
import { BOT_IDENTITY } from '../../land-refresh';

export interface RecipeGit {
  /** Repo-relative paths with any uncommitted change (staged, unstaged, or
   *  untracked). */
  changedPaths(): string[];
  /** Discard the uncommitted changes to exactly these paths (restore
   *  tracked content, delete untracked files). Never wider than `paths`. */
  discardPaths(paths: readonly string[]): void;
  /** Stage exactly these paths and commit them with the bot identity. */
  commitPaths(paths: readonly string[], message: string): void;
  head(): string;
}

export function realRecipeGit(cwd: string): RecipeGit {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Porcelain lines are positional (`XY <path>`): trimming the output would
  // eat the first line's leading status space and shift its path slice.
  const gitRaw = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    changedPaths: () =>
      gitRaw(['status', '--porcelain'])
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          // Rename lines read `R  old -> new`; the NEW path is the changed one.
          const p = l.slice(3);
          const arrow = p.indexOf(' -> ');
          return (arrow >= 0 ? p.slice(arrow + 4) : p).trim().replace(/^"|"$/g, '');
        }),
    discardPaths(paths) {
      if (paths.length === 0) return;
      // Tracked content back to HEAD, one path at a time: a single batched
      // checkout aborts wholesale when ANY path is untracked ("pathspec did
      // not match"), leaving tracked edits in place. `--` guards against a
      // path that looks like a flag; clean removes the untracked strays.
      for (const p of paths) {
        try {
          git(['checkout', 'HEAD', '--', p]);
        } catch {
          // Untracked path: checkout has nothing to restore; clean handles it.
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
    head: () => git(['rev-parse', 'HEAD']),
  };
}
