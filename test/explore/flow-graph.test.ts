/**
 * Tests for src/explore/flow-graph.ts — the flow → graph overlay writer.
 * Covers the pure builder (endpoint dedup, spec-wins provenance, one edge per
 * resolved binding, `from` anchoring with/without a base graph), the merge
 * (structural base preserved + overlay appended; skeleton when graphify absent),
 * and the write → loadGraph round-trip (the artifact is a valid v2 graph).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildFlowContribution,
  mergeFlowIntoGraph,
  writeFlowGraph,
} from '../../src/explore/flow-graph';
import { loadGraph } from '../../src/explore/load';
import { GRAPH_REPORT_PATH, type Graph, type GraphNode } from '../../src/explore/types';
import type { ClientCall, RouteEndpoint } from '../../src/analyzers/flow/extract';
import type { FlowModel } from '../../src/analyzers/flow/model';

function call(over: Partial<ClientCall> = {}): ClientCall {
  return {
    method: 'GET',
    rawUrl: '/articles',
    path: '/articles',
    receiver: 'axios',
    file: 'web/List.tsx',
    line: 20,
    ...over,
  };
}

function route(over: Partial<RouteEndpoint> = {}): RouteEndpoint {
  return {
    method: 'GET',
    path: '/articles',
    via: 'router-call',
    handler: 'ArticleController.find',
    file: 'api/articles.ts',
    line: 5,
    ...over,
  };
}

/** A minimal FlowModel from calls + routes, joining on the (method, path) key. */
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
  return { calls, routes, bindings };
}

/** A tiny indexed base graph with one function node in web/List.tsx. */
function baseGraph(): Graph {
  const nodes: GraphNode[] = [
    { id: 'n0', kind: 'module', label: 'web/List.tsx', sourceFile: 'web/List.tsx' },
    { id: 'n1', kind: 'function', label: 'List()', sourceFile: 'web/List.tsx', line: 10 },
  ];
  const nodesByFile = new Map<string, GraphNode[]>([['web/List.tsx', nodes]]);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return {
    schemaVersion: 2,
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '2.20.0',
      generatedAt: '',
      sourceFilesInGraph: 1,
      excludedFileCount: 0,
      packs: ['typescript'],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges: [{ from: 'n0', to: 'n1', relation: 'method' }],
    communities: [],
    symbolIndex: { list: ['n1'] },
    endpoints: [],
    nodeById,
    edgesFromNode: new Map([['n0', [{ from: 'n0', to: 'n1', relation: 'method' }]]]),
    edgesToNode: new Map([['n1', [{ from: 'n0', to: 'n1', relation: 'method' }]]]),
    nodesByFile,
    communityById: new Map(),
    communityByNode: new Map(),
    endpointById: new Map(),
    endpointByKey: new Map(),
  };
}

describe('buildFlowContribution', () => {
  it('creates one endpoint per distinct (method, path) and one edge per resolved binding', () => {
    const m = model([call(), call({ method: 'POST', path: '/articles', line: 30 })], [route()]);
    const { endpoints, edges } = buildFlowContribution(m);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ kind: 'http-endpoint', method: 'GET', path: '/articles' });
    // GET binding resolved → one edge; POST call has no route → no edge.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      to: 'ep0',
      relation: 'calls-endpoint',
      fromFile: 'web/List.tsx',
      fromLine: 20,
    });
  });

  it('dedups a route surfaced twice, with spec provenance winning', () => {
    const m = model(
      [call()],
      [route({ via: 'router-call' }), route({ via: 'spec', handler: 'spec.find' })],
    );
    const { endpoints } = buildFlowContribution(m);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].via).toBe('spec');
    expect(endpoints[0].handler).toBe('spec.find');
  });

  it('anchors the edge `from` onto the enclosing node when a base graph is present', () => {
    const m = model([call({ line: 20 })], [route()]);
    const { edges } = buildFlowContribution(m, baseGraph());
    // web/List.tsx has List() @10 — the call @20 is inside it → n1.
    expect(edges[0].from).toBe('n1');
    // Coordinates still ride on the edge regardless.
    expect(edges[0].fromFile).toBe('web/List.tsx');
  });

  it('leaves `from` empty when no base graph resolves the call site', () => {
    const m = model([call()], [route()]);
    const { edges } = buildFlowContribution(m);
    expect(edges[0].from).toBe('');
  });
});

describe('mergeFlowIntoGraph', () => {
  it('preserves structural nodes/edges and appends the overlay (schema v2)', () => {
    const merged = mergeFlowIntoGraph(baseGraph(), model([call()], [route()]));
    expect(merged.schemaVersion).toBe(2);
    expect(merged.nodes).toHaveLength(2); // structural preserved
    expect(merged.endpoints).toHaveLength(1);
    // one structural 'method' edge + one 'calls-endpoint' edge
    expect(merged.edges).toHaveLength(2);
    expect(merged.edges.some((e) => e.relation === 'calls-endpoint')).toBe(true);
  });

  it('produces a minimal v2 skeleton when no base graph exists', () => {
    const merged = mergeFlowIntoGraph(undefined, model([call()], [route()]));
    expect(merged.schemaVersion).toBe(2);
    expect(merged.nodes).toHaveLength(0);
    expect(merged.endpoints).toHaveLength(1);
    expect(merged.edges).toHaveLength(1);
    expect(merged.edges[0].from).toBe(''); // no base → coordinates-only anchor
  });
});

describe('writeFlowGraph', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-flowgraph-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a v2 artifact that loadGraph reads back with a populated overlay', () => {
    writeFlowGraph(tmpDir, model([call()], [route()]));
    expect(fs.existsSync(path.join(tmpDir, GRAPH_REPORT_PATH))).toBe(true);

    const g = loadGraph(tmpDir);
    expect(g.schemaVersion).toBe(2);
    expect(g.endpoints).toHaveLength(1);
    expect(g.endpointByKey.get('GET /articles')?.id).toBe('ep0');
    expect(g.edgesToNode.get('ep0')?.[0].relation).toBe('calls-endpoint');
  });

  it('composes onto an existing graphify base already on disk', () => {
    // Seed a v1 graphify artifact, then merge the flow overlay onto it.
    const dir = path.join(tmpDir, path.dirname(GRAPH_REPORT_PATH));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, GRAPH_REPORT_PATH),
      JSON.stringify({
        schemaVersion: 1,
        meta: {
          tool: 'graphify',
          graphifyVersion: '',
          dxkitVersion: '2.20.0',
          generatedAt: '',
          sourceFilesInGraph: 1,
          excludedFileCount: 0,
          packs: ['typescript'],
          truncated: false,
          truncatedReason: '',
        },
        nodes: [
          { id: 'n0', kind: 'module', label: 'web/List.tsx', sourceFile: 'web/List.tsx' },
          { id: 'n1', kind: 'function', label: 'List()', sourceFile: 'web/List.tsx', line: 10 },
        ],
        edges: [{ from: 'n0', to: 'n1', relation: 'method' }],
        communities: [],
        symbolIndex: {},
      }),
    );

    writeFlowGraph(tmpDir, model([call({ line: 20 })], [route()]));
    const g = loadGraph(tmpDir);
    expect(g.schemaVersion).toBe(2);
    expect(g.nodes).toHaveLength(2); // graphify base preserved
    expect(g.endpoints).toHaveLength(1);
    // The overlay edge anchored onto the base's List() node.
    expect(g.edgesToNode.get('ep0')?.[0].from).toBe('n1');
  });
});
