/**
 * Tests for src/dashboard/graph-adapter.ts — the pure-function
 * Graph → cytoscape ElementsDefinition adapter consumed by the
 * dashboard graph viz (Part B of Sprint 3).
 *
 * Strategy: synthesize small `Graph` fixtures inline, call each
 * tier adapter, assert the shape of the returned elements. Pure
 * tests — no DOM, no cytoscape runtime, no I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptToTier1,
  adaptToTier2,
  adaptToTier3,
  type CytoscapeElements,
} from '../../src/dashboard/graph-adapter';
import type {
  Community,
  Graph,
  GraphEdge,
  GraphJson,
  GraphNode,
  SymbolIndex,
} from '../../src/explore/types';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[], communities: Community[] = []): Graph {
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
  for (const c of communities) {
    communityById.set(c.id, c);
    for (const nid of c.nodeIds) communityByNode.set(nid, c);
  }

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
    communities,
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

// ─── Tier 1 fixtures ─────────────────────────────────────────────────────────

// Two communities — one big (4 members), one small (2 members) —
// plus one inter-community 'calls' edge from comm-1 to comm-2.
function makeTier1Fixture(): Graph {
  const nodes: GraphNode[] = [
    // comm-1: src/big/ — 4 nodes, dominantPack: typescript
    { id: 'b0', kind: 'module', label: 'src/big/a.ts', sourceFile: 'src/big/a.ts' },
    { id: 'b1', kind: 'function', label: 'fa()', sourceFile: 'src/big/a.ts', line: 1 },
    { id: 'b2', kind: 'module', label: 'src/big/b.ts', sourceFile: 'src/big/b.ts' },
    { id: 'b3', kind: 'function', label: 'fb()', sourceFile: 'src/big/b.ts', line: 1 },
    // comm-2: src/small/ — 2 nodes, dominantPack: python
    { id: 's0', kind: 'module', label: 'src/small/x.py', sourceFile: 'src/small/x.py' },
    { id: 's1', kind: 'function', label: 'xa()', sourceFile: 'src/small/x.py', line: 1 },
  ];
  const edges: GraphEdge[] = [
    { from: 'b0', to: 'b1', relation: 'method' },
    { from: 'b2', to: 'b3', relation: 'method' },
    { from: 's0', to: 's1', relation: 'method' },
    { from: 'b1', to: 'b3', relation: 'calls', occurrences: 2 }, // intra comm-1
    { from: 'b1', to: 's1', relation: 'calls', occurrences: 5 }, // inter (big → small)
    { from: 'b0', to: 's0', relation: 'imports_from' }, // inter (big → small)
  ];
  const communities: Community[] = [
    {
      id: 1,
      nodeIds: ['b0', 'b1', 'b2', 'b3'],
      cohesion: 0.85,
      dominantSourceDir: 'src/big/',
      dominantPack: 'typescript',
    },
    {
      id: 2,
      nodeIds: ['s0', 's1'],
      cohesion: 0.7,
      dominantSourceDir: 'src/small/',
      dominantPack: 'python',
    },
  ];
  return makeGraph(nodes, edges, communities);
}

describe('adaptToTier1', () => {
  it('produces one node per community, ranked by member count', () => {
    const els = adaptToTier1(makeTier1Fixture());
    expect(els.nodes).toHaveLength(2);
    expect(els.nodes.every((n) => n.data.tier === 1)).toBe(true);
    // Bigger community renders first (rank-by-size).
    expect(els.nodes[0].data.label).toBe('src/big/');
    expect(els.nodes[1].data.label).toBe('src/small/');
  });

  it('sizes nodes by sqrt of member count', () => {
    const els = adaptToTier1(makeTier1Fixture());
    // big=4, small=2; max=4. big=sqrt(4/4)=1.0, small=sqrt(2/4)≈0.707.
    expect(els.nodes[0].data.size).toBeCloseTo(1, 5);
    expect(els.nodes[1].data.size).toBeCloseTo(Math.sqrt(0.5), 5);
  });

  it('colors nodes by dominant pack', () => {
    const els = adaptToTier1(makeTier1Fixture());
    expect(els.nodes[0].data.colorGroup).toBe('typescript');
    expect(els.nodes[1].data.colorGroup).toBe('python');
  });

  it('surfaces meta with cohesion + dominant pack + top hot files', () => {
    const els = adaptToTier1(makeTier1Fixture());
    const big = els.nodes[0].data;
    expect(big.meta?.nodeCount).toBe(4);
    expect(big.meta?.cohesion).toBe(0.85);
    expect(big.meta?.dominantPack).toBe('typescript');
  });

  it('synthesizes inter-community edges, ignoring intra-community + method edges', () => {
    const els = adaptToTier1(makeTier1Fixture());
    // Two inter-community edges (calls + imports_from) collapse to ONE
    // bidirectional pair record in the synthesized output.
    expect(els.edges).toHaveLength(1);
    const e = els.edges[0];
    expect(e.data.relation).toBe('community');
    expect(e.data.occurrences).toBe(2); // 1 calls + 1 imports_from
    // Source/target IDs use the 'c1:' prefix from communityId helper.
    expect([e.data.source, e.data.target].sort()).toEqual(['c1:1', 'c1:2']);
  });

  it('falls back to community-N label when dominantSourceDir is empty', () => {
    const nodes: GraphNode[] = [
      { id: 'n0', kind: 'module', label: 'x.ts', sourceFile: 'x.ts' },
      { id: 'n1', kind: 'function', label: 'fn()', sourceFile: 'x.ts', line: 1 },
    ];
    const communities: Community[] = [
      {
        id: 7,
        nodeIds: ['n0', 'n1'],
        cohesion: 0.5,
        dominantSourceDir: '',
        dominantPack: '',
      },
    ];
    const els = adaptToTier1(makeGraph(nodes, [], communities));
    expect(els.nodes[0].data.label).toBe('community-7');
    expect(els.nodes[0].data.colorGroup).toBe('multi');
  });

  it('respects the limit option', () => {
    const els = adaptToTier1(makeTier1Fixture(), { limit: 1 });
    expect(els.nodes).toHaveLength(1);
    expect(els.nodes[0].data.label).toBe('src/big/');
    // With only one community kept, the inter-community edge drops
    // (the other endpoint isn't in the rendered set).
    expect(els.edges).toHaveLength(0);
  });

  it('returns empty elements for an empty graph', () => {
    const els = adaptToTier1(makeGraph([], [], []));
    expect(els).toEqual({ nodes: [], edges: [] });
  });
});

// ─── Tier 2 fixtures ─────────────────────────────────────────────────────────

describe('adaptToTier2', () => {
  it('returns empty elements when the community id is unknown', () => {
    const els = adaptToTier2(makeTier1Fixture(), 999);
    expect(els).toEqual({ nodes: [], edges: [] });
  });

  it('produces one node per file in the community', () => {
    const els = adaptToTier2(makeTier1Fixture(), 1);
    expect(els.nodes.map((n) => n.data.label).sort()).toEqual(['a.ts', 'b.ts']);
    expect(els.nodes.every((n) => n.data.tier === 2)).toBe(true);
    expect(els.nodes.every((n) => n.data.communityId === 1)).toBe(true);
  });

  it('encodes full path in meta + label as basename', () => {
    const els = adaptToTier2(makeTier1Fixture(), 1);
    const aNode = els.nodes.find((n) => n.data.label === 'a.ts');
    expect(aNode?.data.sourceFile).toBe('src/big/a.ts');
    expect(aNode?.data.meta?.path).toBe('src/big/a.ts');
  });

  it('aggregates intra-community calls to a single file-level edge', () => {
    // The fixture's only intra-community 'calls' edge is b1 → b3
    // (src/big/a.ts → src/big/b.ts, occurrences: 2). Tier 2 should
    // collapse that into one edge with occurrences=2.
    const els = adaptToTier2(makeTier1Fixture(), 1);
    expect(els.edges).toHaveLength(1);
    const e = els.edges[0];
    expect(e.data.relation).toBe('calls');
    expect(e.data.occurrences).toBe(2);
    expect(e.data.source).toBe('f2:src/big/a.ts');
    expect(e.data.target).toBe('f2:src/big/b.ts');
  });

  it('drops cross-community edges from Tier 2 output', () => {
    // The fixture has TWO cross-community edges (b1 → s1 calls + b0
    // → s0 imports_from). Neither should appear in the comm-1 view
    // because s* nodes aren't members.
    const els = adaptToTier2(makeTier1Fixture(), 1);
    // Only the b1 → b3 intra-community edge survives.
    expect(els.edges).toHaveLength(1);
    expect(els.edges[0].data.target).toBe('f2:src/big/b.ts');
  });

  it('color groups files by language pack derived from extension', () => {
    const els = adaptToTier2(makeTier1Fixture(), 2);
    expect(els.nodes).toHaveLength(1);
    expect(els.nodes[0].data.colorGroup).toBe('python');
  });

  it('sizes files by call in-degree using callersOf', () => {
    // In comm-1: b3 has one inbound call (b1 → b3); b1 has zero.
    // So src/big/b.ts has callsIn=1, src/big/a.ts has callsIn=0.
    const els = adaptToTier2(makeTier1Fixture(), 1);
    const bFile = els.nodes.find((n) => n.data.label === 'b.ts');
    const aFile = els.nodes.find((n) => n.data.label === 'a.ts');
    expect(bFile?.data.meta?.callsIn).toBe(1);
    expect(aFile?.data.meta?.callsIn).toBe(0);
    // b is the max; renders at size 1.0; a renders at 0.
    expect(bFile?.data.size).toBeCloseTo(1, 5);
    expect(aFile?.data.size).toBe(0);
  });
});

// ─── Tier 3 fixtures ─────────────────────────────────────────────────────────

// Three symbols in one file plus one symbol in another file. Intra-
// file edges: main → helper, main → logger; external edge: helper →
// outside (in src/other.ts).
function makeTier3Fixture(): Graph {
  const nodes: GraphNode[] = [
    { id: 'm0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
    { id: 'm1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 5 },
    { id: 'm2', kind: 'function', label: 'helper()', sourceFile: 'src/a.ts', line: 10 },
    { id: 'm3', kind: 'class', label: 'Logger', sourceFile: 'src/a.ts', line: 20, exported: true },
    { id: 'o0', kind: 'module', label: 'src/other.ts', sourceFile: 'src/other.ts' },
    {
      id: 'o1',
      kind: 'function',
      label: 'outside()',
      sourceFile: 'src/other.ts',
      line: 1,
    },
  ];
  const edges: GraphEdge[] = [
    { from: 'm0', to: 'm1', relation: 'method' },
    { from: 'm0', to: 'm2', relation: 'method' },
    { from: 'm0', to: 'm3', relation: 'method' },
    { from: 'm1', to: 'm2', relation: 'calls', occurrences: 3 }, // intra
    { from: 'm1', to: 'm3', relation: 'calls', occurrences: 1 }, // intra
    { from: 'm2', to: 'o1', relation: 'calls', occurrences: 2 }, // external
  ];
  return makeGraph(nodes, edges);
}

describe('adaptToTier3', () => {
  it('produces one node per non-module symbol in the file', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const symbolNodes = els.nodes.filter((n) => n.data.colorGroup !== 'external');
    expect(symbolNodes.map((n) => n.data.label).sort()).toEqual(['Logger', 'helper', 'main']);
    expect(symbolNodes.every((n) => n.data.tier === 3)).toBe(true);
  });

  it('color groups symbols by kind', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const symbolNodes = els.nodes.filter((n) => n.data.colorGroup !== 'external');
    const byLabel = new Map(symbolNodes.map((n) => [n.data.label, n.data.colorGroup]));
    expect(byLabel.get('main')).toBe('function');
    expect(byLabel.get('helper')).toBe('function');
    expect(byLabel.get('Logger')).toBe('class');
  });

  it('renders intra-file calls as real edges between symbol nodes', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const intra = els.edges.filter((e) => !e.data.externalTargetFile);
    expect(intra).toHaveLength(2);
    const targets = intra.map((e) => e.data.target).sort();
    expect(targets).toEqual(['s3:m2', 's3:m3']);
    const totalOccurrences = intra.reduce((sum, e) => sum + (e.data.occurrences ?? 0), 0);
    expect(totalOccurrences).toBe(4); // 3 + 1
  });

  it('renders external calls as virtual-node edges with externalTargetFile set', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const external = els.edges.filter((e) => e.data.externalTargetFile);
    expect(external).toHaveLength(1);
    expect(external[0].data.externalTargetFile).toBe('src/other.ts');
    expect(external[0].data.occurrences).toBe(2);
    expect(external[0].data.source).toBe('s3:m2');
    expect(external[0].data.target).toBe('ext3:src/other.ts');
  });

  it('creates a virtual external node for each distinct external target file', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const externalNodes = els.nodes.filter((n) => n.data.colorGroup === 'external');
    expect(externalNodes).toHaveLength(1);
    expect(externalNodes[0].data.label).toBe('other.ts');
    expect(externalNodes[0].data.meta?.external).toBe(true);
  });

  it('sizes symbols by call in-degree', () => {
    // helper has 1 inbound call (from main); Logger has 1 (from main); main has 0.
    // Max=1 so helper + Logger render at 1.0, main at 0.
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const byLabel = new Map(
      els.nodes
        .filter((n) => n.data.colorGroup !== 'external')
        .map((n) => [n.data.label, n.data.size]),
    );
    expect(byLabel.get('main')).toBe(0);
    expect(byLabel.get('helper')).toBeCloseTo(1, 5);
    expect(byLabel.get('Logger')).toBeCloseTo(1, 5);
  });

  it('exposes line + kind + exported in meta for tooltips', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/a.ts');
    const logger = els.nodes.find((n) => n.data.label === 'Logger');
    expect(logger?.data.line).toBe(20);
    expect(logger?.data.meta?.kind).toBe('class');
    expect(logger?.data.meta?.exported).toBe(true);
    const main = els.nodes.find((n) => n.data.label === 'main');
    expect(main?.data.meta?.exported).toBe('unknown');
  });

  it('returns empty elements when the file has no graph nodes', () => {
    const els = adaptToTier3(makeTier3Fixture(), 'src/missing.ts');
    expect(els).toEqual({ nodes: [], edges: [] });
  });

  it('returns no edges when the file contains only a module node', () => {
    const nodes: GraphNode[] = [
      { id: 'mod', kind: 'module', label: 'src/empty.ts', sourceFile: 'src/empty.ts' },
    ];
    const els = adaptToTier3(makeGraph(nodes, []), 'src/empty.ts');
    expect(els.nodes).toHaveLength(0); // module nodes are filtered
    expect(els.edges).toHaveLength(0);
  });
});

// ─── Cross-tier invariants ───────────────────────────────────────────────────

describe('adapter shape invariants', () => {
  function allElements(graph: Graph): CytoscapeElements[] {
    return [
      adaptToTier1(graph),
      adaptToTier2(graph, 1),
      adaptToTier2(graph, 2),
      adaptToTier3(graph, 'src/big/a.ts'),
    ];
  }

  it('every node has group="nodes" and a non-empty id', () => {
    for (const els of allElements(makeTier1Fixture())) {
      for (const n of els.nodes) {
        expect(n.group).toBe('nodes');
        expect(n.data.id).toBeTruthy();
      }
    }
  });

  it('every edge has group="edges" and a non-empty id + source + target', () => {
    for (const els of allElements(makeTier1Fixture())) {
      for (const e of els.edges) {
        expect(e.group).toBe('edges');
        expect(e.data.id).toBeTruthy();
        expect(e.data.source).toBeTruthy();
        expect(e.data.target).toBeTruthy();
      }
    }
  });

  it('all node sizes and edge weights fall in [0, 1]', () => {
    for (const els of allElements(makeTier1Fixture())) {
      for (const n of els.nodes) {
        expect(n.data.size).toBeGreaterThanOrEqual(0);
        expect(n.data.size).toBeLessThanOrEqual(1);
      }
      for (const e of els.edges) {
        expect(e.data.weight).toBeGreaterThanOrEqual(0);
        expect(e.data.weight).toBeLessThanOrEqual(1);
      }
    }
  });
});
