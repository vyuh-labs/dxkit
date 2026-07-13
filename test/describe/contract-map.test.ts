import { describe, it, expect } from 'vitest';
import { buildContractMap } from '../../src/describe/contract-map';
import type { HolisticGraph } from '../../src/describe/holistic';
import type { RepoCardDoc } from '../../src/describe/repo-card-schema';

/** A minimal card (only the header fields the map reads). */
const CARD = {
  schema: 'dxkit.repo-card.v1',
  generatedAt: '2026-07-13T00:00:00.000Z',
  dxkitVersion: '3.7.0',
  provenance: { commitSha: 'abc1234', branch: 'main', workingTreeDirty: false },
  stack: {
    name: 'demo',
    description: '',
    languages: ['TypeScript'],
    framework: null,
    infrastructure: [],
  },
  flow: {
    routes: { total: 2, observed: 2, derived: 0, inferred: 0, unknown: 0 },
    calls: { total: 2, observed: 2, derived: 0, inferred: 0, unknown: 0 },
    bindings: { total: 2, observed: 1, derived: 1, inferred: 0, unknown: 0 },
    unresolvedCalls: 1,
    unconsumedRoutes: 1,
    dynamicCalls: 0,
    connectionRung: 'configured-participants',
  },
  models: {
    models: { total: 0, observed: 0, derived: 0, inferred: 0, unknown: 0 },
    dynamicModels: 0,
  },
  freshness: null,
  coverage: {
    callSitesSeen: 2,
    extracted: 2,
    dynamic: 0,
    paths: { exact: 2, templated: 0, opaque: 0 },
    note: '',
  },
  notes: [],
  zeroWrite: true,
} as RepoCardDoc;

const HOLISTIC: HolisticGraph = {
  repos: ['web', 'api'],
  nodes: [
    {
      id: 'web::call::a',
      repo: 'web',
      lane: 'caller',
      kind: 'call',
      label: 'GET /articles',
      title: 'x',
    },
    {
      id: 'web::call::b',
      repo: 'web',
      lane: 'caller',
      kind: 'call',
      label: 'GET /products',
      seam: 'broken',
      title: 'x',
    },
    {
      id: 'api::route::a',
      repo: 'api',
      lane: 'route',
      kind: 'route',
      label: 'GET /articles',
      handlerId: 'api::handler::h',
      title: 'x',
    },
    {
      id: 'api::route::d',
      repo: 'api',
      lane: 'route',
      kind: 'route',
      label: 'POST /orders',
      seam: 'dead',
      title: 'x',
    },
    {
      id: 'api::handler::h',
      repo: 'api',
      lane: 'handler',
      kind: 'handler',
      label: 'GET()',
      fanout: 4,
      drillId: 'api::a.ts#GET#1',
      title: 'x',
    },
  ],
  edges: [
    {
      from: 'web::call::a',
      to: 'api::route::a',
      kind: 'cross-repo',
      label: 'observed',
      crossRepo: true,
    },
    { from: 'api::route::a', to: 'api::handler::h', kind: 'serves', label: 'observed' },
  ],
  fns: {
    'api::a.ts#GET#1': {
      name: 'GET',
      repo: 'api',
      internal: [],
      external: ['json', 'fetch'],
      fanout: 4,
    },
  },
  counts: { routes: 2, calls: 2 },
  seams: { brokenCalls: 1, deadRoutes: 1, crossRepoEdges: 1 },
  depth: { functions: 7, meanFanout: 1.43, internalCalls: 3, externalCalls: 10 },
  notes: [],
};

describe('holistic contract map', () => {
  it('builds a self-contained, deterministic map with the seam + depth story', () => {
    const a = buildContractMap({
      card: CARD,
      holistic: HOLISTIC,
      visNetworkBundle: 'window.vis={};',
    });
    const b = buildContractMap({
      card: CARD,
      holistic: HOLISTIC,
      visNetworkBundle: 'window.vis={};',
    });
    expect(a).toBe(b); // deterministic (fixed layout, sorted) → screenshot-stable

    // self-contained
    expect(a).not.toMatch(/<script[^>]+src=/i);
    expect(a).not.toMatch(/<link[^>]+href=/i);

    // the seam + graphify-depth story is on the picture
    expect(a).toContain('broken calls');
    expect(a).toContain('dead routes');
    expect(a).toContain('cross-repo links');
    expect(a).toContain('calls mapped');
    // the artifact does NOT name or compare against graphify
    expect(a.toLowerCase()).not.toContain('graphify');
    expect(a).toContain('Nothing was written to your repo');

    // data island: nodes carry deterministic x/y and the expand payload rides along
    const m = a.match(
      /<script id="dxkit-contract-data" type="application\/json">([^<]*)<\/script>/,
    );
    expect(m).not.toBeNull();
    const data = JSON.parse(
      m![1]
        .replace(/\\u003c/g, '<')
        .replace(/\\u003e/g, '>')
        .replace(/\\u0026/g, '&'),
    );
    // nodes carry their kind (physics lays them out client-side; no baked positions)
    expect(data.nodes.every((n: { kind: string }) => typeof n.kind === 'string')).toBe(true);
    expect(Object.keys(data.fns)).toContain('api::a.ts#GET#1');
  });
});
