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

// ─── High-level queries (Sprint 2 fills bodies) ──────────────────────────────

// Sprint 2 implements: entryPointsQuery, hotFilesQuery, fileSummaryQuery,
// featureQuery, communitiesQuery, apiSurfaceQuery.
//
// The skeleton stays minimal — Sprint 1 only needs the file to exist so
// Rule 12 has a canonical target to lock onto. Real implementations
// arrive with the CLI subcommands.
