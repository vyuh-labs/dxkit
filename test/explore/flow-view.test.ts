/**
 * Tests for src/explore/flow-view.ts — the read-side orchestration the flow CLI
 * consumes (write overlay → reload → query). Exercised with a synthetic model
 * against a temp cwd, so no gather / source parsing is involved.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFlowMap, buildFlowTrace } from '../../src/explore/flow-view';
import type { ClientCall, RouteEndpoint } from '../../src/analyzers/flow/extract';
import type { FlowModel } from '../../src/analyzers/flow/model';

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

const CALL: ClientCall = {
  method: 'GET',
  rawUrl: '/articles',
  path: '/articles',
  receiver: 'axios',
  file: 'web/List.tsx',
  line: 20,
};
const ROUTE: RouteEndpoint = {
  method: 'GET',
  path: '/articles',
  via: 'router-call',
  handler: 'ArticleController.find',
  file: 'api/articles.ts',
  line: 5,
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-flowview-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildFlowMap', () => {
  it('writes the overlay and returns the queried map', () => {
    const map = buildFlowMap(tmpDir, model([CALL], [ROUTE]));
    expect(map.totalEndpoints).toBe(1);
    expect(map.totalBindings).toBe(1);
    expect(map.endpoints[0].consumerCount).toBe(1);
    // The graph artifact was persisted.
    expect(fs.existsSync(path.join(tmpDir, '.dxkit/reports/graph.json'))).toBe(true);
  });
});

describe('buildFlowTrace', () => {
  it('resolves by exact join key and returns the trace', () => {
    const { trace, candidates } = buildFlowTrace(tmpDir, model([CALL], [ROUTE]), 'GET /articles');
    expect(trace.found).toBe(true);
    expect(trace.handler).toBe('ArticleController.find');
    expect(candidates).toEqual([]);
  });

  it('resolves a method-lowercased key (pasted verbatim from a user)', () => {
    const { trace } = buildFlowTrace(tmpDir, model([CALL], [ROUTE]), 'get /articles');
    expect(trace.found).toBe(true);
  });

  it('resolves by endpoint id', () => {
    const { trace } = buildFlowTrace(tmpDir, model([CALL], [ROUTE]), 'ep0');
    expect(trace.found).toBe(true);
  });

  it('returns not-found with candidate labels for an unknown target', () => {
    const { trace, candidates } = buildFlowTrace(tmpDir, model([CALL], [ROUTE]), 'GET /nope');
    expect(trace.found).toBe(false);
    expect(candidates).toContain('GET /articles');
  });
});
