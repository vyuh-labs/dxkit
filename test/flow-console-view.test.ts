/**
 * Integration tests for `runFlowConsole` (src/flow-cli.ts) — the read
 * orchestrator behind `vyuh-dxkit flow console`. Exercised end-to-end against a
 * real on-disk git fixture (a monorepo frontend + backend), so the diff scope
 * (via `computeChangedFiles`) and the gate pass (via `withRefWorktree`) run for
 * real, not mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { runFlowConsole } from '../src/flow-cli';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** The generated console captures its output path in --json mode; recover it
 *  and read the embedded data island back. */
function readConsole(root: string, outPath: string): Record<string, unknown> {
  const html = readFileSync(outPath, 'utf8');
  const m = html.match(
    /<script id="dxkit-flow-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error('no data island');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

const FRONTEND = `import axios from 'axios';
export const listArticles = () => axios.get('/articles');
export const getArticle = (slug) => axios.get(\`/articles/\${slug}\`);
export const createArticle = (d) => axios.post('/articles', d);
`;
const BACKEND = `import { Router } from 'express';
const app = Router();
app.get('/articles', (req, res) => res.json([]));
app.get('/articles/:slug', (req, res) => res.json({}));
app.post('/articles', (req, res) => res.json({}));
export default app;
`;

describe('runFlowConsole', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dxkit-flowconsole-'));
    write(root, 'package.json', JSON.stringify({ name: 'fx', version: '1.0.0' }));
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'commonjs' } }));
    write(root, 'frontend/api.ts', FRONTEND);
    write(root, 'backend/routes.ts', BACKEND);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@t.t');
    git(root, 'config', 'user.name', 'test');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('full scope: writes a self-contained HTML console with every endpoint', async () => {
    await runFlowConsole({ cwd: root });
    const outPath = join(root, '.dxkit', 'reports', 'flow-console.html');
    const html = readFileSync(outPath, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const data = readConsole(root, outPath);
    expect((data.meta as { scope: string }).scope).toBe('full');
    // 3 served routes, all consumed by the frontend.
    expect((data.endpoints as unknown[]).length).toBe(3);
    expect((data.broken as unknown[]).length).toBe(0);
  });

  it('diff scope: a net-new dead call is surfaced as a broken integration', async () => {
    const base = git(root, 'rev-parse', 'HEAD').trim();
    // Working-tree only: a new call to a route no backend serves.
    appendFileSync(
      join(root, 'frontend/api.ts'),
      'export const getWidget = (id) => axios.get(`/widgets/${id}`);\n',
    );
    await runFlowConsole({ cwd: root, diff: base });
    const data = readConsole(root, join(root, '.dxkit', 'reports', 'flow-console.html'));
    expect((data.meta as { scope: string }).scope).toBe('diff');
    const broken = data.broken as Array<{ path: string; broken: { reason: string } }>;
    expect(broken).toHaveLength(1);
    expect(broken[0].path).toBe('/widgets/{var}');
    expect(broken[0].broken.reason).toBe('no-route');
  });

  it('diff scope + --no-gate: still scopes to the change but runs no gate pass', async () => {
    const base = git(root, 'rev-parse', 'HEAD').trim();
    appendFileSync(
      join(root, 'frontend/api.ts'),
      'export const getWidget = (id) => axios.get(`/widgets/${id}`);\n',
    );
    await runFlowConsole({ cwd: root, diff: base, noGate: true });
    const data = readConsole(root, join(root, '.dxkit', 'reports', 'flow-console.html'));
    expect((data.meta as { scope: string }).scope).toBe('diff');
    expect((data.broken as unknown[]).length).toBe(0);
  });

  it('honours --out for the artifact location', async () => {
    const out = join(root, 'custom', 'console.html');
    await runFlowConsole({ cwd: root, out });
    expect(() => readFileSync(out, 'utf8')).not.toThrow();
  });
});
