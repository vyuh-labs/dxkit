import { describe, it, expect } from 'vitest';
import { buildIntraRepoModel, buildHolisticGraph } from '../../src/describe/holistic';
import type { FunctionSignature } from '../../src/analyzers/duplication/signatures';
import type { FlowModel } from '../../src/analyzers/flow/model';

/** Build a FlowModel with the fields the holistic builder reads. */
function flow(over: Partial<FlowModel>): FlowModel {
  return { calls: [], routes: [], bindings: [], dynamicCalls: [], ...over } as FlowModel;
}
const sig = (file: string, name: string, line: number, callees: string[]): FunctionSignature => ({
  file,
  name,
  line,
  callees: new Set(callees),
});

describe('holistic intra-repo model (dxkit-AST graph ⋈ contract)', () => {
  it('resolves callee names to in-repo defs vs external, and anchors routes/calls', () => {
    const sigs = [
      sig('api/route.ts', 'GET', 1, ['loadUsers', 'json', 'fetch']), // 1 internal (loadUsers), 2 external
      sig('api/svc.ts', 'loadUsers', 1, ['query']), // query = external
    ];
    const model = buildIntraRepoModel(
      'api',
      '/repo',
      sigs,
      flow({
        routes: [
          {
            method: 'GET',
            path: '/users',
            via: 'file-route',
            handler: 'GET',
            file: '/repo/api/route.ts',
            line: 1,
          } as never,
        ],
      }),
    );
    expect(model.stats.functions).toBe(2);
    expect(model.stats.externalCalls).toBe(3); // json, fetch, query
    expect(model.stats.internalEdges).toBe(1); // GET → loadUsers
    // route anchored to its handler fn (by name-in-file)
    expect(model.routes[0].handlerId).toBe('api/route.ts#GET#1');
    const handler = model.fnById.get(model.routes[0].handlerId!)!;
    expect(handler.fanout).toBe(3);
    expect(handler.externalCallees).toEqual(expect.arrayContaining(['json', 'fetch']));
  });
});

describe('holistic cross-repo mesh (broken / dead / cross-repo)', () => {
  it('classifies calls across the whole mesh', () => {
    // web calls /articles (→api) + /products (broken); api serves /articles + /orders (dead).
    const web = buildIntraRepoModel(
      'web',
      '/web',
      [sig('web/x.ts', 'load', 1, ['fetch'])],
      flow({
        calls: [
          {
            method: 'GET',
            path: '/articles',
            rawUrl: '/articles',
            receiver: 'fetch',
            file: '/web/x.ts',
            line: 1,
          } as never,
          {
            method: 'GET',
            path: '/products',
            rawUrl: '/products',
            receiver: 'fetch',
            file: '/web/x.ts',
            line: 1,
          } as never,
        ],
      }),
    );
    const api = buildIntraRepoModel(
      'api',
      '/api',
      [sig('api/a.ts', 'GET', 1, [])],
      flow({
        routes: [
          {
            method: 'GET',
            path: '/articles',
            via: 'file-route',
            handler: 'GET',
            file: '/api/a.ts',
            line: 1,
          } as never,
          {
            method: 'POST',
            path: '/orders',
            via: 'file-route',
            handler: 'POST',
            file: '/api/o.ts',
            line: 1,
          } as never,
        ],
      }),
    );
    const g = buildHolisticGraph([web, api]);
    expect(g.repos).toEqual(['web', 'api']);
    expect(g.seams.crossRepoEdges).toBe(1); // /articles resolved across the boundary
    expect(g.seams.brokenCalls).toBe(1); // /products serves nowhere
    expect(g.seams.deadRoutes).toBe(1); // /orders consumed by nobody
    expect(g.edges.some((e) => e.crossRepo)).toBe(true);
    // the broken call node is flagged
    expect(g.nodes.some((n) => n.kind === 'call' && n.seam === 'broken')).toBe(true);
    // the dead route node is flagged
    expect(
      g.nodes.some((n) => n.kind === 'route' && n.seam === 'dead' && n.label.includes('/orders')),
    ).toBe(true);
  });
});
