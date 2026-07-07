/**
 * Graph-derived affected-test selection (#32). Pins the reverse-reachability
 * core: a test is affected when there's a CALL path from it to a changed symbol
 * (it's a transitive caller), transitively, and only then — the property that
 * makes this beat import-graph selection. Also pins the safety surface the CLI
 * fails safe on: changed test files are always selected; a changed file with no
 * graph symbol is reported as `untraceable`.
 */
import { describe, expect, it } from 'vitest';
import { affectedTestsQuery } from '../../src/explore/queries';
import type { Graph, GraphEdge, GraphNode } from '../../src/explore/types';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgesFromNode = new Map<string, GraphEdge[]>();
  const edgesToNode = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (edgesFromNode.get(e.from) ?? edgesFromNode.set(e.from, []).get(e.from)!).push(e);
    (edgesToNode.get(e.to) ?? edgesToNode.set(e.to, []).get(e.to)!).push(e);
  }
  const nodesByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    (nodesByFile.get(n.sourceFile) ?? nodesByFile.set(n.sourceFile, []).get(n.sourceFile)!).push(n);
  }
  return {
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '3.0.0',
      generatedAt: '2026-07-06T00:00:00Z',
      sourceFilesInGraph: nodesByFile.size,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    schemaVersion: 1,
    nodes,
    edges,
    communities: [],
    symbolIndex: {},
    endpoints: [],
    nodeById,
    edgesFromNode,
    edgesToNode,
    nodesByFile,
    communityById: new Map(),
    communityByNode: new Map(),
    endpointById: new Map(),
    endpointByKey: new Map(),
  } as unknown as Graph;
}

// A (src/a.ts) calls U (src/util.ts); tA (src/a.test.ts) calls A.
// B (src/b.ts); tB (src/b.test.ts) calls B — an unrelated island.
const NODES: GraphNode[] = [
  { id: 'A', kind: 'function', label: 'A', sourceFile: 'src/a.ts', line: 2 },
  { id: 'U', kind: 'function', label: 'U', sourceFile: 'src/util.ts', line: 1 },
  { id: 'tA', kind: 'function', label: 'testA', sourceFile: 'src/a.test.ts', line: 3 },
  { id: 'B', kind: 'function', label: 'B', sourceFile: 'src/b.ts', line: 2 },
  { id: 'tB', kind: 'function', label: 'testB', sourceFile: 'src/b.test.ts', line: 3 },
] as unknown as GraphNode[];
const EDGES: GraphEdge[] = [
  { from: 'tA', to: 'A', relation: 'calls' },
  { from: 'A', to: 'U', relation: 'calls' },
  { from: 'tB', to: 'B', relation: 'calls' },
] as unknown as GraphEdge[];
const graph = makeGraph(NODES, EDGES);

describe('affectedTestsQuery — reverse reachability', () => {
  it('selects the test that directly reaches the changed symbol', () => {
    const r = affectedTestsQuery(graph, ['src/a.ts']);
    expect(r.testFiles).toEqual(['src/a.test.ts']);
    expect(r.testFiles).not.toContain('src/b.test.ts');
  });

  it('selects transitively — a change to a leaf util reaches the test through its caller', () => {
    const r = affectedTestsQuery(graph, ['src/util.ts']);
    // tA -> A -> U, so changing U affects a.test.ts (not b.test.ts).
    expect(r.testFiles).toEqual(['src/a.test.ts']);
  });

  it('does NOT select an unrelated test (no call path to the change)', () => {
    const r = affectedTestsQuery(graph, ['src/a.ts']);
    expect(r.testFiles).not.toContain('src/b.test.ts');
  });

  it('always selects a CHANGED test file directly', () => {
    const r = affectedTestsQuery(graph, ['src/b.test.ts']);
    expect(r.testFiles).toContain('src/b.test.ts');
    expect(r.untraceable).toEqual([]);
  });

  it('reports a changed non-test file with no graph symbol as untraceable', () => {
    const r = affectedTestsQuery(graph, ['config/settings.json']);
    expect(r.untraceable).toEqual(['config/settings.json']);
    expect(r.testFiles).toEqual([]);
  });

  it('a changed source file WITH symbols is not untraceable', () => {
    const r = affectedTestsQuery(graph, ['src/a.ts']);
    expect(r.untraceable).toEqual([]);
    expect(r.changedSymbols).toBe(1);
  });
});
