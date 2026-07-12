/**
 * Integration tests for src/baseline/dup-gate-check.ts — the additive,
 * fail-open structural-duplicate (seam) gate over a real ref-based comparison.
 *
 * The graph provider is INJECTED (the graphify gather is heavy + needs Python),
 * so these tests pin the two-ref gate LOGIC deterministically: opt-in gating,
 * trigger-skip, net-new grandfathering against the base ref, diff-scoping,
 * allowlist suppression, and fail-open — over a genuine `git` worktree, without
 * ever invoking graphify. The detector itself is pinned separately in
 * test/explore/duplicate-pairs-query.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateDupGateForGuardrail } from '../../src/baseline/dup-gate-check';
import type { GraphGatherOutcome } from '../../src/analyzers/tools/graphify';
import type { GraphJson, GraphNode, GraphEdge } from '../../src/explore/types';
import { computeCodeReimplementationFingerprint } from '../../src/analyzers/tools/fingerprint';
import type { AllowlistFile } from '../../src/allowlist/file';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

let idc = 0;
function fn(label: string, sourceFile: string, line = 1): GraphNode {
  return { id: `${sourceFile}#${label}#${idc++}`, kind: 'function', label, sourceFile, line };
}
function helper(name: string): GraphNode {
  return {
    id: `lib#${name}#${idc++}`,
    kind: 'function',
    label: name,
    sourceFile: 'src/lib.ts',
    line: 1,
  };
}
function graphOf(nodes: GraphNode[], edges: GraphEdge[]): GraphJson {
  return {
    schemaVersion: 2,
    meta: {
      tool: 'graphify',
      graphifyVersion: '0',
      dxkitVersion: '0',
      generatedAt: '',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges,
    communities: [],
    symbolIndex: {},
    endpoints: [],
  };
}

/** A copy-paste pair: `a` and `b` both call the same 3 helpers by the same
 *  name → callee-Jaccard 1.0, name-Jaccard 1.0, score 1.0. */
function pairGraph(fileA: string, fileB: string): GraphJson {
  const h = ['query', 'requireUser', 'respond'].map(helper);
  const a = fn('GET', fileA, 10);
  const b = fn('GET', fileB, 12);
  const edges = h.flatMap((x) => [
    { from: a.id, to: x.id, relation: 'calls' as const },
    { from: b.id, to: x.id, relation: 'calls' as const },
  ]);
  return graphOf([...h, a, b], edges);
}

const EMPTY = graphOf([], []);
function ok(g: GraphJson): GraphGatherOutcome {
  return { kind: 'success', graph: g };
}

/** A repo with the seam gate enabled (mode warn), a source file touched by the
 *  HEAD change, committed on `main` as the base. */
function makeRepo(mode: 'warn' | 'block' | 'off' = 'warn'): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-dupgate-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify({ duplication: { mode } }));
  mkdirSync(join(dir, 'src', 'api', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'src', 'api', 'divisions.ts'), 'export const GET = () => {};\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  // The PR change: add a new source file (a CLI variant), so the diff touches source.
  writeFileSync(join(dir, 'src', 'api', 'cli', 'divisions.ts'), 'export const GET = () => {};\n');
  return { dir, baseSha };
}

/** Inject a provider that returns `head` for the working tree (cwd) and `base`
 *  for anything else (the ref worktree). */
function provider(head: GraphGatherOutcome, base: GraphGatherOutcome, cwd: string) {
  return async (dir: string): Promise<GraphGatherOutcome> => (dir === cwd ? head : base);
}

describe('evaluateDupGateForGuardrail — two-ref seam gate', () => {
  it('skips at zero cost when policy mode is off (no graph build)', async () => {
    const { dir, baseSha } = makeRepo('off');
    let called = false;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherGraph: async () => {
        called = true;
        return ok(EMPTY);
      },
    });
    expect(out.skipped).toBe('off');
    expect(called).toBe(false);
  });

  it('flags a NET-NEW duplicate the diff introduced (absent at base)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const head = pairGraph('src/api/divisions.ts', 'src/api/cli/divisions.ts');
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      // Base had only the original handler, no duplicate.
      gatherGraph: provider(ok(head), ok(EMPTY), dir),
    });
    expect(out.ran).toBe(true);
    expect(out.warns).toBe(true);
    expect(out.blocks).toBe(false); // a lone duplicate never blocks
    expect(out.findings).toHaveLength(1);
    expect(out.mode).toBe('warn');
    // The gate marks WHICH anchor the change introduced (the added CLI variant),
    // so remediation is directional. The base file is not in the changed set.
    const f = out.findings[0];
    expect(f.changed).toBeDefined();
    const changedAnchor = f.anchors.find((_, i) => f.changed![i]);
    const unchangedAnchor = f.anchors.find((_, i) => !f.changed![i]);
    expect(changedAnchor?.file).toBe('src/api/cli/divisions.ts');
    expect(unchangedAnchor?.file).toBe('src/api/divisions.ts');
  });

  it('GRANDFATHERS a duplicate present at BOTH refs (never blocks pre-existing debt)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    // The SAME duplicate exists at head AND base → not net-new.
    const g = pairGraph('src/api/divisions.ts', 'src/api/cli/divisions.ts');
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherGraph: provider(ok(g), ok(g), dir),
    });
    expect(out.warns).toBe(false);
    expect(out.findings).toHaveLength(0);
    // It RAN the base comparison and grandfathered the pre-existing pair —
    // not a skip, just zero net-new.
    expect(out.ran).toBe(true);
    expect(out.skipped).toBeUndefined();
  });

  it('never builds the base graph when HEAD has no candidate (the cost guard)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    let baseBuilt = false;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherGraph: async (d: string) => {
        if (d !== dir) baseBuilt = true;
        return ok(EMPTY); // HEAD has no duplicate
      },
    });
    expect(out.skipped).toBe('no-candidates');
    expect(baseBuilt).toBe(false);
  });

  it('fail-opens (skips, never throws) when graphify is unavailable on HEAD', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherGraph: async () => ({ kind: 'unavailable', reason: 'not installed' }),
    });
    expect(out.skipped).toBe('no-graph');
    expect(out.blocks).toBe(false);
  });

  it('an active code-reimplementation allowlist entry waives the finding', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const head = pairGraph('src/api/divisions.ts', 'src/api/cli/divisions.ts');
    // Recompute the finding id the gate will mint (canonical sorted anchors).
    const id = computeCodeReimplementationFingerprint(
      { file: 'src/api/divisions.ts', symbol: 'GET', line: 10 },
      { file: 'src/api/cli/divisions.ts', symbol: 'GET', line: 12 },
    );
    const allowlist: AllowlistFile = {
      version: 1,
      entries: [
        {
          fingerprint: id,
          kind: 'code-reimplementation',
          category: 'false-positive',
          reason: 'sanctioned parallel',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    } as unknown as AllowlistFile;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      allowlist,
      gatherGraph: provider(ok(head), ok(EMPTY), dir),
    });
    expect(out.warns).toBe(false);
    expect(out.findings).toHaveLength(0);
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0].fingerprint).toBe(id);
  });
});
