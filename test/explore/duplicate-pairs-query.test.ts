import { describe, it, expect } from 'vitest';
import { indexGraph } from '../../src/explore/load';
import {
  duplicatePairsQuery,
  DUP_MIN_CALLEES,
  DUP_DEFAULT_MIN_SCORE,
} from '../../src/explore/queries';
import type { GraphJson, GraphNode, GraphEdge } from '../../src/explore/types';

/**
 * Structural-duplicate detector (tier-3 `code-reimplementation`) — unit tests
 * over synthetic graphs, so the behavior is pinned independently of graphify.
 * Mirrors the validated Exp-B detector: callee/name Jaccard, the MIN_CALLEES
 * structural floor, test-file exclusion, and the diff-scope focus set.
 */

let idc = 0;
function fn(label: string, sourceFile: string, line = 1): GraphNode {
  return { id: `${sourceFile}#${label}#${idc++}`, kind: 'function', label, sourceFile, line };
}
function helper(sourceFile: string, name: string): GraphNode {
  return {
    id: `${sourceFile}#${name}#${idc++}`,
    kind: 'function',
    label: name,
    sourceFile,
    line: 1,
  };
}
function calls(from: GraphNode, to: GraphNode): GraphEdge {
  return { from: from.id, to: to.id, relation: 'calls' };
}

function build(nodes: GraphNode[], edges: GraphEdge[]): GraphJson {
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

/** Two functions that call the SAME three helpers with the SAME name → a
 *  textbook copy-paste (callee-Jaccard 1.0, name-Jaccard 1.0). */
function copyPasteGraph(): GraphJson {
  const h1 = helper('src/lib/db.ts', 'query');
  const h2 = helper('src/lib/auth.ts', 'requireUser');
  const h3 = helper('src/lib/http.ts', 'respond');
  const a = fn('GET', 'src/api/divisions/route.ts', 10);
  const b = fn('GET', 'src/api/cli/divisions/route.ts', 12);
  const edges = [h1, h2, h3].flatMap((h) => [calls(a, h), calls(b, h)]);
  return build([h1, h2, h3, a, b], edges);
}

describe('duplicatePairsQuery — structural duplicate detection', () => {
  it('flags two functions with identical callee sets + names at score 1.0', () => {
    const g = indexGraph(copyPasteGraph());
    const pairs = duplicatePairsQuery(g);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBeCloseTo(1.0, 5);
    expect(pairs[0].calleeJaccard).toBeCloseTo(1.0, 5);
    const files = [pairs[0].a.sourceFile, pairs[0].b.sourceFile].sort();
    expect(files).toEqual(['src/api/cli/divisions/route.ts', 'src/api/divisions/route.ts']);
  });

  it('excludes functions below the MIN_CALLEES structural floor', () => {
    // Same names, but each calls only 2 helpers (< DUP_MIN_CALLEES=3) → no signal.
    expect(DUP_MIN_CALLEES).toBe(3);
    const h1 = helper('src/lib/db.ts', 'query');
    const h2 = helper('src/lib/http.ts', 'respond');
    const a = fn('GET', 'src/api/a/route.ts');
    const b = fn('GET', 'src/api/b/route.ts');
    const g = indexGraph(
      build(
        [h1, h2, a, b],
        [h1, h2].flatMap((h) => [calls(a, h), calls(b, h)]),
      ),
    );
    expect(duplicatePairsQuery(g)).toHaveLength(0);
  });

  it('does not flag two functions that call DIFFERENT helpers (semantic re-derivation is out of scope)', () => {
    const ha = ['a1', 'a2', 'a3'].map((n) => helper('src/lib/a.ts', n));
    const hb = ['b1', 'b2', 'b3'].map((n) => helper('src/lib/b.ts', n));
    const a = fn('doThing', 'src/x.ts');
    const b = fn('doThing', 'src/y.ts');
    const edges = [...ha.map((h) => calls(a, h)), ...hb.map((h) => calls(b, h))];
    const g = indexGraph(build([...ha, ...hb, a, b], edges));
    // Zero callee overlap → never scored (inverted index only pairs shared callees).
    expect(duplicatePairsQuery(g)).toHaveLength(0);
  });

  it('excludes test files from both sides by default', () => {
    const h = ['h1', 'h2', 'h3'].map((n) => helper('src/lib.ts', n));
    const a = fn('setup', 'src/api/route.ts');
    const b = fn('setup', 'test/api/route.test.ts');
    const edges = h.flatMap((x) => [calls(a, x), calls(b, x)]);
    const g = indexGraph(build([...h, a, b], edges));
    // Default excludeTests → the test-file side is dropped, so no pair remains.
    expect(duplicatePairsQuery(g)).toHaveLength(0);
    // Opt back in → the pair appears.
    expect(duplicatePairsQuery(g, { excludeTests: false })).toHaveLength(1);
  });

  it('diff-scopes to pairs touching a focus file', () => {
    const g = copyPasteGraph();
    const graph = indexGraph(g);
    // Focus on a file NEITHER side touches → dropped.
    expect(duplicatePairsQuery(graph, { focusFiles: new Set(['src/unrelated.ts']) })).toHaveLength(
      0,
    );
    // Focus on one side's file → kept.
    expect(
      duplicatePairsQuery(graph, { focusFiles: new Set(['src/api/cli/divisions/route.ts']) }),
    ).toHaveLength(1);
  });

  it('honors the minScore threshold', () => {
    // Partial overlap: share 2 of 3 callees, different names → score < 1.0.
    const shared = ['s1', 's2'].map((n) => helper('src/lib.ts', n));
    const onlyA = helper('src/lib.ts', 'a-only');
    const onlyB = helper('src/lib.ts', 'b-only');
    const a = fn('alpha', 'src/a.ts');
    const b = fn('beta', 'src/b.ts');
    const edges = [
      ...shared.flatMap((h) => [calls(a, h), calls(b, h)]),
      calls(a, onlyA),
      calls(b, onlyB),
    ];
    const g = indexGraph(build([...shared, onlyA, onlyB, a, b], edges));
    const all = duplicatePairsQuery(g, { minScore: 0 });
    expect(all).toHaveLength(1);
    // callee-Jaccard = 2/4 = 0.5; name-Jaccard = 0 → score = 0.6*0.5 = 0.3.
    expect(all[0].score).toBeCloseTo(0.3, 5);
    // Default threshold (0.5) drops it.
    expect(DUP_DEFAULT_MIN_SCORE).toBe(0.5);
    expect(duplicatePairsQuery(g)).toHaveLength(0);
  });
});
