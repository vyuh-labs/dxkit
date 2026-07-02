/**
 * Tests for src/analyzers/flow/publish.ts (the multi-repo handshake) and the
 * servedContentHash digest. publishFlow is exercised against on-disk fixtures:
 * a consumer app plus a sibling backend participant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { publishFlow } from '../src/analyzers/flow/publish';
import { servedContentHash, readServedContract } from '../src/analyzers/flow/contract';

const NOW = '2026-07-02T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('servedContentHash', () => {
  it('is stable and order-independent, and changes when routes change', () => {
    const a = [
      { method: 'GET', path: '/x', handler: null, via: 'decorator' as const },
      { method: 'POST', path: '/y', handler: null, via: 'decorator' as const },
    ];
    const reordered = [a[1], a[0]];
    expect(servedContentHash(a)).toBe(servedContentHash(reordered)); // order-independent
    const changed = [...a, { method: 'GET', path: '/z', handler: null, via: 'decorator' as const }];
    expect(servedContentHash(changed)).not.toBe(servedContentHash(a)); // drift detected
  });
});

describe('publishFlow', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dxkit-flowpub-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('unions a participant’s served routes into this repo’s served.json', async () => {
    // Sibling backend serves two routes.
    write(root, 'backend/package.json', JSON.stringify({ name: 'be', version: '0.0.0' }));
    write(
      root,
      'backend/api/ctrl.ts',
      "class C { @get('/articles') a() {} @get('/orphan') b() {} }\n",
    );
    // Consumer app calls one served + one missing, with backend as a participant.
    write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
    write(root, 'app/web/List.tsx', "axios.get('/articles');\naxios.get('/missing');\n");
    write(
      root,
      'app/.dxkit/workspace.json',
      JSON.stringify({ participants: [{ name: 'backend', path: '../backend' }], external: [] }),
    );

    const appDir = join(root, 'app');
    const result = await publishFlow(appDir, { generatedAt: NOW });

    expect(result.participants).toEqual([{ name: 'backend', routes: 2, source: 'local' }]);
    expect(result.totalServedRoutes).toBe(2);
    expect(existsSync(result.servedPath)).toBe(true);
    const served = readServedContract(appDir);
    expect(served?.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /articles',
      'GET /orphan',
    ]);
    expect(served?.contentHash).toBe(result.contentHash);
  });

  it('marks a participant whose path is missing as source=missing without failing', async () => {
    write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
    write(root, 'app/web/List.tsx', "axios.get('/articles');\n");
    write(
      root,
      'app/.dxkit/workspace.json',
      JSON.stringify({ participants: [{ name: 'ghost', path: '../nope' }], external: [] }),
    );
    const result = await publishFlow(join(root, 'app'), { generatedAt: NOW });
    expect(result.participants).toEqual([{ name: 'ghost', routes: 0, source: 'missing' }]);
  });

  it('publishes this repo’s own served routes when there are no participants', async () => {
    write(root, 'package.json', JSON.stringify({ name: 'mono', version: '0.0.0' }));
    write(root, 'web/List.tsx', "axios.get('/articles');\n");
    write(root, 'api/ctrl.ts', "class C { @get('/articles') a() {} }\n");
    const result = await publishFlow(root, { generatedAt: NOW });
    expect(result.participants).toEqual([]);
    expect(result.totalServedRoutes).toBe(1);
    expect(result.consumedBindings).toBeGreaterThan(0);
  });
});
