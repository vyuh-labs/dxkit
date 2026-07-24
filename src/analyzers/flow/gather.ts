/**
 * Flow gather — walk a set of roots, extract both HTTP surfaces from every
 * source file, and assemble a `FlowModel`. The served side is the UNION of what
 * source extraction finds and what any configured OpenAPI spec declares (a spec
 * is authoritative but often incomplete, so static extraction adds recall).
 *
 * File discovery goes through the canonical `walkSourceFiles` (Rule 4
 * exclusions + test-file skipping built in); the scanned extensions are exactly
 * those of packs that declare BOTH an httpFlow descriptor and a tree-sitter
 * grammar, so a non-flow language's files are never parsed and adding a flow
 * pack auto-extends the scan (Rule 6).
 */

import { existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { LANGUAGES, allFlowSourceExtensions } from '../../languages';
import { readWorkspace } from '../../workspace';
import { walkSourceFiles } from '../tools/walk-source-files';
import { extractFileFlow, type ClientCall, type FileFlow } from './extract';
import {
  buildFlowModel,
  joinFlow,
  type FlowModel,
  type ParticipantConsumers,
  type RepoFlowModel,
} from './model';
import { loadOpenApiRoutes } from './spec-source';
import { readFlowConfig } from './config';
import {
  CONTRACT_SOURCE_READERS,
  loadContractSources,
  type ContractSourceReader,
  type FlowSourceDecl,
} from './contract-sources';
import { dialectsByPack } from './dialects';
import { loadFlowPluginOverlay } from '../../extensions/plugin-host';
import type { HttpFlowDialect } from '@vyuhlabs/dxkit-sdk';
import type { NormalizeConfig } from './normalize';
import type { AnalysisTrustContext } from '../../analysis-trust';

export interface GatherFlowOptions {
  /** Directories to scan for source (frontend, backend, services…). */
  readonly roots: readonly string[];
  /** OpenAPI spec files whose served routes union with the extracted ones. */
  readonly specs?: readonly string[];
  /** Host-helper prefixes to strip during URL normalization (per-app config). */
  readonly stripUrlPrefixes?: readonly string[];
  /**
   * Relabel every extracted call / route `file` relative to this directory.
   * Off by default (files keep their scanned absolute path — the M2 map/trace
   * display form). The flow-binding identity contract (Rule 9) requires an
   * environment-INDEPENDENT locator, so the gate and `flow refresh` set this to
   * the repo root: a binding gathered from the working tree and the same file
   * gathered from a detached worktree then share one relative `file`, and the
   * committed `consumed.json` carries repo-relative paths that mean the same
   * thing on any machine.
   */
  readonly relativeTo?: string;
  /**
   * Declared contract artifacts (`flow.sources`) resolved through the
   * contract-source reader registry, exactly as `specs` resolves OpenAPI.
   * `sourcesBase` is the directory artifact paths are relative to (the repo
   * root of the side being gathered — the base-ref worktree on the gate's
   * base side, so grandfathering reads the artifacts as they were at base).
   */
  readonly sources?: readonly FlowSourceDecl[];
  readonly sourcesBase?: string;
  /**
   * Plugin overlay (rung 4), pre-loaded by the caller via the plugin host:
   * dialects widen pack descriptors per file, extra readers augment the
   * contract-source registry for this load, and rewriteUrl rides the ONE
   * normalizer's hook. Explicit-config callers (the two-ref gate) pass the
   * SAME overlay to both sides so a degraded lens can never mint a false
   * block; `gatherRepoFlowModel` loads it itself.
   */
  readonly dialects?: readonly HttpFlowDialect[];
  readonly extraReaders?: readonly ContractSourceReader[];
  readonly rewriteUrl?: (rawUrl: string) => string | null;
}

/** Extensions of packs that can contribute flow (httpFlow + a grammar). */
function flowExtensions(): string[] {
  return allFlowSourceExtensions(LANGUAGES);
}

/** Relabel a file surface's call/route paths relative to `base`. */
function relabelFileFlow(flow: FileFlow, base: string): FileFlow {
  const rel = (f: string): string => relative(base, f);
  return {
    calls: flow.calls.map((c) => ({ ...c, file: rel(c.file) })),
    routes: flow.routes.map((r) => ({ ...r, file: rel(r.file) })),
    dynamicCalls: (flow.dynamicCalls ?? []).map((d) => ({ ...d, file: rel(d.file) })),
  };
}

/** Walk + extract + assemble. Files that don't parse are skipped, never fatal. */
export async function gatherFlowModel(opts: GatherFlowOptions): Promise<RepoFlowModel> {
  const config: NormalizeConfig = {
    stripUrlPrefixes: opts.stripUrlPrefixes,
    ...(opts.rewriteUrl ? { rewriteUrl: opts.rewriteUrl } : {}),
  };
  const extensions = flowExtensions();
  const dialects =
    opts.dialects && opts.dialects.length > 0 ? dialectsByPack(opts.dialects) : undefined;
  const fileFlows: FileFlow[] = [];

  for (const root of opts.roots) {
    for (const rel of walkSourceFiles(root, { extensions })) {
      // `rel` (root-relative) is what file-convention routing derives its URL
      // from — the routing base (`app`, `src/app`) is relative to the scanned
      // participant root, not the absolute path or the repo-root relabel.
      const flow = await extractFileFlow(join(root, rel), config, rel, dialects);
      if (flow) fileFlows.push(opts.relativeTo ? relabelFileFlow(flow, opts.relativeTo) : flow);
    }
  }

  // Served side = extracted routes UNION spec routes (dedup is implicit: the
  // join indexes routes by (method, path), so a duplicate collapses).
  const specRoutes = (opts.specs ?? []).flatMap((spec) => loadOpenApiRoutes(spec));

  // Declared contract artifacts (rung 2) union in through the reader
  // registry — both sides, one normalizer, disclosures carried on the model.
  const sourceLoad =
    opts.sources && opts.sources.length > 0
      ? loadContractSources(
          opts.sourcesBase ?? opts.roots[0] ?? '.',
          opts.sources,
          config,
          opts.extraReaders && opts.extraReaders.length > 0
            ? [...CONTRACT_SOURCE_READERS, ...opts.extraReaders]
            : undefined,
        )
      : undefined;

  const model = buildFlowModel([
    ...fileFlows,
    { calls: [], routes: specRoutes },
    ...(sourceLoad ? [{ calls: [...sourceLoad.calls], routes: [...sourceLoad.routes] }] : []),
  ]);
  return sourceLoad && sourceLoad.disclosures.length > 0
    ? { ...model, sourceDisclosures: [...sourceLoad.disclosures] }
    : model;
}

/**
 * Gather a repo's flow model with its POLICY CONFIG applied — the canonical
 * entry point for THIS REPO's own flow surface.
 *
 * It reads `.dxkit/policy.json:flow` itself, so a caller cannot forget to thread
 * `stripUrlPrefixes` / `specs` (the class of bug that left the configured
 * base-URL-helper strip unapplied on the diagnose + detect paths, while the map
 * + gate paths threaded it). The raw `gatherFlowModel` is reserved for callers
 * that supply config explicitly — the two-ref gate, and cross-repo publish —
 * where the config comes from somewhere other than this repo's policy.
 *
 * SCOPE, and why it matters: this model contains ONLY what this repo declares.
 * It never reaches across a workspace boundary. That makes it the right (and
 * only correct) input for anything that AUTHORS an artifact describing this repo
 * — `flow refresh`'s committed `served.json` / `consumed.json`, whose `file`
 * locators must be repo-relative and environment-independent (Rule 9) — and for
 * anything that composes repos itself, like `describe --holistic`, which gathers
 * each root separately and joins them above (merging participants here would
 * double-count). For the SYSTEM view — this repo plus the consumers declared in
 * `workspace.json` — use `gatherSystemFlowModel`.
 *
 * `roots` defaults to `[cwd]`; pass an override for a multi-root scan.
 */
export async function gatherRepoFlowModel(
  cwd: string,
  opts: {
    roots?: readonly string[];
    relativeTo?: string;
    /** REQUIRED (4.2): whose tree is this? The rung-4 plugin overlay loads
     *  here, so the caller must state it — an omission fails to compile
     *  instead of silently defaulting to trusted. */
    trust: AnalysisTrustContext;
    /** Extra OpenAPI specs to union with `flow.specs` — the flow CLI's
     *  `--specs` flag. Additive to policy, never a replacement, so a CLI
     *  invocation cannot silently drop the repo's configured specs. */
    extraSpecs?: readonly string[];
  },
): Promise<RepoFlowModel> {
  const config = readFlowConfig(cwd);
  // The rung-4 overlay loads here — the canonical repo entry — so every
  // single-repo surface (map, diagnose, detect) sees plugin dialects,
  // readers, and the rewriteUrl hook without threading them itself. Under
  // an untrusted tree nothing loads (trust tier) and the skip is disclosed.
  const overlay = loadFlowPluginOverlay(cwd, opts.trust);
  const model = await gatherFlowModel({
    roots: opts.roots ?? [cwd],
    specs: [...(opts.extraSpecs ?? []), ...config.specs.map((s) => resolve(cwd, s))],
    stripUrlPrefixes: config.stripUrlPrefixes,
    sources: config.sources,
    sourcesBase: cwd,
    dialects: overlay.dialects,
    extraReaders: overlay.readers,
    ...(overlay.rewriteUrl ? { rewriteUrl: overlay.rewriteUrl } : {}),
    ...(opts.relativeTo !== undefined ? { relativeTo: opts.relativeTo } : {}),
  });
  if (overlay.disclosures.length === 0) return model;
  return {
    ...model,
    sourceDisclosures: [...(model.sourceDisclosures ?? []), ...overlay.disclosures],
  };
}

/**
 * Gather the SYSTEM's flow model — this repo PLUS the consumed side of every
 * participant declared in `.dxkit/workspace.json`. The canonical entry point for
 * every ANALYSIS surface that asks "who consumes my routes": the map, trace,
 * `diagnoseFlow` (and through it the dead-surface ladder), and `describe`'s repo
 * card.
 *
 * The distinction from `gatherRepoFlowModel` is not cosmetic; collapsing the two
 * produces bugs in BOTH directions. Analysis that reads only this repo declares
 * a split-repo system's entire API dead, because the UI that calls it lives
 * elsewhere. Authoring that reads participants writes another repo's calls into
 * this repo's committed contract, under `../sibling/...` paths that mean nothing
 * on another machine. Two concepts, two entry points, each with ONE definition
 * (Rule 2.30).
 *
 * Each participant is gathered through `gatherRepoFlowModel`, which is the whole
 * point: a participant's calls MUST normalize with the PARTICIPANT's own
 * `flow.stripUrlPrefixes`, not this repo's. A React client addressing
 * `${Config.apiBase()}/things` only strips to `/things` under its own policy;
 * normalizing it with the provider's config leaves an opaque `{var}` leading
 * segment and the call silently never binds. Each side owns its normalization.
 * Because participants are gathered with the REPO entry, the mesh is exactly one
 * hop by construction — no recursion, no cycle guard, even though participants
 * routinely declare each other.
 *
 * Only participants' CALLS merge. Their routes are their own served side — the
 * provider mesh `flow publish` assembles into a served contract — and merging
 * them would relabel another repo's surface as this one's.
 *
 * Fail-open: a participant with no local checkout is reported `not-checked-out`
 * and contributes nothing. That is not an error, but it is also not evidence
 * (see `sawParticipantConsumers`). Remote (`repo:`) fetching is deliberately NOT
 * done here — analysis surfaces are offline and per-invocation, and must never
 * clone; `flow publish` owns the network (Rule 11).
 *
 * A repo with no participants pays one `workspace.json` stat and is returned
 * untouched, so the single-repo path is unchanged in both cost and shape.
 */
export async function gatherSystemFlowModel(
  cwd: string,
  opts: {
    roots?: readonly string[];
    relativeTo?: string;
    /** REQUIRED (4.2) — see `gatherRepoFlowModel`. */
    trust: AnalysisTrustContext;
    extraSpecs?: readonly string[];
  },
): Promise<FlowModel> {
  const model = await gatherRepoFlowModel(cwd, opts);
  const participants = readWorkspace(cwd)?.participants ?? [];
  if (participants.length === 0) return model;

  const calls: ClientCall[] = [];
  const provenance: ParticipantConsumers[] = [];
  for (const p of participants) {
    const root = p.path ? resolve(cwd, p.path) : undefined;
    if (!root || !existsSync(root)) {
      provenance.push({ name: p.name, source: 'not-checked-out', calls: 0, bound: 0 });
      continue;
    }
    let pModel: RepoFlowModel;
    try {
      pModel = await gatherRepoFlowModel(root, { trust: opts.trust });
    } catch {
      // An unreadable participant tree is a no-opinion, never fatal.
      provenance.push({ name: p.name, source: 'not-checked-out', calls: 0, bound: 0 });
      continue;
    }
    // Per-participant bound count: join THIS participant's calls alone against
    // our routes, so the evidence predicate can tell "read and connected" from
    // "read but nothing resolves" (a misconfigured client). Same catch-all-aware
    // join every other consumer uses (Rule 2.30).
    const bound = joinFlow(pModel.calls, model.routes).filter((b) => b.route !== null).length;
    calls.push(...pModel.calls);
    provenance.push({ name: p.name, source: 'local', calls: pModel.calls.length, bound });
  }

  // Re-join: a cross-repo call binds exactly as an in-repo one does, through the
  // same catch-all-aware `joinFlow` (Rule 2.30 — one resolution, every consumer).
  const allCalls = [...model.calls, ...calls];
  return {
    ...model,
    calls: allCalls,
    bindings: joinFlow(allCalls, model.routes),
    participantConsumers: provenance,
  };
}
