/**
 * Flow → graph composition (the writer side of the v2 overlay). Turns a
 * `FlowModel` (the consumed/served join) into the `http-endpoint` nodes +
 * `calls-endpoint` edges that ride on top of the structural graph, then
 * merges them onto whatever graphify already wrote and persists the result.
 *
 * The two producers stay decoupled per §10 of the design: graphify owns the
 * structural nodes/edges and writes a v1 artifact unaware of flow; this module
 * owns the flow overlay and composes ON TOP of graphify's output without
 * graphify importing it (or vice versa). When graphify is absent the overlay
 * still writes — a minimal v2 skeleton whose `calls-endpoint` edges carry the
 * consuming call site's coordinates directly (Rule: the flow layer is
 * graphify-independent, so the map degrades to "endpoints + who calls them by
 * file", never to nothing).
 *
 * Graph reads/writes stay in the explore layer (Rule 12): the base is loaded
 * via `tryLoadGraph`, endpoint anchoring resolves through the `queries.ts`
 * primitive `enclosingNodeIdFor`, and this module is the flow overlay's single
 * writer — the mirror of graphify's `writeGraphArtifact`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FlowModel } from '../analyzers/flow/model';
import type { RouteEndpoint } from '../analyzers/flow/extract';
import { tryLoadGraph } from './load';
import { enclosingNodeIdFor } from './queries';
import {
  GRAPH_REPORT_PATH,
  GRAPH_SCHEMA_VERSION,
  type Graph,
  type GraphEdge,
  type GraphJson,
  type HttpEndpointNode,
} from './types';

/** The disjoint slice of the v2 graph the flow layer contributes. */
export interface FlowContribution {
  readonly endpoints: HttpEndpointNode[];
  readonly edges: GraphEdge[];
}

/** The `${method} ${path}` join key an endpoint / call reduces to. */
function endpointKey(method: string, routePath: string): string {
  return `${method} ${routePath}`;
}

/**
 * Build the flow overlay from a model. One `http-endpoint` node per distinct
 * served `(method, path)` (deduped — a route surfaced by both a spec and static
 * extraction collapses to one endpoint, spec winning as the authoritative
 * provenance), and one `calls-endpoint` edge per RESOLVED binding (a call that
 * matched a served route).
 *
 * `base` is the structural graph when available: the edge's `from` anchors onto
 * the enclosing structural node so the UI→API edge composes with the real call
 * graph. Without a base (or when a call sits outside any known symbol) `from` is
 * empty and the call site lives on the edge's `fromFile` / `fromLine` — enough
 * to answer "who calls this endpoint" by file. Pure over its inputs.
 */
export function buildFlowContribution(model: FlowModel, base?: Graph): FlowContribution {
  // Dedup routes → endpoint nodes, keyed by the normalized join key. A spec
  // route supersedes a static one for the same key (authoritative handler).
  const byKey = new Map<string, RouteEndpoint>();
  for (const route of model.routes) {
    const key = endpointKey(route.method, route.path);
    const existing = byKey.get(key);
    if (!existing || (existing.via !== 'spec' && route.via === 'spec')) {
      byKey.set(key, route);
    }
  }

  const endpoints: HttpEndpointNode[] = [];
  const endpointIdByKey = new Map<string, string>();
  let idx = 0;
  for (const [key, route] of byKey) {
    const id = `ep${idx++}`;
    endpointIdByKey.set(key, id);
    endpoints.push({
      id,
      kind: 'http-endpoint',
      label: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      via: route.via,
      handler: route.handler,
      sourceFile: route.file,
      line: route.line,
    });
  }

  // One calls-endpoint edge per resolved binding. Unresolved bindings
  // (external / no-route) have no endpoint to point at — they are the map's
  // "dangling call" set, surfaced by queries, not as edges.
  const edges: GraphEdge[] = [];
  for (const binding of model.bindings) {
    if (!binding.route) continue;
    const key = endpointKey(binding.route.method, binding.route.path);
    const endpointId = endpointIdByKey.get(key);
    if (!endpointId) continue;
    const from = base ? (enclosingNodeIdFor(base, binding.call.file, binding.call.line) ?? '') : '';
    edges.push({
      from,
      to: endpointId,
      relation: 'calls-endpoint',
      fromFile: binding.call.file,
      fromLine: binding.call.line,
    });
  }

  return { endpoints, edges };
}

/**
 * Compose a full v2 `GraphJson` from a (possibly absent) structural base and a
 * flow model. With a base, the structural nodes/edges/communities/symbolIndex
 * are preserved verbatim and the flow overlay is appended (edges into the
 * shared `edges` array, endpoints into the new `endpoints` array); the schema
 * version is stamped to v2. Without a base, a minimal skeleton carries the
 * overlay alone, so `vyuh-dxkit flow` produces a map even where graphify never
 * ran (a pure-frontend repo, a CI job without Python).
 */
export function mergeFlowIntoGraph(base: Graph | undefined, model: FlowModel): GraphJson {
  const contribution = buildFlowContribution(model, base);
  if (base) {
    // The overlay is REGENERATED each run, never accumulated: strip any
    // calls-endpoint edges a previous flow run left on the base (endpoints are
    // already replaced wholesale below), then append this run's fresh edges.
    // Without this, re-running `flow` stacks duplicate bindings.
    const structuralEdges = base.edges.filter((e) => e.relation !== 'calls-endpoint');
    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      meta: base.meta,
      nodes: base.nodes,
      edges: [...structuralEdges, ...contribution.edges],
      communities: base.communities,
      symbolIndex: base.symbolIndex,
      endpoints: contribution.endpoints,
    };
  }
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '',
      generatedAt: '',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes: [],
    edges: contribution.edges,
    communities: [],
    symbolIndex: {},
    endpoints: contribution.endpoints,
  };
}

/**
 * Persist the flow-augmented graph to its canonical disk location, composing
 * onto graphify's base when one exists. Returns the merged graph so an
 * in-memory caller (the `flow` CLI) can render without a disk round-trip.
 *
 * Mirror of graphify's `writeGraphArtifact`: a failed write is a warning, not a
 * throw — the graph is a convenience artifact, and the CLI already has the
 * model in hand for its terminal output.
 */
export function writeFlowGraph(cwd: string, model: FlowModel): GraphJson {
  const base = tryLoadGraph(cwd);
  const merged = mergeFlowIntoGraph(base, model);
  const absPath = path.join(cwd, GRAPH_REPORT_PATH);
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(merged));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dxkit: failed to write ${GRAPH_REPORT_PATH}: ${msg}\n`);
  }
  return merged;
}
