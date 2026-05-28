/**
 * Finding-enrichment adapter — attaches graph context (module
 * membership + blast radius + enclosing symbol) to analyzer findings
 * that carry a `file` (+ optional `line`). Consumed by the detailed
 * report builders for the `vuln` / `test-gaps` / `quality` commands
 * when the user passes `--graph-context`.
 *
 * Per CLAUDE.md Rule 12 this is the only layer (alongside the context
 * hook + dashboard adapter) that loads the graph for finding
 * enrichment; analyzers receive the pre-built `DetailedGraphContext`
 * and never touch graph.json themselves. All graph math stays in
 * `queries.ts:findingContextQuery`.
 *
 * THE CONTRACT IS FAIL-OPEN + ADDITIVE, like the context hook: a
 * missing / corrupt / stale graph degrades to `undefined` (no
 * enrichment), never an error. Findings render exactly as they do
 * today whenever the graph is absent.
 */

import { tryLoadGraph } from './load';
import { findingContextQuery, type FindingContext } from './queries';
import { languageForFile } from '../languages';

/** A finding's location — the enrichment key. `line` optional (file-level findings). */
export interface FindingLocation {
  file: string;
  line?: number;
}

/**
 * The enrichment payload stored on a detailed report. `generatedAt` +
 * `truncated` carry the graph.json provenance so a reader can detect a
 * stale enrichment (the graph predates the analyzed commit) without
 * re-loading the artifact. `contexts` is keyed by `locationKey` and
 * holds only `found: true` entries — files absent from the graph
 * produce no key (the renderer treats a missing key as "no context").
 */
export interface DetailedGraphContext {
  generatedAt: string;
  truncated: boolean;
  contexts: Record<string, FindingContext>;
}

export interface BuildFindingContextOpts {
  /** Budget cap: only the first N unique locations are enriched (bloat guard). */
  maxFindings?: number;
  /** Sample size of caller files surfaced per finding. */
  topCallerFiles?: number;
}

/** Stable lookup key for a finding location. */
export function locationKey(file: string, line?: number): string {
  return typeof line === 'number' ? `${file}:${line}` : file;
}

/**
 * Build per-finding graph context for a list of finding locations.
 * Fail-open: returns `undefined` when the graph can't be loaded.
 *
 * Dedupes identical locations (same file:line surfaced by multiple
 * tools) and budget-caps the work at `maxFindings` unique locations.
 * Only `found: true` contexts are stored — a finding in a file the
 * graph never parsed contributes no key, keeping the payload lean on
 * repos where graphify covers only part of the tree.
 */
export function buildFindingContextMap(
  cwd: string,
  locations: ReadonlyArray<FindingLocation>,
  opts: BuildFindingContextOpts = {},
): DetailedGraphContext | undefined {
  const graph = tryLoadGraph(cwd);
  if (!graph) return undefined;

  const max = opts.maxFindings ?? 200;
  const contexts: Record<string, FindingContext> = {};
  let enriched = 0;
  for (const loc of locations) {
    if (enriched >= max) break;
    const key = locationKey(loc.file, loc.line);
    if (key in contexts) continue;
    const ctx = findingContextQuery(graph, loc.file, loc.line, {
      topCallerFiles: opts.topCallerFiles,
    });
    enriched++;
    if (!ctx.found) continue;
    // Stamp the file's call-graph reliability (Rule 6: the fact comes
    // from the language pack, not a hardcoded table here). Only record
    // the non-default values to keep the payload lean — absent ⇒ 'full'.
    const rel = languageForFile(loc.file)?.callGraphReliability;
    contexts[key] = rel && rel !== 'full' ? { ...ctx, callGraphReliability: rel } : ctx;
  }

  return {
    generatedAt: graph.meta.generatedAt,
    truncated: graph.meta.truncated,
    contexts,
  };
}

/**
 * Compact one-cell rendering for a markdown table: `role · N caller
 * files`. Returns `—` when there's no context for the location (file
 * not in the graph). Used by the detailed report renderers.
 */
export function formatGraphContextCell(ctx: FindingContext | undefined): string {
  if (!ctx || !ctx.found) return '—';
  const role = ctx.community?.role ?? 'unclustered';
  // For languages graphify can't resolve call edges for (C#), the
  // caller count is untrustworthy — suppress it rather than print a
  // misleading "0 caller files" (which a fixing agent could read as
  // "safe to change"). The module/role label is still reliable.
  if (ctx.callGraphReliability === 'unreliable') {
    return `${role} · blast radius n/a (call graph)`;
  }
  const n = ctx.blastRadius.callerFiles;
  return `${role} · ${n} caller file${n === 1 ? '' : 's'}`;
}

/**
 * Provenance + honesty line printed above an enriched section so the
 * reader knows the context is a structural hint tied to a specific
 * graph snapshot (and that graphify can conflate same-name symbols).
 */
export function graphContextProvenanceLine(gc: DetailedGraphContext): string {
  const date = gc.generatedAt.slice(0, 10);
  const stale = gc.truncated ? ' (graph truncated — coverage partial)' : '';
  return `_Graph context column from \`.dxkit/reports/graph.json\` (generated ${date}${stale}) — structural hint; blast radius is file-level, same-name symbols may conflate call edges, and it reads \`n/a\` for languages whose call graph graphify can't resolve (a blank is not "0 callers"/"safe to change")._`;
}
