/**
 * Tests for src/analyzers/flow/publish.ts (the multi-repo handshake) and the
 * servedContentHash digest. publishFlow is exercised against on-disk fixtures:
 * a consumer app plus a sibling backend participant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
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

/**
 * Build a git repo serving `routes` (decorator handlers) and return its file://
 * clone URL. When `secondRoutes` is given, a `release-1` tag pins the FIRST
 * commit and a later commit adds the second set — so a ref-pinned fetch sees
 * only the tagged routes. Exercises the same fetch path a real https/ssh remote
 * takes.
 */
function makeRemoteBackend(routes: string[], secondRoutes?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowpub-remote-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'be', version: '0.0.0' }));
  mkdirSync(join(dir, 'api'), { recursive: true });
  const decl = (rs: string[]) =>
    `class C { ${rs.map((r) => `@get('${r}') h${r.replace(/\W/g, '')}() {}`).join(' ')} }\n`;
  writeFileSync(join(dir, 'api', 'ctrl.ts'), decl(routes));
  git('add', '.');
  git('commit', '-q', '-m', 'v1');
  if (secondRoutes) {
    git('tag', 'release-1');
    writeFileSync(join(dir, 'api', 'ctrl.ts'), decl([...routes, ...secondRoutes]));
    git('add', '.');
    git('commit', '-q', '-m', 'v2');
  }
  return `file://${dir}`;
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

  // ── Remote-repo participants (flow transport #2) ──────────────────────────
  // A participant declared by a `repo:` URL is fetched (no local checkout).

  it('clones a REMOTE participant and unions its served routes', async () => {
    const remote = makeRemoteBackend(['/articles', '/orphan']);
    try {
      write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
      write(root, 'app/web/List.tsx', "axios.get('/articles');\n");
      write(
        root,
        'app/.dxkit/workspace.json',
        JSON.stringify({ participants: [{ name: 'backend', repo: remote }], external: [] }),
      );
      const appDir = join(root, 'app');
      const result = await publishFlow(appDir, { generatedAt: NOW });
      expect(result.participants).toMatchObject([{ name: 'backend', routes: 2, source: 'remote' }]);
      // Provenance: the gathered commit is recorded (the staleness anchor).
      expect(result.participants[0].sha).toMatch(/^[0-9a-f]{40}$/);
      const served = readServedContract(appDir);
      expect(served?.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
        'GET /articles',
        'GET /orphan',
      ]);
    } finally {
      rmSync(remote.replace('file://', ''), { recursive: true, force: true });
    }
  });

  it('pins a REMOTE participant at a git ref (tag) — sees only the tagged routes', async () => {
    const remote = makeRemoteBackend(['/articles'], ['/added-later']);
    try {
      write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
      write(root, 'app/web/List.tsx', "axios.get('/articles');\n");
      write(
        root,
        'app/.dxkit/workspace.json',
        JSON.stringify({
          participants: [{ name: 'backend', repo: remote, ref: 'release-1' }],
          external: [],
        }),
      );
      const appDir = join(root, 'app');
      const result = await publishFlow(appDir, { generatedAt: NOW });
      // The tag predates '/added-later' → one route, not two.
      expect(result.participants).toMatchObject([{ name: 'backend', routes: 1, source: 'remote' }]);
      expect(readServedContract(appDir)?.routes.map((r) => r.path)).toEqual(['/articles']);
    } finally {
      rmSync(remote.replace('file://', ''), { recursive: true, force: true });
    }
  });

  it('marks an unreachable REMOTE participant as source=unreachable without failing', async () => {
    write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
    write(root, 'app/web/List.tsx', "axios.get('/articles');\n");
    write(
      root,
      'app/.dxkit/workspace.json',
      JSON.stringify({
        participants: [{ name: 'gone', repo: `file://${root}/does-not-exist` }],
        external: [],
      }),
    );
    const result = await publishFlow(join(root, 'app'), { generatedAt: NOW });
    expect(result.participants).toEqual([{ name: 'gone', routes: 0, source: 'unreachable' }]);
  });

  it('prefers a LOCAL checkout when present, falling back to the remote when absent', async () => {
    const remote = makeRemoteBackend(['/from-remote']);
    try {
      // Local sibling serves a DIFFERENT route, so we can tell which won.
      write(root, 'backend/package.json', JSON.stringify({ name: 'be', version: '0.0.0' }));
      write(root, 'backend/api/ctrl.ts', "class C { @get('/from-local') a() {} }\n");
      write(root, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
      write(root, 'app/web/List.tsx', "axios.get('/from-local');\n");
      const participant = { name: 'backend', path: '../backend', repo: remote };
      write(
        root,
        'app/.dxkit/workspace.json',
        JSON.stringify({ participants: [participant], external: [] }),
      );
      const appDir = join(root, 'app');

      // Local checkout present → uses it (offline, fast).
      let result = await publishFlow(appDir, { generatedAt: NOW });
      expect(result.participants).toMatchObject([{ name: 'backend', routes: 1, source: 'local' }]);
      expect(readServedContract(appDir)?.routes.map((r) => r.path)).toEqual(['/from-local']);

      // Remove the local checkout → same participant now clones the remote.
      rmSync(join(root, 'backend'), { recursive: true, force: true });
      result = await publishFlow(appDir, { generatedAt: NOW });
      expect(result.participants).toMatchObject([{ name: 'backend', routes: 1, source: 'remote' }]);
      expect(readServedContract(appDir)?.routes.map((r) => r.path)).toEqual(['/from-remote']);
    } finally {
      rmSync(remote.replace('file://', ''), { recursive: true, force: true });
    }
  });
});
