/**
 * `vyuh-dxkit flow refresh` / `flow publish` — the contract-snapshot commands,
 * split from flow-cli.ts for module size (same CLI seam; the map/trace/console
 * views stay there). Publishing gathers the mesh; landing (`--land`) puts the
 * refreshed snapshots on the default branch via the tested landing module —
 * the on-merge refresh workflow is one call into this file.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as logger from './logger';
import { readFlowConfig } from './analyzers/flow/config';
import {
  buildConsumedContract,
  buildServedContract,
  readConsumedContract,
  readServedContract,
  writeConsumedContract,
  writeServedContract,
} from './analyzers/flow/contract';
import { publishFlow } from './analyzers/flow/publish';
import { landFlowRefresh, type FlowLandMode } from './analyzers/flow/land';
import { detectDefaultBranch } from './ship-installers';
import { emitJson, gatherModel, splitPaths, type FlowViewOptions } from './flow-cli';

/** Current HEAD commit SHA, or undefined outside a git repo (best-effort). */
function headCommitSha(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `vyuh-dxkit flow refresh` — write this repo's flow contract snapshots
 * (`.dxkit/flow/served.json` + `consumed.json`). A backend commits `served.json`
 * so a frontend in another repo can gate against it; a frontend commits
 * `consumed.json` so a backend can see who still binds each route. A monorepo
 * commits both (or neither — its guardrail computes both sides live). This is
 * the one command that needs a full flow gather + write; the per-PR gate reads
 * the committed snapshots (or gathers live in a monorepo) without a refresh.
 */
export async function runFlowRefresh(opts: FlowViewOptions): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow refresh');
  // Repo-relative locators — the snapshots are committed + cross-repo, so a
  // binding's `file` must mean the same thing on every machine (Rule 9).
  const model = await gatherModel(opts, { relativeTo: opts.cwd });
  const meta = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    ...(headCommitSha(opts.cwd) !== undefined ? { commitSha: headCommitSha(opts.cwd) } : {}),
  };
  const served = buildServedContract(model, meta);
  const consumed = buildConsumedContract(model, meta);
  const servedPath = writeServedContract(opts.cwd, served);
  const consumedPath = writeConsumedContract(opts.cwd, consumed);

  if (opts.json) {
    emitJson({
      served: { path: servedPath, routes: served.routes.length },
      consumed: { path: consumedPath, bindings: consumed.bindings.length },
    });
    return;
  }
  logger.success(
    `served.json: ${served.routes.length} route(s) · consumed.json: ${consumed.bindings.length} binding(s)`,
  );
  logger.info(`  ${path.relative(opts.cwd, servedPath)}`);
  logger.info(`  ${path.relative(opts.cwd, consumedPath)}`);
  logger.info('');
  logger.info('Commit these so the counterpart repo can gate against them.');
}

/**
 * `vyuh-dxkit flow publish` — the multi-repo handshake. Reads
 * `.dxkit/workspace.json`, gathers every participant's served routes (from its
 * local path, or pinned at a git ref), and writes this repo's `served.json` as
 * the UNION of the whole mesh — so this repo's gate resolves calls against
 * services it does not co-locate. With no participants it publishes this repo's
 * own served/consumed (the monorepo case). See `flow refresh` for the
 * single-repo snapshot without the mesh union.
 */
export async function runFlowPublish(opts: FlowViewOptions & { land?: string }): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow publish');
  const config = readFlowConfig(opts.cwd);
  const commitSha = headCommitSha(opts.cwd);
  // Landing needs the pre-publish snapshots: served to narrate what changed,
  // consumed for the substance check (a timestamp-only refresh never lands).
  const before = opts.land !== undefined ? readServedContract(opts.cwd) : undefined;
  const beforeConsumed = opts.land !== undefined ? readConsumedContract(opts.cwd) : undefined;
  const result = await publishFlow(opts.cwd, {
    stripUrlPrefixes: config.stripUrlPrefixes,
    sources: config.sources,
    specs: [
      ...splitPaths(opts.specs, opts.cwd),
      ...config.specs.map((s) => path.resolve(opts.cwd, s)),
    ],
    generatedAt: new Date().toISOString(),
    ...(commitSha !== undefined ? { commitSha } : {}),
  });

  if (opts.json) {
    emitJson({
      servedPath: result.servedPath,
      consumedPath: result.consumedPath,
      totalServedRoutes: result.totalServedRoutes,
      consumedBindings: result.consumedBindings,
      contentHash: result.contentHash,
      participants: result.participants,
    });
    return;
  }

  logger.success(
    `Published mesh contract: ${result.totalServedRoutes} served route(s) across ${result.participants.length} participant(s) + this repo (hash ${result.contentHash}).`,
  );
  for (const p of result.participants) {
    let detail: string;
    if (p.source === 'missing') detail = 'path not found — skipped';
    else if (p.source === 'unreachable') detail = 'remote fetch failed — skipped';
    else {
      // Provenance: the commit each participant's routes were gathered at is
      // recorded on the snapshot, so doctor can later tell when the provider
      // has moved past this publish.
      const at = p.sha ? ` @ ${p.sha.slice(0, 12)}` : '';
      detail = `${p.routes} route(s) (${p.source}${at})`;
    }
    logger.info(`  • ${p.name}: ${detail}`);
  }
  logger.info(`  ${path.relative(opts.cwd, result.servedPath)}`);
  logger.info(`  ${path.relative(opts.cwd, result.consumedPath)}`);
  if (opts.land === undefined) {
    logger.info('');
    logger.info('Commit these so this repo can gate against the whole mesh offline.');
    return;
  }

  // ── landing: put the refreshed snapshots on the default branch ──
  const mode: FlowLandMode =
    opts.land === 'pr' || opts.land === 'push' ? opts.land : config.refreshMode;
  const landed = landFlowRefresh({
    cwd: opts.cwd,
    mode,
    before,
    beforeConsumed,
    defaultBranch: detectDefaultBranch(opts.cwd),
  });
  const deltaLine =
    `+${landed.delta.added.length} route(s), −${landed.delta.removed.length} removed` +
    (landed.delta.removed.length > 0 ? ' — review the removals' : '');
  switch (landed.outcome) {
    case 'clean':
      logger.info('Snapshots unchanged — nothing to land.');
      break;
    case 'pushed':
      logger.success(`Landed on the default branch (push mode): ${deltaLine}.`);
      break;
    case 'pr-opened':
      logger.success(`Opened the standing refresh PR: ${landed.prUrl ?? ''} (${deltaLine}).`);
      break;
    case 'pr-updated':
      logger.success(`Updated the standing refresh PR: ${landed.prUrl ?? ''} (${deltaLine}).`);
      break;
    case 'branch-pushed-no-pr':
      logger.warn(landed.note ?? 'Branch pushed; open the PR manually.');
      break;
  }
}
