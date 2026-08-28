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
import { realRecipeGit } from './recipes/git';

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
    enforceEnvelope(baseHead, isAllowed) {
      // The envelope's enforcement half (the order prompt is advisory):
      // every committed change outside the allowed set is reverted to its
      // base state — a base-tracked file back to base content, a new file
      // removed — in ONE disclosure commit, same doctrine as the
      // runtime-artifact scrub. Runs after the leftover sweep, so the tree
      // is clean and only commits are in play. Fail-CLOSED: an enforcement
      // error is returned and the caller must not land the unenforced diff.
      try {
        // --no-renames: a rename must surface BOTH sides (the old path as a
        // deletion, the new as an addition). Under rename detection the diff
        // lists only the post-image, so enforcing an out-of-envelope
        // `git mv` would DELETE the base file (the restore below never saw
        // its old path) and land that destructive change undisclosed.
        const changed = git(['diff', '--no-renames', '--name-only', baseHead, 'HEAD'])
          .split('\n')
          .filter(Boolean);
        const outside = changed.filter((f) => !isAllowed(f));
        if (outside.length === 0) return { dropped: [] };
        const baseTracked = new Set(
          git(['ls-tree', '-r', '--name-only', baseHead]).split('\n').filter(Boolean),
        );
        for (const f of outside) {
          if (baseTracked.has(f)) {
            git(['checkout', baseHead, '--', f]);
          } else {
            git(['rm', '-f', '-q', '--ignore-unmatch', '--', f]);
          }
        }
        git([
          '-c',
          `user.name=${BOT_IDENTITY.name}`,
          '-c',
          `user.email=${BOT_IDENTITY.email}`,
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'chore: drop out-of-envelope changes (enforced by the runner, disclosed in the ledger)',
        ]);
        return { dropped: outside };
      } catch (e) {
        const lines =
          e instanceof Error ? e.message.split('\n').filter((l) => l.trim()) : [String(e)];
        return { dropped: [], error: lines[lines.length - 1] ?? String(e) };
      }
    },
    resetTo(head) {
      git(['reset', '-q', '--hard', head]);
    },
    changedPaths(baseHead, head) {
      return git(['diff', '--no-renames', '--name-only', baseHead, head ?? 'HEAD'])
        .split('\n')
        .filter(Boolean);
    },
    // The ONE path-scoped bot commit (the recipe phase's surface).
    commitPaths: (paths, message) => realRecipeGit(cwd).commitPaths(paths, message),
    cleanPaths(paths) {
      // Path-scoped: `git clean` with explicit pathspecs removes only the
      // UNTRACKED files among them — never a blanket clean of the tree.
      if (paths.length === 0) return;
      git(['clean', '-f', '-q', '--', ...paths]);
    },
    revertRange(from, to, message) {
      // The containment unwind: revert one unit's committed range as a
      // single new commit at the tip, so later kept commits are untouched.
      // A conflicting revert throws AFTER its own in-progress state is
      // cleaned up (sequencer aborted, tree reset to the tip): the caller
      // refuses containment; a half-applied revert must never linger.
      try {
        git(['revert', '--no-commit', `${from}..${to}`]);
      } catch (err) {
        try {
          git(['revert', '--abort']);
        } catch {
          // no revert in progress: nothing to abort
        }
        try {
          git(['reset', '-q', '--hard', 'HEAD']);
        } catch {
          // the caller's restore (resetTo) is the backstop
        }
        throw err;
      }
      git([
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
      ]);
    },
    revertPaths(baseHead, paths) {
      // Targeted revert of the branch's own commits: move the branch back
      // (soft, so the working tree and any user dirt stay untouched), then
      // restore exactly the named paths to their base state. A path
      // tracked at the base returns to base content; one absent at the
      // base is removed. Everything else in the tree is left alone.
      git(['reset', '-q', '--soft', baseHead]);
      const baseTracked = new Set(
        git(['ls-tree', '-r', '--name-only', baseHead]).split('\n').filter(Boolean),
      );
      for (const p of paths) {
        if (baseTracked.has(p)) {
          git(['checkout', baseHead, '--', p]);
        } else {
          git(['rm', '-f', '-q', '--ignore-unmatch', '--', p]);
        }
      }
    },
  };
}
