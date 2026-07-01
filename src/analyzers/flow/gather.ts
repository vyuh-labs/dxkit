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

import { join } from 'path';
import { LANGUAGES } from '../../languages';
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
}

/** Extensions of packs that can contribute flow (httpFlow + a grammar). */
function flowExtensions(): string[] {
  const exts = new Set<string>();
  for (const pack of LANGUAGES) {
    if (pack.httpFlow && pack.treeSitterGrammars) {
      for (const ext of Object.keys(pack.treeSitterGrammars)) exts.add(ext);
    }
  }
  return [...exts];
}

/** Walk + extract + assemble. Files that don't parse are skipped, never fatal. */
export async function gatherFlowModel(opts: GatherFlowOptions): Promise<FlowModel> {
  const config: NormalizeConfig = { stripUrlPrefixes: opts.stripUrlPrefixes };
  const extensions = flowExtensions();
  const fileFlows: FileFlow[] = [];

  for (const root of opts.roots) {
    for (const rel of walkSourceFiles(root, { extensions })) {
      const flow = await extractFileFlow(join(root, rel), config);
      if (flow) fileFlows.push(flow);
    }
  }

  // Served side = extracted routes UNION spec routes (dedup is implicit: the
  // join indexes routes by (method, path), so a duplicate collapses).
  const specRoutes = (opts.specs ?? []).flatMap((spec) => loadOpenApiRoutes(spec));
  return buildFlowModel([...fileFlows, { calls: [], routes: specRoutes }]);
}
