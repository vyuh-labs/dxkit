/**
 * The `lockfile-sync` recipe: a `stale-lockfile` order (the lockfile-sync
 * floor check failed: CI's frozen install cannot load this tree) is fixed
 * by the PRODUCING PACK's lock-writing install at the owning root (its
 * `installStrategy` resync mode, through the ONE install executor; the
 * pack's `remediation.resyncLockfile` declaration is what admits the order
 * to this recipe, Rule 6), then verified by the SAME pack-declared frozen
 * dry-run the floor runs (`lockfileCheck`, via the correctness module's
 * single-check entry point: one concept, one code path). A verify the pack
 * cannot give (yarn's declared skip) is a refusal, never an unconfirmed
 * "applied".
 */
import * as path from 'path';
import { tail } from '../../analyzers/tools/bounded-exec';
import { runSingleLockfileCheck } from '../../analyzers/correctness/single-checks';
import type { WorkOrder } from '../work-orders/types';
import {
  ambiguousRootReason,
  exemptionReason,
  owningManifestRoot,
  packDeclaration,
  packStrategyAt,
  runResyncInstall,
} from './shared';
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
  const declaration = packDeclaration(pack, 'resyncLockfile');
  if (declaration === undefined) {
    return { kind: 'refused', reason: `no registered language pack has the id '${pack}'` };
  }
  if (declaration.kind === 'exemption') {
    return { kind: 'refused', reason: exemptionReason(pack, declaration) };
  }
  const rootDir = owningManifestRoot(order, declaration.provider.manifestFiles);
  if (rootDir === null) {
    return {
      kind: 'refused',
      reason: ambiguousRootReason(declaration.provider.manifestFiles, 'the owning dependency root'),
    };
  }
  // The pack's per-repo admission check (pure fs reads): a tree shape
  // where the declared resync would be unsound (a vendored go module, a
  // go.work workspace) refuses up front instead of burning a run on a
  // diff the verify or the envelope enforcement must discard.
  const admission = declaration.provider.refusal?.({ cwd: ctx.cwd, rootDir }) ?? null;
  if (admission !== null) return { kind: 'refused', reason: admission };
  const rootAbs = path.join(ctx.cwd, rootDir);
  // The pack's install strategy at this root (the ONE install seam): its
  // resync mode is the fix, its lockfile is what the fix rewrites.
  const strategy = packStrategyAt(pack, ctx.cwd, rootDir);
  if (strategy === null || strategy.lockfile === null) {
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
  const verify = runSingleLockfileCheck(rootAbs, pack, ctx.exec, ctx.tolerances);
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
    changedFiles: [rootDir ? `${rootDir}/${strategy.lockfile}` : strategy.lockfile],
    ...(verify.note ? { notes: [verify.note] } : {}),
  };
}
