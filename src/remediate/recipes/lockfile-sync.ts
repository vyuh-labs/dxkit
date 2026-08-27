/**
 * The `lockfile-sync` recipe: a `stale-lockfile` order (the lockfile-sync
 * floor check failed: CI's frozen install cannot load this tree) is fixed
 * by the ecosystem's lock-WRITING install at the owning root, then verified
 * by the SAME pack-declared frozen dry-run the floor runs (`lockfileCheck`,
 * via the correctness module's single-check entry point: one concept, one
 * code path). A verify the pack cannot give (yarn's declared skip) is a
 * refusal, never an unconfirmed "applied".
 */
import * as path from 'path';
import { tail } from '../../analyzers/tools/bounded-exec';
import { runSingleLockfileCheck } from '../../analyzers/correctness/single-checks';
import type { WorkOrder } from '../work-orders/types';
import { nodePmAt, nodeStrategyAt, owningManifestRoot, runResyncInstall } from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

/** The pack that produced the order's floor finding. */
function producingPack(order: WorkOrder): string | null {
  const e = order.findings[0]?.evidence;
  return e && e.type === 'floor' ? e.pack : null;
}

export async function executeLockfileSync(
  order: WorkOrder,
  ctx: RecipeExecuteContext,
): Promise<RecipeOutcome> {
  const pack = producingPack(order);
  if (pack === null) {
    return { kind: 'refused', reason: 'the order carries no floor evidence naming its pack' };
  }
  const rootDir = owningManifestRoot(order);
  if (rootDir === null) {
    return {
      kind: 'refused',
      reason:
        'the envelope does not name exactly one package.json, so the owning dependency root ' +
        'is ambiguous',
    };
  }
  const rootAbs = path.join(ctx.cwd, rootDir);
  const strategy = nodeStrategyAt(ctx.cwd, rootDir);
  // The lockfile actually present (a shrinkwrap counts), from the same file
  // presence the strategy keyed on.
  const lock = nodePmAt(ctx.cwd, rootDir);
  if (strategy === null || strategy.lockfile === null || lock === null) {
    return {
      kind: 'refused',
      reason: `no lockfile exists at ${rootDir || 'the repo root'}, so there is nothing to re-sync`,
    };
  }

  const installFailure = runResyncInstall(strategy, rootAbs, ctx);
  if (installFailure) return installFailure;

  // Verify with the pack's own frozen dry-run, the exact check that minted
  // the order. Only a real PASS confirms; a skip (yarn's declared no-dry-run,
  // a missing binary) means the recipe cannot claim the fix and says so.
  const verify = runSingleLockfileCheck(rootAbs, pack, ctx.exec);
  if (verify === null) {
    return {
      kind: 'refused',
      reason: `the ${pack} pack declares no lockfile-sync check here, so the resync cannot be verified`,
    };
  }
  if (verify.status !== 'pass') {
    return {
      kind: 'failed',
      step: 'verify-lockfile-sync',
      output: tail(
        `${verify.status}: ${verify.output ?? 'the frozen dry-run did not pass after the resync'}`,
      ),
    };
  }
  return {
    kind: 'applied',
    changedFiles: [rootDir ? `${rootDir}/${lock.lockfile}` : lock.lockfile],
    ...(verify.note ? { notes: [verify.note] } : {}),
  };
}
