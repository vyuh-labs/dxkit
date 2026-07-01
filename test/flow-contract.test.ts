/**
 * Tests for src/analyzers/flow/contract.ts — the cross-repo served/consumed
 * snapshots. Covers building from a model (dedup, spec-wins, sort stability),
 * the write→read round-trip, fail-open reads, and the served key-set lookup.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildServedContract,
  buildConsumedContract,
  writeServedContract,
  writeConsumedContract,
  readServedContract,
  readConsumedContract,
  servedKeySet,
  FLOW_DIR,
  SERVED_SNAPSHOT,
} from '../src/analyzers/flow/contract';
import type { ClientCall, RouteEndpoint } from '../src/analyzers/flow/extract';
import type { FlowModel } from '../src/analyzers/flow/model';

const META = { schemaVersion: 1 as const, generatedAt: '2026-07-01T00:00:00Z' };

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
  return { calls, routes, bindings: [] };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-contract-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildServedContract', () => {
  it('dedups by (method, path) with spec winning, sorted stably', () => {
    const c = buildServedContract(
      model(
        [],
        [
          route({ path: '/b', via: 'router-call' }),
          route({ path: '/a', via: 'router-call' }),
          route({ path: '/a', via: 'spec', handler: 'spec.a' }),
        ],
      ),
      META,
    );
    expect(c.side).toBe('served');
    expect(c.routes.map((r) => r.path)).toEqual(['/a', '/b']); // sorted
    const a = c.routes.find((r) => r.path === '/a');
    expect(a?.via).toBe('spec');
    expect(a?.handler).toBe('spec.a');
  });
});

describe('buildConsumedContract', () => {
  it('keeps internal calls, drops external (null path), dedups by (method,path,file)', () => {
    const c = buildConsumedContract(
      model(
        [
          call({ path: '/x', file: 'web/a.tsx', line: 30 }),
          call({ path: '/x', file: 'web/a.tsx', line: 10 }), // dup, lower line kept
          call({ path: null, file: 'web/a.tsx', line: 5 }), // external → dropped
          call({ path: '/y', method: 'POST', file: 'web/b.tsx', line: 3 }),
        ],
        [],
      ),
      META,
    );
    expect(c.side).toBe('consumed');
    expect(c.bindings).toHaveLength(2);
    const x = c.bindings.find((b) => b.path === '/x');
    expect(x?.line).toBe(10); // earliest line kept for display
    expect(c.bindings.some((b) => b.method === 'POST' && b.path === '/y')).toBe(true);
  });
});

describe('write → read round-trip', () => {
  it('served snapshot round-trips and lands at .dxkit/flow/served.json', () => {
    const c = buildServedContract(model([], [route({ path: '/a' })]), META);
    const file = writeServedContract(tmpDir, c);
    expect(file).toBe(path.join(tmpDir, FLOW_DIR, SERVED_SNAPSHOT));
    const back = readServedContract(tmpDir);
    expect(back?.routes.map((r) => r.path)).toEqual(['/a']);
  });

  it('consumed snapshot round-trips', () => {
    const c = buildConsumedContract(model([call({ path: '/x' })], []), META);
    writeConsumedContract(tmpDir, c);
    const back = readConsumedContract(tmpDir);
    expect(back?.bindings[0]).toMatchObject({ method: 'GET', path: '/x', file: 'web/a.tsx' });
  });
});

describe('fail-open reads', () => {
  it('returns undefined for a missing snapshot', () => {
    expect(readServedContract(tmpDir)).toBeUndefined();
    expect(readConsumedContract(tmpDir)).toBeUndefined();
  });

  it('returns undefined for a malformed or wrong-side snapshot', () => {
    fs.mkdirSync(path.join(tmpDir, FLOW_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, FLOW_DIR, SERVED_SNAPSHOT), '{ not json');
    expect(readServedContract(tmpDir)).toBeUndefined();
    // A consumed doc read as served → undefined (side guard).
    const consumed = buildConsumedContract(model([call({})], []), META);
    writeConsumedContract(tmpDir, consumed);
    expect(
      readServedContract(tmpDir, path.join(tmpDir, FLOW_DIR, 'consumed.json')),
    ).toBeUndefined();
  });
});

describe('servedKeySet', () => {
  it('exposes the ${method} ${path} lookup keys', () => {
    const c = buildServedContract(
      model([], [route({ path: '/a' }), route({ method: 'POST', path: '/b' })]),
      META,
    );
    const keys = servedKeySet(c);
    expect(keys.has('GET /a')).toBe(true);
    expect(keys.has('POST /b')).toBe(true);
    expect(keys.has('DELETE /a')).toBe(false);
  });
});
