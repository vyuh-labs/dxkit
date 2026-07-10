/**
 * Tests for the v2 flow queries in src/explore/queries.ts:
 * endpointCallers, flowBlastRadius, flowTrace, flowMapQuery. Fixtures are built
 * by writing a merged v2 graph to disk and reading it back through loadGraph, so
 * the tests exercise the same indexing path production uses.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFlowGraph } from '../../src/explore/flow-graph';
import { loadGraph } from '../../src/explore/load';
import {
  endpointCallers,
  flowBlastRadius,
  flowTrace,
  flowMapQuery,
} from '../../src/explore/queries';
import { GRAPH_REPORT_PATH, type Graph } from '../../src/explore/types';
import type { ClientCall, RouteEndpoint } from '../../src/analyzers/flow/extract';
import type { FlowModel } from '../../src/analyzers/flow/model';

function call(over: Partial<ClientCall>): ClientCall {
  return {
    method: 'GET',
    rawUrl: '/x',
    path: '/x',
    receiver: 'axios',
    file: 'web/a.tsx',
    line: 10,
    ...over,
  };
}

function route(over: Partial<RouteEndpoint>): RouteEndpoint {
  return {
    method: 'GET',
    path: '/x',
    via: 'router-call',
    handler: 'h',
    file: 'api/x.ts',
    line: 1,
    ...over,
  };
}

function model(calls: ClientCall[], routes: RouteEndpoint[]): FlowModel {
  const index = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const bindings = calls.map((c) => {
    const r = c.path == null ? null : (index.get(`${c.method} ${c.path}`) ?? null);
    return {
      call: c,
      route: r,
      confidence: r ? 1 : 0,
      reason: r ? ('exact' as const) : ('no-route' as const),
    };
  });
  return { calls, routes, bindings, dynamicCalls: [] };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-flowq-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a graphify base with a call graph so upstream blast radius has edges,
 *  then merge the flow overlay and load the result. */
function graphWithBase(m: FlowModel): Graph {
  fs.mkdirSync(path.join(tmpDir, path.dirname(GRAPH_REPORT_PATH)), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, GRAPH_REPORT_PATH),
    JSON.stringify({
      schemaVersion: 1,
      meta: {
        tool: 'graphify',
        graphifyVersion: '',
        dxkitVersion: '2.20.0',
        generatedAt: '',
        sourceFilesInGraph: 2,
        excludedFileCount: 0,
        packs: ['typescript'],
        truncated: false,
        truncatedReason: '',
      },
      nodes: [
        { id: 'n0', kind: 'module', label: 'web/a.tsx', sourceFile: 'web/a.tsx' },
        { id: 'n1', kind: 'function', label: 'ArticleList()', sourceFile: 'web/a.tsx', line: 5 },
        { id: 'n2', kind: 'function', label: 'Page()', sourceFile: 'web/page.tsx', line: 3 },
      ],
      // Page() calls ArticleList() — upstream caller of the consuming node.
      edges: [{ from: 'n2', to: 'n1', relation: 'calls' }],
      communities: [],
      symbolIndex: {},
    }),
  );
  writeFlowGraph(tmpDir, m);
  return loadGraph(tmpDir);
}

describe('endpointCallers', () => {
  it('returns each consuming call site, anchored to its enclosing symbol', () => {
    const g = graphWithBase(model([call({ line: 10 })], [route({})]));
    const [ep] = g.endpoints;
    const callers = endpointCallers(g, ep.id);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ file: 'web/a.tsx', line: 10, symbol: 'ArticleList' });
    expect(callers[0].nodeId).toBe('n1');
  });

  it('populates file/line even with no base graph (graphify-independent)', () => {
    writeFlowGraph(tmpDir, model([call({ line: 42 })], [route({})]));
    const g = loadGraph(tmpDir);
    const callers = endpointCallers(g, g.endpoints[0].id);
    expect(callers[0]).toMatchObject({ file: 'web/a.tsx', line: 42 });
    expect(callers[0].nodeId).toBeUndefined();
  });
});

describe('flowBlastRadius', () => {
  it('counts direct consumers + transitive upstream callers through the call graph', () => {
    const g = graphWithBase(model([call({ line: 10 })], [route({})]));
    const br = flowBlastRadius(g, g.endpoints[0].id);
    expect(br.directConsumers).toBe(1);
    expect(br.consumerFiles).toBe(1);
    // Page() (n2) calls ArticleList() (n1, the consumer) → one upstream caller.
    expect(br.upstreamCallers).toBe(1);
    expect(br.upstreamFiles).toBe(1);
  });

  it('reports zero upstream when there is no base call graph', () => {
    writeFlowGraph(tmpDir, model([call({})], [route({})]));
    const g = loadGraph(tmpDir);
    const br = flowBlastRadius(g, g.endpoints[0].id);
    expect(br.directConsumers).toBe(1);
    expect(br.upstreamCallers).toBe(0);
  });
});

describe('flowTrace', () => {
  it('returns endpoint identity + handler + consumers for a known endpoint', () => {
    const g = graphWithBase(model([call({})], [route({ handler: 'ArticleController.find' })]));
    const trace = flowTrace(g, g.endpoints[0].id);
    expect(trace.found).toBe(true);
    expect(trace.handler).toBe('ArticleController.find');
    expect(trace.consumers).toHaveLength(1);
  });

  it('reports not-found for an unknown endpoint id', () => {
    writeFlowGraph(tmpDir, model([call({})], [route({})]));
    const g = loadGraph(tmpDir);
    const trace = flowTrace(g, 'ep999');
    expect(trace.found).toBe(false);
    expect(trace.consumers).toEqual([]);
  });
});

describe('flowMapQuery', () => {
  it('ranks consumed endpoints and separates the served-but-unconsumed set', () => {
    const m = model(
      [call({ path: '/x' }), call({ path: '/x', file: 'web/b.tsx', line: 7 })],
      [route({ path: '/x' }), route({ path: '/orphan', handler: 'orphan' })],
    );
    writeFlowGraph(tmpDir, m);
    const g = loadGraph(tmpDir);
    const map = flowMapQuery(g);

    expect(map.totalEndpoints).toBe(2);
    expect(map.totalBindings).toBe(2);
    expect(map.endpoints).toHaveLength(1);
    expect(map.endpoints[0]).toMatchObject({ consumerCount: 2 });
    expect(map.endpoints[0].consumerFiles).toEqual(['web/a.tsx', 'web/b.tsx']);
    // /orphan is served but nothing calls it in this graph.
    expect(map.unconsumedEndpoints.map((e) => e.path)).toEqual(['/orphan']);
  });
});
