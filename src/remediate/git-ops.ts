/**
 * The remediate runner's real git operations, split from `run.ts` for module
 * size. The sweep NEVER names runtime paths in the add pathspec — git
 * hard-errors on a pathspec matching only gitignored paths (the script's
 * observed failure); stage everything, then un-stage runtime state.
 */
import { execFileSync } from 'child_process';
import { BOT_IDENTITY } from '../land-refresh';
import { DXKIT_RUNTIME_ARTIFACT_PATHS, isRuntimeArtifactPath } from '../runtime-artifacts';
import type { RemediateGit } from './run';

/** Runtime paths as pathspecs for staged-restore (strip trailing slash). */
const RUNTIME_PATHSPECS = DXKIT_RUNTIME_ARTIFACT_PATHS.map((p) => p.replace(/\/$/, ''));

export function realGit(cwd: string): RemediateGit {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    head: () => git(['rev-parse', 'HEAD']),
    sweepLeftovers() {
      const status = git(['status', '--porcelain']);
      const leftovers = status
        .split('\n')
        .filter((l) => l.trim() && !isRuntimeArtifactPath(l.slice(3).trim()));
      if (leftovers.length === 0) return undefined;
      try {
        git(['add', '-A']);
        try {
          git(['restore', '--staged', '--', ...RUNTIME_PATHSPECS]);
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
    scrubRuntimeArtifacts(baseHead: string) {
      // The sweep keeps runtime state out of ITS commit, but the AGENT
      // commits as it goes and can commit scan output it generated mid-run
      // (observed live: a salvage draft carrying .dxkit/reports/* +
      // .dxkit/cache/*). Drop from the attempt every runtime-artifact path
      // that did NOT exist at the base — a repo that deliberately tracks
      // reports keeps them; only artifacts this attempt introduced are
      // regenerable noise. Fail-open: a scrub error leaves the attempt
      // as-is (the guardrail still gates it).
      try {
        const changed = git(['diff', '--name-only', baseHead, 'HEAD']).split('\n').filter(Boolean);
        const baseTracked = new Set(
          git(['ls-tree', '-r', '--name-only', baseHead]).split('\n').filter(Boolean),
        );
        const scrub = changed.filter((f) => isRuntimeArtifactPath(f) && !baseTracked.has(f));
        if (scrub.length === 0) return [];
        git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...scrub]);
        git([
          '-c',
          `user.name=${BOT_IDENTITY.name}`,
          '-c',
          `user.email=${BOT_IDENTITY.email}`,
          'commit',
          '-q',
          '-m',
          'chore: drop dxkit runtime artifacts from the attempt (regenerable scan state)',
        ]);
        return scrub;
      } catch {
        return [];
      }
    },
    // CONTENT diff, not commit count: a resume's empty marker commit (or an
    // attempt whose only content was scrubbed runtime state) has commits but
    // changes nothing — reporting it as a diff would verify and land
    // nothing-shaped work.
    hasDiff: (baseHead: string) => git(['diff', '--name-only', baseHead, 'HEAD']) !== '',
  };
}
