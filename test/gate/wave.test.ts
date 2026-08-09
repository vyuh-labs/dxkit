import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateWaveGate } from '../../src/analyzers/flow/wave';
import { discoverMembers, readDeclaredFlows } from '../../src/gate-wave';
import type { RepoFlowModel } from '../../src/analyzers/flow/model';

/**
 * 4.4.0 WP7 — the estate wave evaluator (pure layer) + the wave
 * surface's readers. The end-to-end acceptance (seeded estate BLOCKED,
 * fixed estate PASSED) ran against the real workspace fixture; these
 * pin the mechanism.
 */

function model(input: {
  routes?: Array<{ method: string; path: string; file: string }>;
  calls?: Array<{ method: string; path: string; file: string; confidence?: number }>;
}): RepoFlowModel {
  // Assemble through the model shapes directly (buildFlowModel wants
  // per-file gathers; findings only need routes/calls/bindings).
  const routes = (input.routes ?? []).map((r) => ({
    method: r.method as never,
    path: r.path,
    via: 'router-call' as const,
    handler: null,
    file: r.file,
    line: 1,
  }));
  const calls = (input.calls ?? []).map((c) => ({
    method: c.method as never,
    rawUrl: c.path,
    path: c.path,
    receiver: 'fetch',
    file: c.file,
    line: 1,
  }));
  return {
    calls,
    routes,
    bindings: calls.map((call) => ({ call, route: null, confidence: 1, reason: 'no-route' })),
    dynamicCalls: [],
  } as unknown as RepoFlowModel;
}

describe('evaluateWaveGate', () => {
  it('resolves calls across members (the mesh), flags what nobody serves, and catch-alls cover', () => {
    const result = evaluateWaveGate({
      members: [
        {
          name: 'a',
          model: model({
            routes: [
              { method: 'GET', path: '/orders', file: 'a/srv.js' },
              { method: 'GET', path: '/files/{*}', file: 'a/files.js' }, // canonical CATCHALL token
            ],
          }),
        },
        {
          name: 'b',
          model: model({
            calls: [
              { method: 'GET', path: '/orders', file: 'b/app.js' }, // served by a
              { method: 'GET', path: '/files/report.pdf', file: 'b/app.js' }, // catch-all
              { method: 'GET', path: '/tax', file: 'b/app.js' }, // NOBODY serves
            ],
          }),
        },
      ],
    });
    const unresolved = result.seamFindings.filter((f) => f.reason === 'no-route');
    expect(unresolved.map((f) => f.path)).toEqual(['/tax']);
    expect(unresolved[0].verdict).toBe('block');
    expect(unresolved[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.blocks).toBe(true);
  });

  it('dead routes: consumers are member calls ∪ declared flow steps; findings WARN', () => {
    const result = evaluateWaveGate({
      members: [
        {
          name: 'a',
          model: model({
            routes: [
              { method: 'GET', path: '/price', file: 'a/srv.js' }, // consumed by flow
              { method: 'GET', path: '/legacy', file: 'a/srv.js' }, // consumed by NOBODY
            ],
          }),
        },
      ],
      flows: [{ id: 'quote', steps: [{ call: 'GET /price' }] }],
    });
    const dead = result.seamFindings.filter((f) => f.reason === 'dead-route');
    expect(dead.map((f) => f.path)).toEqual(['/legacy']);
    expect(dead[0].verdict).toBe('warn');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(true);
  });

  it('broken flows: identity is the flow id alone; malformed steps are DISCLOSED, never satisfied', () => {
    const run = (steps: Array<Record<string, unknown>>) =>
      evaluateWaveGate({
        members: [
          { name: 'a', model: model({ routes: [{ method: 'GET', path: '/a', file: 'a/s.js' }] }) },
        ],
        flows: [{ id: 'journey', steps: steps as never }],
      });
    const broken = run([{ call: 'GET /a' }, { call: 'GET /missing' }]);
    expect(broken.flowFindings).toHaveLength(1);
    expect(broken.flowFindings[0].missingSteps).toEqual([{ method: 'GET', path: '/missing' }]);
    expect(broken.blocks).toBe(true);
    // Identity stays fixed as the failing step set changes (name-only doctrine).
    const brokenDifferently = run([{ call: 'GET /other-missing' }]);
    expect(brokenDifferently.flowFindings[0].id).toBe(broken.flowFindings[0].id);
    // A malformed step is disclosed and never counts as satisfied.
    const malformed = run([{ nonsense: true }]);
    expect(malformed.malformedFlowSteps).toHaveLength(1);
    expect(malformed.flowFindings).toHaveLength(0); // no PARSEABLE step failed
  });
});

describe('the wave surface readers', () => {
  it('readDeclaredFlows accepts flow.v1 docs, bare arrays, and bare objects; discloses garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-wave-flows-'));
    try {
      writeFileSync(
        join(dir, 'a.flow.json'),
        JSON.stringify({ schema: 'flow.v1', flows: [{ id: 'one', steps: [] }] }),
      );
      writeFileSync(join(dir, 'b.flow.json'), JSON.stringify({ id: 'two', steps: [] }));
      writeFileSync(join(dir, 'c.flow.json'), 'not-json');
      const { flows, malformed } = readDeclaredFlows(dir);
      expect(flows.map((f) => f.id).sort()).toEqual(['one', 'two']);
      expect(malformed).toHaveLength(1);
      expect(malformed[0].file).toContain('c.flow.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discoverMembers: immediate subdirs, dot-dirs + the flows dir excluded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-wave-members-'));
    try {
      for (const d of ['pkg-a', 'pkg-b', '.hidden', 'flows']) mkdirSync(join(dir, d));
      writeFileSync(join(dir, 'stray-file.txt'), 'x');
      expect(discoverMembers(dir, join(dir, 'flows'))).toEqual(['pkg-a', 'pkg-b']);
      expect(discoverMembers(dir)).toEqual(['flows', 'pkg-a', 'pkg-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
