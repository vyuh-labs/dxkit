/**
 * Tests for fileLineContextQuery — the structural half of
 * `vyuh-dxkit context <file:line>`. Pure tests against synthetic Graph
 * fixtures: enclosing-symbol resolution, span bounds, callers/callees,
 * and the not-in-graph fallback.
 */

import { describe, expect, it } from 'vitest';
import { fileLineContextQuery } from '../../src/explore/queries';
import type { Community, Graph, GraphEdge, GraphJson, GraphNode } from '../../src/explore/types';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[], communities: Community[]): Graph {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

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

  const communityById = new Map<number, Community>();
  const communityByNode = new Map<string, Community>();
  for (const c of communities) {
    communityById.set(c.id, c);
    for (const nid of c.nodeIds) communityByNode.set(nid, c);
  }

  const json: GraphJson = {
    schemaVersion: 1,
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '2.8.0',
      generatedAt: '2026-06-02T00:00:00Z',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges,
    communities,
    symbolIndex: {},
  };

  return {
    ...json,
    nodeById,
    edgesFromNode,
    edgesToNode,
    nodesByFile,
    communityById,
    communityByNode,
  };
}

// Fixture:
//   src/a.ts: module n0; alpha() @10; beta() @50
//   src/b.ts: module n2; caller() @5 (calls alpha)
//   alpha() calls helper() in src/a.ts? — keep simple: alpha calls beta.
const NODES: GraphNode[] = [
  { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
  { id: 'a', kind: 'function', label: 'alpha()', sourceFile: 'src/a.ts', line: 10 },
  { id: 'b', kind: 'function', label: 'beta()', sourceFile: 'src/a.ts', line: 50 },
  { id: 'n2', kind: 'module', label: 'src/b.ts', sourceFile: 'src/b.ts' },
  { id: 'c', kind: 'function', label: 'caller()', sourceFile: 'src/b.ts', line: 5 },
];
const EDGES: GraphEdge[] = [
  { from: 'c', to: 'a', relation: 'calls' }, // caller → alpha
  { from: 'a', to: 'b', relation: 'calls' }, // alpha → beta
];
const COMMUNITIES: Community[] = [
  {
    id: 0,
    nodeIds: ['n0', 'a', 'b'],
    cohesion: 0.9,
    dominantSourceDir: 'src',
    dominantPack: 'typescript',
  },
];

const GRAPH = makeGraph(NODES, EDGES, COMMUNITIES);

describe('fileLineContextQuery', () => {
  it('resolves the enclosing symbol to the nearest declaration at-or-above the line', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 25);
    expect(ctx.found).toBe(true);
    expect(ctx.enclosingSymbol?.symbol).toBe('alpha');
    expect(ctx.enclosingSymbol?.line).toBe(10);
  });

  it('bounds the span by the next declaration (exclusive)', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 25);
    expect(ctx.span).toEqual({ startLine: 10, endLineExclusive: 50 });
  });

  it('leaves endLineExclusive undefined for the last symbol in the file', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 60);
    expect(ctx.enclosingSymbol?.symbol).toBe('beta');
    expect(ctx.span?.startLine).toBe(50);
    expect(ctx.span?.endLineExclusive).toBeUndefined();
  });

  it('surfaces callers and callees of the enclosing symbol', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 25);
    expect(ctx.enclosingSymbol?.callsIn).toBe(1);
    expect(ctx.enclosingSymbol?.callsOut).toBe(1);
    expect(ctx.callers.map((c) => c.symbol)).toContain('caller');
    expect(ctx.callees.map((c) => c.symbol)).toContain('beta');
  });

  it('reports file-level blast radius + community', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 25);
    expect(ctx.blastRadius.callerFiles).toBe(1); // src/b.ts
    expect(ctx.community?.role).toBe('src');
  });

  it('returns no enclosing symbol when the line is above the first declaration', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/a.ts', 3);
    expect(ctx.found).toBe(true);
    expect(ctx.enclosingSymbol).toBeUndefined();
    expect(ctx.span).toBeUndefined();
    expect(ctx.callers).toEqual([]);
  });

  it('returns found:false for a file absent from the graph', () => {
    const ctx = fileLineContextQuery(GRAPH, 'src/missing.ts', 5);
    expect(ctx.found).toBe(false);
    expect(ctx.enclosingSymbol).toBeUndefined();
    expect(ctx.blastRadius).toEqual({ callerFiles: 0, callers: 0 });
  });
});
