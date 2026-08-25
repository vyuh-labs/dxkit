/**
 * Helpers the recipe executors share: the owning-manifest-root derivation
 * (from the order's own envelope, never a second discovery walk) and the
 * one resync-install runner (the lock-writing install with its declared
 * fallback doctrine, executed through the injected bounded exec).
 */
import * as path from 'path';
import { tail, type CommandExec } from '../../analyzers/tools/bounded-exec';
import {
  detectLockfile,
  isPeerConflictOnly,
  resyncInstallFor,
  type ResyncInstall,
} from '../../package-manager';
import type { WorkOrder } from '../work-orders/types';
import type { RecipeOutcome } from './types';

/**
 * The dependency root an order's fix belongs to, derived from the order's
 * OWN envelope (the planner already scoped it): the directory of the one
 * `package.json` the envelope names. Two roots in one envelope means the
 * planner could not decide (the all-roots fallback); the recipe refuses
 * rather than guess which manifest to edit.
 */
export function owningManifestRoot(order: WorkOrder): string | null {
  const dirs = new Set(
    order.envelope.paths
      .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
      .map((p) => (p === 'package.json' ? '' : p.slice(0, -'/package.json'.length))),
  );
  return dirs.size === 1 ? [...dirs][0] : null;
}

/** The node package manager owning `rootDir` (repo-relative; '' = repo
 *  root), from the lockfile actually present (the ONE detector). */
export function nodePmAt(cwd: string, rootDir: string): ReturnType<typeof detectLockfile> {
  return detectLockfile(path.join(cwd, rootDir));
}

/**
 * Run the lock-writing install at a root, honoring the declared fallback
 * doctrine (the npm peer-conflict retry, gated by the shared
 * `isPeerConflictOnly`, never a blanket retry). Returns null on success,
 * or a `failed` outcome naming the step. Infrastructure (missing binary,
 * timeout, capture overflow) is a failure of THIS recipe run, named; the
 * order simply stays open for the agent tier.
 */
export function runResyncInstall(
  plan: ResyncInstall,
  rootAbs: string,
  exec: CommandExec,
): Extract<RecipeOutcome, { kind: 'failed' }> | null {
  const attempt = (argv: readonly string[]) => {
    const [bin, ...args] = argv;
    return exec({ bin, args }, rootAbs);
  };
  const primary = attempt(plan.argv);
  if (!primary.available) {
    return { kind: 'failed', step: 'install', output: `${plan.argv[0]} is not available here` };
  }
  if (primary.timedOut) {
    return { kind: 'failed', step: 'install', output: `${plan.argv.join(' ')} timed out` };
  }
  if (primary.overflowed) {
    return {
      kind: 'failed',
      step: 'install',
      output: `${plan.argv.join(' ')} overflowed the capture buffer`,
    };
  }
  if (primary.code === 0) return null;
  if (plan.fallback && isPeerConflictOnly(primary.output)) {
    const fb = attempt(plan.fallback.argv);
    if (fb.available && !fb.timedOut && !fb.overflowed && fb.code === 0) return null;
    return {
      kind: 'failed',
      step: 'install',
      output: tail(
        `${primary.output}\n--- fallback (${plan.fallback.argv.join(' ')}) ---\n${fb.output}`,
      ),
    };
  }
  return { kind: 'failed', step: 'install', output: tail(primary.output) };
}

export { resyncInstallFor };
