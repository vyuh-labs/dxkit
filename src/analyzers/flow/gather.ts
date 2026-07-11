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

import { join, relative, resolve } from 'path';
import { LANGUAGES, allFlowSourceExtensions } from '../../languages';
import { walkSourceFiles } from '../tools/walk-source-files';
import { extractFileFlow, type FileFlow } from './extract';
import { buildFlowModel, type FlowModel } from './model';
import { loadOpenApiRoutes } from './spec-source';
import { readFlowConfig } from './config';
import { loadContractSources, type FlowSourceDecl } from './contract-sources';
import type { NormalizeConfig } from './normalize';

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
export async function gatherFlowModel(opts: GatherFlowOptions): Promise<FlowModel> {
  const config: NormalizeConfig = { stripUrlPrefixes: opts.stripUrlPrefixes };
  const extensions = flowExtensions();
  const fileFlows: FileFlow[] = [];

  for (const root of opts.roots) {
    for (const rel of walkSourceFiles(root, { extensions })) {
      // `rel` (root-relative) is what file-convention routing derives its URL
      // from — the routing base (`app`, `src/app`) is relative to the scanned
      // participant root, not the absolute path or the repo-root relabel.
      const flow = await extractFileFlow(join(root, rel), config, rel);
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
      ? loadContractSources(opts.sourcesBase ?? opts.roots[0] ?? '.', opts.sources, config)
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
 * entry point for every single-repo flow surface (map, diagnose, topology
 * detection). It reads `.dxkit/policy.json:flow` itself, so a caller cannot
 * forget to thread `stripUrlPrefixes` / `specs` (the class of bug that left the
 * configured base-URL-helper strip unapplied on the diagnose + detect paths,
 * while the map + gate paths threaded it). The raw `gatherFlowModel` is reserved
 * for callers that supply config explicitly — the two-ref gate, and cross-repo
 * publish — where the config comes from somewhere other than this repo's policy.
 *
 * `roots` defaults to `[cwd]`; pass an override for a multi-root scan.
 */
export async function gatherRepoFlowModel(
  cwd: string,
  opts: { roots?: readonly string[]; relativeTo?: string } = {},
): Promise<FlowModel> {
  const config = readFlowConfig(cwd);
  return gatherFlowModel({
    roots: opts.roots ?? [cwd],
    specs: config.specs.map((s) => resolve(cwd, s)),
    stripUrlPrefixes: config.stripUrlPrefixes,
    sources: config.sources,
    sourcesBase: cwd,
    ...(opts.relativeTo !== undefined ? { relativeTo: opts.relativeTo } : {}),
  });
}
