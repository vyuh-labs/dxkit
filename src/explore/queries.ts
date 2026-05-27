/**
 * Canonical graph query module. Per CLAUDE.md Rule 12, every consumer
 * (explore CLI subcommands, dashboard viz adapter, future 2.8 context
 * CLI, future 2.8 reachability) imports from here — never reimplements
 * graph traversal. Arch-check enforces.
 *
 * Sprint 1 ships the SKELETON: type signatures + empty implementations
 * so the canonical entry points exist for the arch rule to lock onto.
 * Sprint 2 fills the bodies as the explore CLI subcommands land.
 *
 * Every query is a pure function: takes a `Graph` (and optionally
 * other args), returns a typed result. No side effects, no I/O,
 * no caching — caching belongs at the loader level, not the query
 * level.
 */

import type { DetectedStack } from '../types';
import type { Graph, GraphNode } from './types';

// ─── Low-level primitives ────────────────────────────────────────────────────

/** Nodes that call into the given nodeId (predecessors via `calls` edges). */
export function callersOf(graph: Graph, nodeId: string): GraphNode[] {
  const incoming = graph.edgesToNode.get(nodeId) ?? [];
  const out: GraphNode[] = [];
  for (const e of incoming) {
    if (e.relation !== 'calls') continue;
    const n = graph.nodeById.get(e.from);
    if (n) out.push(n);
  }
  return out;
}

/** Nodes that the given nodeId calls into (successors via `calls` edges). */
export function calleesOf(graph: Graph, nodeId: string): GraphNode[] {
  const outgoing = graph.edgesFromNode.get(nodeId) ?? [];
  const out: GraphNode[] = [];
  for (const e of outgoing) {
    if (e.relation !== 'calls') continue;
    const n = graph.nodeById.get(e.to);
    if (n) out.push(n);
  }
  return out;
}

/** All nodes declared in the given source file. */
export function nodesInFile(graph: Graph, sourceFile: string): GraphNode[] {
  return [...(graph.nodesByFile.get(sourceFile) ?? [])];
}

// ─── High-level queries ──────────────────────────────────────────────────────

/**
 * One row of `vyuh-dxkit explore hot-files` output. A "hot" file is
 * one many other files depend on (high total in-degree across all the
 * symbols it declares + inbound imports to the file's module node).
 *
 * - `callsIn`: count of `calls` edges terminating at any symbol in
 *   the file (summed across the file's function / class / method
 *   nodes)
 * - `importsIn`: count of `imports_from` edges terminating at the
 *   file's module node
 * - `callsOut`: count of `calls` edges originating from any symbol
 *   in the file
 * - `communityId` / `communityLabel`: the community the file's
 *   module node belongs to, when one exists; label is the
 *   community's dominantSourceDir for a quick visual anchor
 */
export interface HotFileResult {
  sourceFile: string;
  callsIn: number;
  importsIn: number;
  callsOut: number;
  communityId?: number;
  communityLabel?: string;
}

/**
 * Top-N files by total in-degree (callers + importers). The
 * "centrality" proxy — files many other files depend on. Useful as
 * a "what's the foundational layer of this repo?" answer.
 *
 * Files are derived from the union of `sourceFile` across all nodes;
 * the per-file aggregation traverses each node's inbound/outbound
 * edges. Limit defaults to 20 per the Sprint 0 spec.
 */
export function hotFilesQuery(graph: Graph, limit = 20): HotFileResult[] {
  const perFile = new Map<string, { callsIn: number; callsOut: number; nodes: GraphNode[] }>();

  for (const node of graph.nodes) {
    if (!node.sourceFile) continue;
    let agg = perFile.get(node.sourceFile);
    if (!agg) {
      agg = { callsIn: 0, callsOut: 0, nodes: [] };
      perFile.set(node.sourceFile, agg);
    }
    agg.nodes.push(node);
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'calls') agg.callsIn++;
    }
    for (const e of graph.edgesFromNode.get(node.id) ?? []) {
      if (e.relation === 'calls') agg.callsOut++;
    }
  }

  // Imports-in: count edges into the FILE's module node. Module
  // nodes have `kind === 'module'` and their `sourceFile` IS the
  // file path. Aggregate to the file by matching on that.
  const importsInByFile = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== 'module' || !node.sourceFile) continue;
    let count = 0;
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'imports_from') count++;
    }
    importsInByFile.set(node.sourceFile, (importsInByFile.get(node.sourceFile) ?? 0) + count);
  }

  const results: HotFileResult[] = [];
  for (const [sourceFile, agg] of perFile) {
    const importsIn = importsInByFile.get(sourceFile) ?? 0;
    // Pick a community via any of the file's nodes — module node
    // first if present, else any symbol's community.
    const moduleNode = agg.nodes.find((n) => n.kind === 'module');
    const sampleNode = moduleNode ?? agg.nodes[0];
    const community = sampleNode ? graph.communityByNode.get(sampleNode.id) : undefined;
    results.push({
      sourceFile,
      callsIn: agg.callsIn,
      importsIn,
      callsOut: agg.callsOut,
      communityId: community?.id,
      communityLabel: community?.dominantSourceDir || undefined,
    });
  }

  // Rank by total in-degree (calls + imports). Ties broken by
  // alphabetical source file path for stable output.
  results.sort((a, b) => {
    const ai = a.callsIn + a.importsIn;
    const bi = b.callsIn + b.importsIn;
    if (bi !== ai) return bi - ai;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  return results.slice(0, limit);
}

/**
 * One row of `vyuh-dxkit explore communities` output. A community is
 * a Louvain-clustered grouping of nodes; the dominant source dir +
 * pack give the reader a visual anchor ("this is the auth stuff" /
 * "this is the bom layer").
 */
export interface CommunityResult {
  id: number;
  nodeCount: number;
  dominantSourceDir: string;
  dominantPack: string;
  cohesion: number;
  topHotFiles: string[];
}

/**
 * Top-N communities by node count, with each community's top-3 hot
 * files (by in-degree within the community). Gives a "what are the
 * natural modules in this repo?" answer that complements `hot-files`
 * (which is global).
 */
export function communitiesQuery(graph: Graph, limit = 8): CommunityResult[] {
  const callsInByNode = computeCallsInByNode(graph);
  const sortedCommunities = [...graph.communities].sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length,
  );

  return sortedCommunities.slice(0, limit).map((c) => {
    // Per-file in-degree within this community only.
    const inDegByFile = new Map<string, number>();
    for (const nid of c.nodeIds) {
      const node = graph.nodeById.get(nid);
      if (!node?.sourceFile) continue;
      const d = callsInByNode.get(nid) ?? 0;
      inDegByFile.set(node.sourceFile, (inDegByFile.get(node.sourceFile) ?? 0) + d);
    }
    const topHotFiles = [...inDegByFile.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([f]) => f);

    return {
      id: c.id,
      nodeCount: c.nodeIds.length,
      dominantSourceDir: c.dominantSourceDir,
      dominantPack: c.dominantPack,
      cohesion: c.cohesion,
      topHotFiles,
    };
  });
}

/**
 * Internal helper: precompute per-node call in-degree. Shared between
 * `hotFilesQuery` (file-level aggregation) and `communitiesQuery`
 * (community-bounded ranking). Per CLAUDE.md Rule 2 — one source of
 * truth for the calls-in-degree counter.
 */
function computeCallsInByNode(graph: Graph): Map<string, number> {
  const m = new Map<string, number>();
  for (const node of graph.nodes) {
    let d = 0;
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'calls') d++;
    }
    if (d > 0) m.set(node.id, d);
  }
  return m;
}

/**
 * One-symbol entry inside a file summary — a function / class /
 * method declared in the file plus its in/out call counts. Used by
 * the `explore file <path>` subcommand to show "here's what this
 * file declares + how it interconnects."
 */
export interface FileSymbolSummary {
  id: string;
  kind: 'function' | 'class' | 'method' | 'module';
  label: string;
  line?: number;
  exported?: boolean;
  callsIn: number;
  callsOut: number;
}

/**
 * Full summary for a single file: its symbols, its callers (deduped
 * to unique files for readability), its callees, its inbound and
 * outbound imports, and its community membership. Used by `explore
 * file <path>`.
 *
 * `callerFiles` / `calleeFiles` are deduped at the FILE level — if
 * 12 symbols from src/foo.ts call into this file's symbols, the
 * caller appears once in `callerFiles` with `count: 12`. The reader
 * usually wants "which files depend on me" not "every individual
 * call site" (which would scroll for pages on hot files).
 */
export interface FileSummary {
  sourceFile: string;
  found: boolean;
  symbols: FileSymbolSummary[];
  callerFiles: Array<{ sourceFile: string; count: number }>;
  calleeFiles: Array<{ sourceFile: string; count: number }>;
  importsIn: Array<{ sourceFile: string }>;
  importsOut: Array<{ sourceFile: string }>;
  communityId?: number;
  communityLabel?: string;
  communityPack?: string;
}

/**
 * Build the per-file summary. `found: false` when the file isn't in
 * the graph (excluded by minified detection / vendored / unsupported
 * extension); the consumer handles that case with an explanatory
 * note instead of an empty result.
 */
export function fileSummaryQuery(graph: Graph, sourceFile: string): FileSummary {
  const nodes = nodesInFile(graph, sourceFile);
  if (nodes.length === 0) {
    return {
      sourceFile,
      found: false,
      symbols: [],
      callerFiles: [],
      calleeFiles: [],
      importsIn: [],
      importsOut: [],
    };
  }

  // Per-symbol summary for non-module nodes.
  const symbols: FileSymbolSummary[] = [];
  // Caller / callee aggregation, deduped at the file level.
  const callerCounts = new Map<string, number>();
  const calleeCounts = new Map<string, number>();
  // Imports in/out aggregation against the file's module node.
  const importsInFiles = new Set<string>();
  const importsOutFiles = new Set<string>();

  for (const node of nodes) {
    if (node.kind !== 'module') {
      let inCalls = 0;
      let outCalls = 0;
      for (const e of graph.edgesToNode.get(node.id) ?? []) {
        if (e.relation === 'calls') {
          inCalls++;
          const src = graph.nodeById.get(e.from);
          if (src?.sourceFile && src.sourceFile !== sourceFile) {
            callerCounts.set(src.sourceFile, (callerCounts.get(src.sourceFile) ?? 0) + 1);
          }
        }
      }
      for (const e of graph.edgesFromNode.get(node.id) ?? []) {
        if (e.relation === 'calls') {
          outCalls++;
          const dst = graph.nodeById.get(e.to);
          if (dst?.sourceFile && dst.sourceFile !== sourceFile) {
            calleeCounts.set(dst.sourceFile, (calleeCounts.get(dst.sourceFile) ?? 0) + 1);
          }
        }
      }
      symbols.push({
        id: node.id,
        kind: node.kind,
        label: node.label,
        line: node.line,
        exported: node.exported,
        callsIn: inCalls,
        callsOut: outCalls,
      });
    } else {
      // Module node: harvest imports edges.
      for (const e of graph.edgesToNode.get(node.id) ?? []) {
        if (e.relation === 'imports_from') {
          const src = graph.nodeById.get(e.from);
          if (src?.sourceFile && src.sourceFile !== sourceFile) {
            importsInFiles.add(src.sourceFile);
          }
        }
      }
      for (const e of graph.edgesFromNode.get(node.id) ?? []) {
        if (e.relation === 'imports_from') {
          const dst = graph.nodeById.get(e.to);
          if (dst?.sourceFile && dst.sourceFile !== sourceFile) {
            importsOutFiles.add(dst.sourceFile);
          }
        }
      }
    }
  }

  // Pick a representative node for community lookup — module first,
  // else any symbol.
  const moduleNode = nodes.find((n) => n.kind === 'module');
  const sampleNode = moduleNode ?? nodes[0];
  const community = sampleNode ? graph.communityByNode.get(sampleNode.id) : undefined;

  return {
    sourceFile,
    found: true,
    symbols: symbols.sort((a, b) => b.callsIn - a.callsIn || a.label.localeCompare(b.label)),
    callerFiles: [...callerCounts.entries()]
      .map(([sourceFile, count]) => ({ sourceFile, count }))
      .sort((a, b) => b.count - a.count || a.sourceFile.localeCompare(b.sourceFile)),
    calleeFiles: [...calleeCounts.entries()]
      .map(([sourceFile, count]) => ({ sourceFile, count }))
      .sort((a, b) => b.count - a.count || a.sourceFile.localeCompare(b.sourceFile)),
    importsIn: [...importsInFiles].sort().map((sourceFile) => ({ sourceFile })),
    importsOut: [...importsOutFiles].sort().map((sourceFile) => ({ sourceFile })),
    communityId: community?.id,
    communityLabel: community?.dominantSourceDir || undefined,
    communityPack: community?.dominantPack || undefined,
  };
}

/**
 * One row of `vyuh-dxkit explore entry-points` output. An entry
 * point is a symbol declared in a source file whose path matches
 * one of the active packs' `architecturalShape.primaryComponentPaths`
 * or `routePaths` (per CLAUDE.md Rule 8 — these are pack-driven, no
 * hardcoded framework strings here).
 *
 * `componentType` carries the matched pattern label (e.g. `routes`,
 * `controllers`, `forms`) so the consumer can group by surface.
 * Sourced from the pack's `dominantVocabulary` when available, else
 * from the matched path segment.
 */
export interface EntryPointResult {
  sourceFile: string;
  line?: number;
  symbol: string;
  componentType: string;
  callsOut: number;
  pack: string;
}

/**
 * Discover entry-point symbols by intersecting graph nodes with the
 * union of active packs' `primaryComponentPaths` + `routePaths`. The
 * rank is by call out-degree — entry points typically fan OUT (they
 * receive a request, then call many downstream functions). A high
 * out-degree node in a primary-architecture path is almost certainly
 * a real entry point.
 *
 * `flags` is the per-pack boolean map from `DetectedStack.languages`;
 * only patterns from active packs contribute. This matches the
 * existing pack-driven analyzer pattern.
 */
export function entryPointsQuery(
  graph: Graph,
  primaryPaths: ReadonlyArray<string>,
  routePaths: ReadonlyArray<string>,
  limit = 10,
): EntryPointResult[] {
  if (primaryPaths.length === 0 && routePaths.length === 0) {
    return [];
  }

  // Classify each source file by whether it matches a pattern.
  // Patterns are case-insensitive substrings of the relative POSIX
  // path (per the architecturalShape contract). routePaths overlap
  // primaryComponentPaths in many packs; tag a file by the most
  // specific match (route > primary > none).
  const classify = (sourceFile: string): { matched: boolean; label: string; isRoute: boolean } => {
    const lower = sourceFile.toLowerCase();
    for (const p of routePaths) {
      if (lower.includes(p.toLowerCase())) {
        return { matched: true, label: patternLabel(p), isRoute: true };
      }
    }
    for (const p of primaryPaths) {
      if (lower.includes(p.toLowerCase())) {
        return { matched: true, label: patternLabel(p), isRoute: false };
      }
    }
    return { matched: false, label: '', isRoute: false };
  };

  const results: EntryPointResult[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'module') continue;
    if (!node.sourceFile) continue;
    const c = classify(node.sourceFile);
    if (!c.matched) continue;

    let callsOut = 0;
    for (const e of graph.edgesFromNode.get(node.id) ?? []) {
      if (e.relation === 'calls') callsOut++;
    }
    if (callsOut === 0) continue; // entry points fan out; zero-out-degree symbols aren't entry points

    // Pack: derive from extension via the helper below. Avoids a
    // second pack registry import — keeps queries.ts independent of
    // languages/index.ts for this lookup.
    results.push({
      sourceFile: node.sourceFile,
      line: node.line,
      symbol: node.label,
      componentType: c.label,
      callsOut,
      pack: packFromExt(node.sourceFile),
    });
  }

  // Rank by callsOut desc, ties by sourceFile asc for stability.
  results.sort((a, b) => b.callsOut - a.callsOut || a.sourceFile.localeCompare(b.sourceFile));

  return results.slice(0, limit);
}

/**
 * Extract a human-readable label from a path pattern. E.g.
 * `/controllers/` → `controllers`, `/Forms/` → `forms`.
 */
function patternLabel(pattern: string): string {
  return pattern.replace(/[/\\]/g, '').toLowerCase();
}

// Per-extension pack id derivation. Mirrors EXT_TO_PACK in the
// Python script. Kept here as a private helper rather than imported
// from the registry to keep queries.ts importable without pulling
// the whole pack module surface.
function packFromExt(sourceFile: string): string {
  const i = sourceFile.lastIndexOf('.');
  if (i < 0) return '';
  const ext = sourceFile.slice(i).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.java': 'java',
    '.rb': 'ruby',
  };
  return map[ext] ?? '';
}

// Re-export the type so consumers can satisfy the signature without
// pulling DetectedStack from src/types.ts directly.
export type LanguageFlags = DetectedStack['languages'];

// Sprint 2 will add: featureQuery, apiSurfaceQuery as each
// subcommand lands.
