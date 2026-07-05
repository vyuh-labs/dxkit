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

import { join, relative } from 'path';
import { LANGUAGES, allFlowSourceExtensions } from '../../languages';
import { walkSourceFiles } from '../tools/walk-source-files';
import { extractFileFlow, type FileFlow } from './extract';
import { buildFlowModel, type FlowModel } from './model';
import { loadOpenApiRoutes } from './spec-source';
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
  return buildFlowModel([...fileFlows, { calls: [], routes: specRoutes }]);
}
