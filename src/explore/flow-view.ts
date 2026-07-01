/**
 * Flow read-side orchestration for the `vyuh-dxkit flow` CLI. Composes the
 * three explore primitives the CLI is not allowed to touch directly (Rule 12
 * confines graph load + query to the explore layer): write the overlay
 * (`flow-graph.ts`), reload the indexed graph (`load.ts`), run the pure query
 * (`queries.ts`). The CLI consumes the returned view and renders — it never
 * loads or traverses the graph itself.
 */

import { writeFlowGraph } from './flow-graph';
import { tryLoadGraph } from './load';
import { flowMapQuery, flowTrace, type FlowMap, type FlowTrace } from './queries';
import type { FlowModel } from '../analyzers/flow/model';
import type { Graph, HttpEndpointNode } from './types';

const EMPTY_MAP: FlowMap = {
  endpoints: [],
  unconsumedEndpoints: [],
  totalEndpoints: 0,
  totalBindings: 0,
};

/**
 * Build the flow map: persist the overlay onto graph.json, then read it back
 * and run `flowMapQuery`. Reloading (rather than indexing the merged json
 * in-memory) keeps the on-disk artifact and the rendered view guaranteed
 * consistent, and the graph.json is a small file. Degrades to an empty map if
 * the write+reload fails (never throws for the CLI).
 */
export function buildFlowMap(cwd: string, model: FlowModel): FlowMap {
  writeFlowGraph(cwd, model);
  const graph = tryLoadGraph(cwd);
  return graph ? flowMapQuery(graph) : EMPTY_MAP;
}

/** Not-found trace carries the candidate endpoint labels so the CLI can print a
 *  "did you mean" list keyed off the same graph. */
export interface FlowTraceView {
  trace: FlowTrace;
  candidates: string[];
}

/**
 * Build the trace for one endpoint. `target` resolves against the freshly
 * written graph by, in order: exact endpoint id (`ep3`), exact join key
 * (`GET /articles/{var}`), then the method-uppercased key — so a user can paste
 * the label shown by `flow map` verbatim. On no match, `trace.found` is false
 * and `candidates` lists every endpoint label for a "did you mean" hint.
 */
export function buildFlowTrace(cwd: string, model: FlowModel, target: string): FlowTraceView {
  writeFlowGraph(cwd, model);
  const graph = tryLoadGraph(cwd);
  if (!graph) {
    return { trace: notFoundTrace(target), candidates: [] };
  }
  const endpoint = resolveEndpoint(graph, target);
  if (!endpoint) {
    return {
      trace: notFoundTrace(target),
      candidates: graph.endpoints.map((e) => e.label).sort(),
    };
  }
  return { trace: flowTrace(graph, endpoint.id), candidates: [] };
}

function resolveEndpoint(graph: Graph, target: string): HttpEndpointNode | undefined {
  const t = target.trim();
  const byId = graph.endpointById.get(t);
  if (byId) return byId;
  const byKey = graph.endpointByKey.get(t);
  if (byKey) return byKey;
  const space = t.indexOf(' ');
  if (space > 0) {
    const upper = `${t.slice(0, space).toUpperCase()} ${t.slice(space + 1)}`;
    return graph.endpointByKey.get(upper);
  }
  return undefined;
}

function notFoundTrace(_target: string): FlowTrace {
  return {
    found: false,
    handler: null,
    consumers: [],
    blastRadius: {
      endpointId: '',
      directConsumers: 0,
      consumerFiles: 0,
      upstreamCallers: 0,
      upstreamFiles: 0,
    },
  };
}
