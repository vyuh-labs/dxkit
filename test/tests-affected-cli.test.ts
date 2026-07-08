/**
 * `vyuh-dxkit tests affected` — the fail-safe gates (#32). The load-bearing
 * property is that an incremental selector NEVER silently under-selects: it
 * produces a graph-derived list only when the graph is present, reliable for the
 * changed languages, and can account for every changed file; otherwise it emits
 * `complete: false, fallback: "all"` so the runner runs everything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTestsAffected } from '../src/tests-affected-cli';

const tmps: string[] = [];
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-affected-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  // dxkit's own outputs are gitignored in a real install, so the graph.json we
  // write below is NOT itself a "change" — mirror that.
  fs.writeFileSync(path.join(d, '.gitignore'), '.dxkit/\n');
  fs.writeFileSync(path.join(d, 'a.ts'), 'export function A() {}\n');
  fs.writeFileSync(path.join(d, 'a.test.ts'), "import { A } from './a';\ntest('A', () => A());\n");
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  return d;
}
function headSha(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
}
/** Write a minimal graphify graph.json where a.test.ts's test calls A in a.ts. */
function writeGraph(cwd: string, opts: { commitSha?: string } = {}): void {
  const graph = {
    schemaVersion: 1,
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '3.0.0',
      generatedAt: '2026-07-06T00:00:00Z',
      sourceFilesInGraph: 2,
      excludedFileCount: 0,
      packs: ['typescript'],
      truncated: false,
      truncatedReason: '',
      ...(opts.commitSha ? { commitSha: opts.commitSha } : {}),
    },
    nodes: [
      { id: 'A', kind: 'function', label: 'A', sourceFile: 'a.ts', line: 1 },
      { id: 'tA', kind: 'function', label: 'testA', sourceFile: 'a.test.ts', line: 2 },
    ],
    edges: [{ from: 'tA', to: 'A', relation: 'calls' }],
    communities: [],
    symbolIndex: {},
    endpoints: [],
  };
  fs.mkdirSync(path.join(cwd, '.dxkit', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.dxkit', 'reports', 'graph.json'), JSON.stringify(graph));
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function capture(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  // --json output goes via process.stdout.write; the console spy is a
  // belt-and-suspenders capture for any stray logger line.
  const w = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((s: string | Uint8Array) => (chunks.push(String(s)), true));
  const l = vi
    .spyOn(console, 'log')
    .mockImplementation((...a) => void chunks.push(a.map(String).join(' ')));
  return fn()
    .then(() => chunks.join(''))
    .finally(() => {
      w.mockRestore();
      l.mockRestore();
    });
}

describe('tests affected — fail-safe gates', () => {
  it('selects the reaching test when the graph is present, reliable, and complete', async () => {
    const d = mkRepo();
    writeGraph(d, { commitSha: headSha(d) });
    fs.appendFileSync(path.join(d, 'a.ts'), 'export function A2() {}\n'); // in-place edit
    const out = await capture(() => runTestsAffected(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.complete).toBe(true);
    expect(r.testFiles).toContain('a.test.ts');
    expect(r.stale).toBe(false); // graph SHA == HEAD, uncommitted edit doesn't flip it
  });

  it('falls back to the full suite when no graph exists', async () => {
    const d = mkRepo();
    fs.appendFileSync(path.join(d, 'a.ts'), '// x\n');
    const out = await capture(() => runTestsAffected(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.complete).toBe(false);
    expect(r.fallback).toBe('all');
    expect(r.reason).toMatch(/no code graph/i);
  });

  it('falls back when a changed file is in an unreliable-call-graph language (C#)', async () => {
    const d = mkRepo();
    writeGraph(d, { commitSha: headSha(d) });
    fs.writeFileSync(path.join(d, 'Program.cs'), 'class P {}\n'); // untracked C# change
    const out = await capture(() => runTestsAffected(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/C#|call graph/i);
  });

  it('falls back when a changed file has no graph symbol (untraceable)', async () => {
    const d = mkRepo();
    writeGraph(d, { commitSha: headSha(d) });
    fs.writeFileSync(path.join(d, 'config.json'), '{}\n'); // new, no symbol
    const out = await capture(() => runTestsAffected(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/can't account for|untraceable|no symbols/i);
  });

  it('reports complete + zero tests when nothing changed', async () => {
    const d = mkRepo();
    writeGraph(d, { commitSha: headSha(d) });
    const out = await capture(() => runTestsAffected(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.complete).toBe(true);
    expect(r.testCount).toBe(0);
  });
});
