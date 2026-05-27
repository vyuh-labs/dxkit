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

// Sprint 2 will add: entryPointsQuery, fileSummaryQuery, featureQuery,
// communitiesQuery, apiSurfaceQuery as each subcommand lands.
