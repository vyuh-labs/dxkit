/**
 * Tests for src/analyzers/flow/diagnose.ts — the flow-contract diagnosis folded
 * into `doctor`. Each case builds a small on-disk repo (the extractor reads the
 * working tree) and asserts the unresolved tail + reasons, the unconsumed-route
 * list, and the connection-resolution rung.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { diagnoseFlow } from '../src/analyzers/flow/diagnose';

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowdiag-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('diagnoseFlow', () => {
  it('reports the unresolved tail with reasons + suggestions (monorepo)', async () => {
    const dir = makeRepo({
      'web/List.tsx': "axios.get('/articles');\naxios.get('/dead');\n",
      'api/ctrl.ts': "class C { @get('/articles') a() {} @get('/orphan') b() {} }\n",
    });
    try {
      const d = await diagnoseFlow(dir);
      expect(d).not.toBeNull();
      expect(d!.topology).toBe('monorepo');
      expect(d!.resolved).toBe(1);
      // The dead call is unresolved: no served route matches, and a monorepo
      // serves its own routes → the suggestion is to add the route.
      const dead = d!.unresolved.find((u) => u.path === '/dead');
      expect(dead).toBeDefined();
      expect(dead!.reason).toBe('no-route');
      expect(dead!.suggestion).toBe('add-route');
      // The orphan route nobody calls is surfaced as served-but-unconsumed.
      expect(d!.servedUnconsumed.map((r) => r.path)).toContain('/orphan');
      expect(d!.connection.rung).toBe('monorepo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suggests configure-participant for a consumer-only repo with no served side', async () => {
    const dir = makeRepo({
      'web/List.tsx': "axios.get('/articles');\n",
    });
    try {
      const d = await diagnoseFlow(dir);
      expect(d).not.toBeNull();
      expect(d!.topology).toBe('consumer-only');
      // No routes in-repo, so the call can't resolve; the provider lives
      // elsewhere → configure a participant / counterpart.
      const call = d!.unresolved.find((u) => u.path === '/articles');
      expect(call?.suggestion).toBe('configure-participant');
      expect(d!.connection.rung).toBe('unresolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a clean contract (no unresolved, no unconsumed) when everything binds', async () => {
    const dir = makeRepo({
      'web/List.tsx': "axios.get('/articles');\n",
      'api/ctrl.ts': "class C { @get('/articles') a() {} }\n",
    });
    try {
      const d = await diagnoseFlow(dir);
      expect(d!.unresolved).toEqual([]);
      expect(d!.servedUnconsumed).toEqual([]);
      expect(d!.resolved).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces committed-contract freshness (generatedAt + per-participant provenance)', async () => {
    const dir = makeRepo({
      'web/List.tsx': "axios.get('/articles');\n",
      '.dxkit/flow/served.json': JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-01T00:00:00.000Z',
        side: 'served',
        routes: [{ method: 'GET', path: '/articles', handler: null, via: 'spec' }],
        participants: [
          { name: 'backend', source: 'remote', routes: 1, sha: 'a'.repeat(40), ref: 'main' },
        ],
      }),
    });
    try {
      const d = await diagnoseFlow(dir);
      expect(d).not.toBeNull();
      expect(d!.contract?.generatedAt).toBe('2026-06-01T00:00:00.000Z');
      // No workspace entry for the participant → tip unknowable → honest null,
      // never a false stale verdict.
      expect(d!.contract?.participants[0]).toMatchObject({ name: 'backend', moved: null });
      expect(d!.contract?.stale).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('coverage honesty: dynamic call sites are counted and the blind-spot note is present', async () => {
    const dir = makeRepo({
      'web/List.tsx': [
        "axios.get('/articles');", // exact
        'axios.get(`/articles/${slug}`);', // templated
        'fetch(buildUrl());', // dynamic — recognized, unverifiable
        'fetch(endpoint);', // dynamic
      ].join('\n'),
      'api/ctrl.ts': "class C { @get('/articles') a() {} }\n",
    });
    try {
      const d = await diagnoseFlow(dir);
      expect(d).not.toBeNull();
      const cov = d!.coverage;
      expect(cov.extracted).toBe(2);
      expect(cov.dynamic).toBe(2);
      expect(cov.callSitesSeen).toBe(4);
      expect(cov.paths).toEqual({ exact: 1, templated: 1, opaque: 0 });
      expect(cov.dynamicSites.map((x) => x.receiver)).toEqual(['fetch', 'fetch']);
      expect(cov.note).toMatch(/cannot be verified/);
      expect(cov.note).toMatch(/GraphQL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the repo has no flow surface (doctor omits the section)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowdiag-none-'));
    try {
      writeFileSync(join(dir, 'README.md'), '# hi\n');
      expect(await diagnoseFlow(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
