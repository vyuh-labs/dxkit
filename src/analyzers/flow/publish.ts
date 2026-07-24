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
import { withRemoteRefWorktree } from '../../baseline/remote-ref';
import { gatherFlowModel } from './gather';
import type { FlowSourceDecl } from './contract-sources';
import { loadFlowPluginOverlay } from '../../extensions/plugin-host';
import {
  buildServedContract,
  buildConsumedContract,
  writeServedContract,
  writeConsumedContract,
  contractKey,
  servedContentHash,
  type ServedRoute,
  type ServedContract,
  type ParticipantSource,
  type ParticipantProvenance,
} from './contract';
import { trustedLocalContext } from '../../analysis-trust';

// The source taxonomy lives on the contract schema (contract.ts) — provenance
// is a committed artifact field now, not just CLI display. Re-exported so
// existing importers keep working.
export type { ParticipantSource } from './contract';

export interface PublishedParticipant {
  readonly name: string;
  readonly routes: number;
  readonly source: ParticipantSource;
  /** Commit the participant's routes were gathered at, when resolvable. */
  readonly sha?: string;
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
  /**
   * Declared contract artifacts (`flow.sources`) for the SELF side —
   * a pact/HAR-declared consumed call publishes exactly like an extracted
   * one, and a served-side artifact seeds the mesh. (Participants gather
   * without this repo's sources; theirs ride their own publish.)
   */
  readonly sources?: readonly FlowSourceDecl[];
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

/**
 * Gather one participant's served routes. Resolution order (Rule 11 primitives):
 *   1. LOCAL checkout, when `path` is set and exists on disk — preferred because
 *      it is offline and fast. Pinned at a git ref via `withRefWorktree` when the
 *      participant declares one AND it resolves in that checkout; else the
 *      working tree.
 *   2. REMOTE clone, when no usable local checkout but a `repo:` URL is set —
 *      `withRemoteRefWorktree` fetches it shallowly at `ref` (default HEAD). This
 *      is why `{ path, repo, ref }` uses the sibling on a dev machine and clones
 *      in CI where the sibling isn't checked out.
 * Fail-open throughout: a missing local path with no `repo` → `missing`; a clone
 * failure → `unreachable`; a local gather failure → `missing`. A participant
 * never wedges a publish.
 */
async function gatherParticipant(
  cwd: string,
  participant: WorkspaceParticipant,
  opts: PublishOptions,
): Promise<{ routes: ServedRoute[]; source: ParticipantSource; sha?: string }> {
  const abs = participant.path ? path.resolve(cwd, participant.path) : null;

  if (abs && fs.existsSync(abs)) {
    if (participant.ref) {
      // Provenance: the commit the routes are gathered AT — the staleness
      // anchor doctor later compares against the participant's current tip.
      const pinnedSha = resolveRefToSha(abs, participant.ref);
      if (pinnedSha) {
        try {
          const routes = await withRefWorktree({ cwd: abs, ref: participant.ref }, (wt) =>
            servedRoutesFrom(wt, opts),
          );
          return { routes, source: 'ref', sha: pinnedSha };
        } catch {
          // Worktree/gather failure → fall through to the working tree.
        }
      }
    }
    try {
      const routes = await servedRoutesFrom(abs, opts);
      const headSha = resolveRefToSha(abs, 'HEAD');
      return { routes, source: 'local', ...(headSha ? { sha: headSha } : {}) };
    } catch {
      return { routes: [], source: 'missing' };
    }
  }

  // No local checkout — fetch the remote when the participant declares one.
  if (participant.repo) {
    try {
      const gathered = await withRemoteRefWorktree(
        { repo: participant.repo, ...(participant.ref ? { ref: participant.ref } : {}) },
        async (checkout) => ({
          routes: await servedRoutesFrom(checkout, opts),
          // The shallow checkout's HEAD IS the fetched commit — record it.
          sha: resolveRefToSha(checkout, 'HEAD'),
        }),
      );
      return {
        routes: gathered.routes,
        source: 'remote',
        ...(gathered.sha ? { sha: gathered.sha } : {}),
      };
    } catch {
      return { routes: [], source: 'unreachable' };
    }
  }

  return { routes: [], source: 'missing' };
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
  // is published as-is (consumed is inherently per-repo). The repo's OWN
  // rung-4 overlay applies (publish runs on trusted context in this repo);
  // participant repos below are gathered WITHOUT their plugins — publishing
  // never executes another repo's code. A participant's plugin-widened
  // served set reaches the mesh through ITS own `flow publish --land`
  // committed served.json, which gatherParticipant prefers when present.
  const selfOverlay = loadFlowPluginOverlay(cwd, trustedLocalContext());
  const selfModel = await gatherFlowModel({
    roots: [cwd],
    ...(opts.specs ? { specs: opts.specs.map((s) => path.resolve(cwd, s)) } : {}),
    ...(opts.stripUrlPrefixes ? { stripUrlPrefixes: [...opts.stripUrlPrefixes] } : {}),
    ...(opts.sources ? { sources: opts.sources, sourcesBase: cwd } : {}),
    dialects: selfOverlay.dialects,
    extraReaders: selfOverlay.readers,
    ...(selfOverlay.rewriteUrl ? { rewriteUrl: selfOverlay.rewriteUrl } : {}),
    relativeTo: cwd,
  });
  const selfServed = buildServedContract(selfModel, baseMeta);
  const consumed = buildConsumedContract(selfModel, baseMeta);

  const allRoutes: ServedRoute[] = [...selfServed.routes];
  const participants: PublishedParticipant[] = [];
  const provenance: ParticipantProvenance[] = [];
  for (const p of readWorkspace(cwd)?.participants ?? []) {
    const { routes, source, sha } = await gatherParticipant(cwd, p, opts);
    participants.push({ name: p.name, routes: routes.length, source, ...(sha ? { sha } : {}) });
    provenance.push({
      name: p.name,
      source,
      routes: routes.length,
      ...(sha ? { sha } : {}),
      ...(p.ref ? { ref: p.ref } : {}),
    });
    allRoutes.push(...routes);
  }

  const mesh = dedupeServed(allRoutes);
  const contentHash = servedContentHash(mesh);
  const servedContract: ServedContract = {
    side: 'served',
    ...baseMeta,
    contentHash,
    routes: mesh,
    // Per-participant provenance — the staleness anchor. Only on mesh
    // publishes: a participant-less publish is the monorepo/single-repo case
    // where the snapshot's own commitSha already tells the story.
    ...(provenance.length > 0 ? { participants: provenance } : {}),
  };

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
