/**
 * The remediate runner's real git operations, split from `run.ts` for module
 * size. The sweep NEVER names runtime paths in the add pathspec — git
 * hard-errors on a pathspec matching only gitignored paths (the script's
 * observed failure); stage everything, then un-stage runtime state.
 */
import { execFileSync } from 'child_process';
import { BOT_IDENTITY } from '../land-refresh';
import type { RemediateGit } from './run';

export function realGit(cwd: string): RemediateGit {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    head: () => git(['rev-parse', 'HEAD']),
    sweepLeftovers() {
      const status = git(['status', '--porcelain']);
      const leftovers = status
        .split('\n')
        .filter(
          (l) =>
            l.trim() &&
            !l.includes('.dxkit/loop') &&
            !l.includes('.dxkit/cache') &&
            !l.includes('.dxkit/reports'),
        );
      if (leftovers.length === 0) return undefined;
      try {
        git(['add', '-A']);
        try {
          git(['restore', '--staged', '--', '.dxkit/loop', '.dxkit/cache', '.dxkit/reports']);
        } catch {
          // nothing staged from runtime paths — fine
        }
        // Explicit bot identity (Rule 2: the one BOT_IDENTITY) — a CI
        // runner has no ambient git identity, and the sweep must commit
        // there or the whole lane reads as no-op.
        git([
          '-c',
          `user.name=${BOT_IDENTITY.name}`,
          '-c',
          `user.email=${BOT_IDENTITY.email}`,
          'commit',
          '-q',
          '-m',
          'chore: commit remaining agent working state (swept by the runner — review closely)',
        ]);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message.split('\n').slice(-1)[0] : String(e);
      }
    },
    hasDiff: (baseHead: string) => git(['rev-list', '--count', `${baseHead}..HEAD`]) !== '0',
  };
}
