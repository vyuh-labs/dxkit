/**
 * Tests for src/explore/queries.ts — graph query primitives.
 *
 * Sprint 1 ships three primitives consumed by both the explore CLI
 * (Sprint 2) and the dashboard viz adapter (Sprint 3):
 *   - callersOf(graph, nodeId) — predecessors via 'calls' edges
 *   - calleesOf(graph, nodeId) — successors via 'calls' edges
 *   - nodesInFile(graph, sourceFile) — all symbols declared in a file
 *
 * Pure tests against a synthetic Graph fixture built inline (no
 * loadGraph, no disk).
 */

import { describe, expect, it } from 'vitest';
import { callersOf, calleesOf, nodesInFile } from '../../src/explore/queries';
import type {
  Community,
  Graph,
  GraphEdge,
  GraphJson,
  GraphNode,
  SymbolIndex,
} from '../../src/explore/types';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const edgesFromNode = new Map<string, GraphEdge[]>();
  const edgesToNode = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const fromList = edgesFromNode.get(e.from) ?? [];
    fromList.push(e);
    edgesFromNode.set(e.from, fromList);
    const toList = edgesToNode.get(e.to) ?? [];
    toList.push(e);
    edgesToNode.set(e.to, toList);
  }

  const nodesByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = nodesByFile.get(n.sourceFile) ?? [];
    list.push(n);
    nodesByFile.set(n.sourceFile, list);
  }

  const communityById = new Map<number, Community>();
  const communityByNode = new Map<string, Community>();

  const json: GraphJson = {
    schemaVersion: 1,
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '2.7.0',
      generatedAt: '2026-05-27T00:00:00Z',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges,
    communities: [],
    symbolIndex: {} as SymbolIndex,
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

// Six-node, four-call-edge fixture:
//   src/a.ts: n0 module, n1 function (main)
//   src/b.ts: n2 module, n3 function (helper)
//   src/c.ts: n4 module, n5 function (logger)
// Calls: main -> helper, main -> logger, helper -> logger.
// Plus one imports_from + one method edge to confirm filter behavior.
const NODES: GraphNode[] = [
  { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
  { id: 'n1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 5 },
  { id: 'n2', kind: 'module', label: 'src/b.ts', sourceFile: 'src/b.ts' },
  { id: 'n3', kind: 'function', label: 'helper()', sourceFile: 'src/b.ts', line: 3 },
  { id: 'n4', kind: 'module', label: 'src/c.ts', sourceFile: 'src/c.ts' },
  { id: 'n5', kind: 'function', label: 'logger()', sourceFile: 'src/c.ts', line: 1 },
];

const EDGES: GraphEdge[] = [
  { from: 'n0', to: 'n1', relation: 'method' }, // module owns function
  { from: 'n2', to: 'n3', relation: 'method' },
  { from: 'n4', to: 'n5', relation: 'method' },
  { from: 'n1', to: 'n3', relation: 'calls' }, // main -> helper
  { from: 'n1', to: 'n5', relation: 'calls' }, // main -> logger
  { from: 'n3', to: 'n5', relation: 'calls' }, // helper -> logger
  { from: 'n0', to: 'n2', relation: 'imports_from' }, // a imports b
];

const G = makeGraph(NODES, EDGES);

describe('callersOf', () => {
  it('returns nodes calling INTO the target via calls edges', () => {
    const callers = callersOf(G, 'n5');
    const labels = callers.map((n) => n.label).sort();
    expect(labels).toEqual(['helper()', 'main()']);
  });

  it('returns empty array when no callers', () => {
    expect(callersOf(G, 'n1')).toEqual([]);
  });

  it('returns empty array for unknown node id', () => {
    expect(callersOf(G, 'missing')).toEqual([]);
  });

  it('filters out method + imports_from edges', () => {
    // n1 has no callers via 'calls'; it's owned by n0 via 'method'.
    // The method edge must NOT show n0 as a "caller" of n1.
    expect(callersOf(G, 'n1')).toEqual([]);
  });
});

describe('calleesOf', () => {
  it('returns nodes called FROM the source via calls edges', () => {
    const callees = calleesOf(G, 'n1');
    const labels = callees.map((n) => n.label).sort();
    expect(labels).toEqual(['helper()', 'logger()']);
  });

  it('returns empty array when no callees', () => {
    expect(calleesOf(G, 'n5')).toEqual([]);
  });

  it('returns empty array for unknown node id', () => {
    expect(calleesOf(G, 'missing')).toEqual([]);
  });

  it('filters out method + imports_from edges', () => {
    // n0 has an outbound method edge to n1 + imports_from to n2.
    // Neither counts as a callee.
    expect(calleesOf(G, 'n0')).toEqual([]);
  });
});

describe('nodesInFile', () => {
  it('returns all nodes declared in the source file', () => {
    const inA = nodesInFile(G, 'src/a.ts');
    const labels = inA.map((n) => n.label).sort();
    expect(labels).toEqual(['main()', 'src/a.ts']);
  });

  it('returns empty array for a file not in the graph', () => {
    expect(nodesInFile(G, 'src/nonexistent.ts')).toEqual([]);
  });

  it('returns a fresh array (mutation does not affect the graph)', () => {
    const result = nodesInFile(G, 'src/a.ts');
    result.pop();
    // Subsequent query returns the original two entries.
    expect(nodesInFile(G, 'src/a.ts')).toHaveLength(2);
  });
});
