/**
 * Flow publish — the multi-repo handshake behind `flow publish`.
 *
 * `flow refresh` writes ONE repo's served/consumed snapshots. `flow publish`
 * goes further: it reads `.dxkit/workspace.json` and, for every participant,
 * gathers that service's served routes (from its local path, optionally pinned
 * at a git ref via `withRefWorktree`, Rule 11) and UNIONS them into this repo's
 * `served.json`. The consuming repo then gates its calls against the whole mesh,
 * not just the routes it happens to co-locate — the handshake that lets a
 * frontend repo resolve calls to a backend it does not contain.
 *
 * With no participants it degenerates to a single-repo publish (this repo's own
 * served ∪ nothing), the monorepo case. Fail-open per participant: a missing
 * path or an unreachable ref drops that participant to zero routes rather than
 * failing the publish. Reuses the canonical contract builders (Rule 2).
 */

import * as fs from 'fs';
import * as path from 'path';
import { readWorkspace, type WorkspaceParticipant } from '../../workspace';
import { withRefWorktree, resolveRefToSha } from '../../baseline/ref-baseline';
import { gatherFlowModel } from './gather';
import {
  buildServedContract,
  buildConsumedContract,
  writeServedContract,
  writeConsumedContract,
  contractKey,
  servedContentHash,
  type ServedRoute,
  type ServedContract,
} from './contract';

/** Where a participant's served routes came from. */
export type ParticipantSource = 'local' | 'ref' | 'missing';

export interface PublishedParticipant {
  readonly name: string;
  readonly routes: number;
  readonly source: ParticipantSource;
}

export interface PublishResult {
  readonly servedPath: string;
  readonly consumedPath: string;
  /** One entry per workspace participant (empty in the single-repo case). */
  readonly participants: readonly PublishedParticipant[];
  /** Total served routes in the unioned mesh contract. */
  readonly totalServedRoutes: number;
  /** This repo's own consumed bindings (the mesh's consumed side is per-repo). */
  readonly consumedBindings: number;
  readonly contentHash: string;
}

export interface PublishOptions {
  readonly stripUrlPrefixes?: readonly string[];
  readonly specs?: readonly string[];
  /** Stamped onto the snapshot meta (kept out of this module for testability). */
  readonly generatedAt: string;
  readonly commitSha?: string;
}

/** Meta with only the fields a participant gather needs — routes carry no
 *  timestamp of their own, so a clock-free placeholder keeps the gather pure. */
const GATHER_META = { schemaVersion: 1 as const, generatedAt: '' };

/** Dedupe served routes to one per `(method, path)` — the mesh may serve the
 *  same route from this repo and a participant, or from two participants. */
function dedupeServed(routes: readonly ServedRoute[]): ServedRoute[] {
  const seen = new Map<string, ServedRoute>();
  for (const r of routes) {
    const key = contractKey(r.method, r.path);
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

async function servedRoutesFrom(root: string, opts: PublishOptions): Promise<ServedRoute[]> {
  const model = await gatherFlowModel({
    roots: [root],
    ...(opts.specs ? { specs: opts.specs.map((s) => path.resolve(root, s)) } : {}),
    ...(opts.stripUrlPrefixes ? { stripUrlPrefixes: [...opts.stripUrlPrefixes] } : {}),
    relativeTo: root,
  });
  return buildServedContract(model, GATHER_META).routes;
}

/** Gather one participant's served routes. Local path by default; pinned at a
 *  git ref when the participant declares one AND that ref resolves. Fail-open:
 *  a missing path → zero routes; an unresolvable ref → fall back to the tree. */
async function gatherParticipant(
  cwd: string,
  participant: WorkspaceParticipant,
  opts: PublishOptions,
): Promise<{ routes: ServedRoute[]; source: ParticipantSource }> {
  const abs = path.resolve(cwd, participant.path);
  if (!fs.existsSync(abs)) return { routes: [], source: 'missing' };

  if (participant.ref && resolveRefToSha(abs, participant.ref)) {
    try {
      const routes = await withRefWorktree({ cwd: abs, ref: participant.ref }, (wt) =>
        servedRoutesFrom(wt, opts),
      );
      return { routes, source: 'ref' };
    } catch {
      // Worktree/gather failure → fall through to the working tree.
    }
  }
  try {
    return { routes: await servedRoutesFrom(abs, opts), source: 'local' };
  } catch {
    return { routes: [], source: 'missing' };
  }
}

/**
 * Publish the mesh contract: this repo's served routes ∪ every participant's,
 * written to `.dxkit/flow/served.json`, plus this repo's own `consumed.json`.
 */
export async function publishFlow(cwd: string, opts: PublishOptions): Promise<PublishResult> {
  const baseMeta = {
    schemaVersion: 1 as const,
    generatedAt: opts.generatedAt,
    ...(opts.commitSha ? { commitSha: opts.commitSha } : {}),
  };

  // This repo's own model — its served routes seed the mesh; its consumed side
  // is published as-is (consumed is inherently per-repo).
  const selfModel = await gatherFlowModel({
    roots: [cwd],
    ...(opts.specs ? { specs: opts.specs.map((s) => path.resolve(cwd, s)) } : {}),
    ...(opts.stripUrlPrefixes ? { stripUrlPrefixes: [...opts.stripUrlPrefixes] } : {}),
    relativeTo: cwd,
  });
  const selfServed = buildServedContract(selfModel, baseMeta);
  const consumed = buildConsumedContract(selfModel, baseMeta);

  const allRoutes: ServedRoute[] = [...selfServed.routes];
  const participants: PublishedParticipant[] = [];
  for (const p of readWorkspace(cwd)?.participants ?? []) {
    const { routes, source } = await gatherParticipant(cwd, p, opts);
    participants.push({ name: p.name, routes: routes.length, source });
    allRoutes.push(...routes);
  }

  const mesh = dedupeServed(allRoutes);
  const contentHash = servedContentHash(mesh);
  const servedContract: ServedContract = { side: 'served', ...baseMeta, contentHash, routes: mesh };

  const servedPath = writeServedContract(cwd, servedContract);
  const consumedPath = writeConsumedContract(cwd, consumed);

  return {
    servedPath,
    consumedPath,
    participants,
    totalServedRoutes: mesh.length,
    consumedBindings: consumed.bindings.length,
    contentHash,
  };
}
