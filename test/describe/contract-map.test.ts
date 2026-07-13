import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gatherDescribeInput } from '../../src/describe/gather';
import { buildRepoCard } from '../../src/describe/repo-card';
import { projectContractMap, buildContractMap } from '../../src/describe/contract-map';

const FIXTURES = join(__dirname, '..', 'fixtures', 'analysis');
function stageFixture(stack: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dxkit-map-${stack}-`));
  cpSync(join(FIXTURES, stack), dir, { recursive: true });
  for (const { marker, target } of [
    { marker: 'env.example', target: '.env.example' },
    { marker: 'dxkit-policy.json', target: '.dxkit/policy.json' },
  ]) {
    const from = join(dir, marker);
    if (existsSync(from)) {
      mkdirSync(dirname(join(dir, target)), { recursive: true });
      renameSync(from, join(dir, target));
    }
  }
  const git = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

let dir: string;
beforeAll(async () => {
  dir = stageFixture('ts-webapp');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('describe contract map', () => {
  it('builds a self-contained, deterministic, honest HTML map', async () => {
    const input = await gatherDescribeInput(dir);
    const card = buildRepoCard(input);
    const graph = projectContractMap(input);

    const a = buildContractMap({ card, input, graph, visNetworkBundle: 'window.vis={};' });
    const b = buildContractMap({ card, input, graph, visNetworkBundle: 'window.vis={};' });

    // Deterministic: same card → byte-identical HTML (screenshot-stable).
    expect(a).toBe(b);

    // Self-contained: no external fetches (everything inlined).
    expect(a).not.toMatch(/<script[^>]+src=/i);
    expect(a).not.toMatch(/<link[^>]+href=/i);
    expect(a).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);

    // Honesty is on the picture.
    expect(a).toContain('Nothing was written to your repo');
    expect(a).toContain('dxkit-contract-data');
    expect(a).toContain('unresolved calls');
    expect(a).toContain('unconsumed routes');

    // The data island is present and parseable.
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
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it('projects seam classes deterministically', async () => {
    const input = await gatherDescribeInput(dir);
    const g1 = projectContractMap(input);
    const g2 = projectContractMap(input);
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    // Node ids are sorted (stable ordering).
    const ids = g1.nodes.map((n) => n.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
