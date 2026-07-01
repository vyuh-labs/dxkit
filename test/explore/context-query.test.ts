/**
 * Tests for contextQuery — the token-budgeted subgraph primitive that
 * powers `vyuh-dxkit context <query>` + the PreToolUse hook (Sprint 3.5).
 *
 * Pure tests against synthetic Graph fixtures (with a populated
 * symbolIndex, since contextQuery resolves seeds through it). No
 * formatting, no I/O — this file exercises the graph work + budget math.
 */

import { describe, expect, it } from 'vitest';
import { contextQuery } from '../../src/explore/queries';
import type {
  Community,
  Graph,
  GraphEdge,
  GraphJson,
  GraphNode,
  SymbolIndex,
} from '../../src/explore/types';

function makeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: Community[],
  symbolIndex: SymbolIndex,
): Graph {
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
      dxkitVersion: '2.7.0',
      generatedAt: '2026-05-28T00:00:00Z',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges,
    communities,
    symbolIndex,
    endpoints: [],
  };

  return {
    ...json,
    nodeById,
    edgesFromNode,
    edgesToNode,
    nodesByFile,
    communityById,
    communityByNode,
    endpointById: new Map(),
    endpointByKey: new Map(),
  };
}

// Fixture: main() calls helper() + logger(); helper() calls logger().
//   src/a.ts: n0 module, n1 main()
//   src/b.ts: n2 module, n3 helper()
//   src/c.ts: n4 module, n5 logger()
// Communities: comm 0 = src/ (n0,n1,n2,n3); comm 1 = src/c.ts (n4,n5).
const NODES: GraphNode[] = [
  { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
  { id: 'n1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 5 },
  { id: 'n2', kind: 'module', label: 'src/b.ts', sourceFile: 'src/b.ts' },
  { id: 'n3', kind: 'function', label: 'helper()', sourceFile: 'src/b.ts', line: 3 },
  { id: 'n4', kind: 'module', label: 'src/c.ts', sourceFile: 'src/c.ts' },
  { id: 'n5', kind: 'function', label: 'logger()', sourceFile: 'src/c.ts', line: 1 },
];
const EDGES: GraphEdge[] = [
  { from: 'n0', to: 'n1', relation: 'method' },
  { from: 'n2', to: 'n3', relation: 'method' },
  { from: 'n4', to: 'n5', relation: 'method' },
  { from: 'n1', to: 'n3', relation: 'calls' },
  { from: 'n1', to: 'n5', relation: 'calls' },
  { from: 'n3', to: 'n5', relation: 'calls' },
];
const COMMUNITIES: Community[] = [
  {
    id: 0,
    nodeIds: ['n0', 'n1', 'n2', 'n3'],
    cohesion: 0.8,
    dominantSourceDir: 'src/',
    dominantPack: 'typescript',
  },
  {
    id: 1,
    nodeIds: ['n4', 'n5'],
    cohesion: 0.6,
    dominantSourceDir: 'src/c.ts',
    dominantPack: 'typescript',
  },
];
const INDEX: SymbolIndex = { main: ['n1'], helper: ['n3'], logger: ['n5'] };

const G = makeGraph(NODES, EDGES, COMMUNITIES, INDEX);

describe('contextQuery — no match', () => {
  it('returns matched=false + did-you-mean suggestions for an unknown keyword', () => {
    const r = contextQuery(G, 'mian'); // typo for "main"
    expect(r.matched).toBe(false);
    expect(r.selection).toHaveLength(0);
    expect(r.suggestions.map((s) => s.key)).toContain('main');
  });

  it('returns an empty result for a blank keyword', () => {
    const r = contextQuery(G, '   ');
    expect(r.matched).toBe(false);
    expect(r.suggestions).toHaveLength(0);
    expect(r.selection).toHaveLength(0);
  });
});

describe('contextQuery — selection + BFS', () => {
  it('places the seed at hop 0', () => {
    const r = contextQuery(G, 'main');
    expect(r.matched).toBe(true);
    const seed = r.selection.find((s) => s.symbol === 'main');
    expect(seed?.hop).toBe(0);
  });

  it('expands to direct neighbors at hop 1 (callees + callers)', () => {
    const r = contextQuery(G, 'main');
    const byLabel = new Map(r.selection.map((s) => [s.symbol, s.hop]));
    // main calls helper + logger → both hop 1.
    expect(byLabel.get('helper')).toBe(1);
    expect(byLabel.get('logger')).toBe(1);
  });

  it('includes callers as well as callees in the expansion', () => {
    // Query logger(): its callers are main + helper. Both should appear.
    const r = contextQuery(G, 'logger');
    const labels = r.selection.map((s) => s.symbol).sort();
    expect(labels).toContain('main');
    expect(labels).toContain('helper');
  });

  it('excludes module nodes from the selection', () => {
    const r = contextQuery(G, 'main');
    expect(r.selection.every((s) => s.kind !== 'module')).toBe(true);
  });

  it('records callsIn / callsOut per selected symbol', () => {
    const r = contextQuery(G, 'logger');
    const logger = r.selection.find((s) => s.symbol === 'logger');
    // logger is called by main + helper (2 in), calls nothing (0 out).
    expect(logger?.callsIn).toBe(2);
    expect(logger?.callsOut).toBe(0);
  });
});

describe('contextQuery — budget', () => {
  it('truncates when the budget is too small to hold the neighborhood', () => {
    // tokensPerNode=15, budget=15 → room for exactly one node.
    const r = contextQuery(G, 'main', { budget: 15, tokensPerNode: 15 });
    expect(r.selection).toHaveLength(1);
    expect(r.selection[0].symbol).toBe('main'); // seed survives
    expect(r.truncated).toBe(true);
    expect(r.omittedCount).toBeGreaterThan(0);
  });

  it('does not truncate when the budget comfortably fits the neighborhood', () => {
    const r = contextQuery(G, 'main', { budget: 2000, tokensPerNode: 15 });
    expect(r.truncated).toBe(false);
    expect(r.omittedCount).toBe(0);
    // main + helper + logger = 3 symbols.
    expect(r.selection).toHaveLength(3);
  });

  it('reports estimatedTokens proportional to the selection size', () => {
    const r = contextQuery(G, 'main', { tokensPerNode: 10 });
    expect(r.estimatedTokens).toBe(r.selection.length * 10);
  });

  it('defaults the budget to 2000', () => {
    const r = contextQuery(G, 'main');
    expect(r.budget).toBe(2000);
  });
});

describe('contextQuery — maxDepth ceiling', () => {
  it('stops expansion at the configured hop ceiling', () => {
    // Query main with maxDepth 0 → only the seed, no neighbors.
    const r = contextQuery(G, 'main', { maxDepth: 0 });
    expect(r.selection).toHaveLength(1);
    expect(r.selection[0].symbol).toBe('main');
  });
});

describe('contextQuery — anchor', () => {
  it('picks the highest call-in-degree seed as the anchor', () => {
    // logger has the most callers (2); querying it makes it the anchor.
    const r = contextQuery(G, 'logger');
    expect(r.anchor?.symbol).toBe('logger');
    expect(r.anchor?.calledFrom).toBe(2);
    expect(r.anchor?.sourceFile).toBe('src/c.ts');
  });
});

describe('contextQuery — blast radius', () => {
  it('counts unique callers of the seeds + distinct caller files', () => {
    // logger's callers: main (src/a.ts) + helper (src/b.ts) → 2 callers, 2 files.
    const r = contextQuery(G, 'logger');
    expect(r.blastRadius.callers).toBe(2);
    expect(r.blastRadius.callerFiles).toBe(2);
  });

  it('reports zero blast radius for an uncalled seed', () => {
    // main has no callers.
    const r = contextQuery(G, 'main');
    expect(r.blastRadius.callers).toBe(0);
    expect(r.blastRadius.callerFiles).toBe(0);
  });
});

describe('contextQuery — community grouping', () => {
  it('groups the selection by community', () => {
    const r = contextQuery(G, 'main');
    expect(r.byCommunity.length).toBeGreaterThanOrEqual(1);
    // comm 0 (src/) holds main + helper; comm 1 (src/c.ts) holds logger.
    const comm0 = r.byCommunity.find((g) => g.communityId === 0);
    expect(comm0?.symbols.sort()).toEqual(['helper', 'main']);
    const comm1 = r.byCommunity.find((g) => g.communityId === 1);
    expect(comm1?.symbols).toEqual(['logger']);
    expect(comm1?.role).toBe('src/c.ts');
  });

  it('ranks the seed-containing community FIRST, even when another is bigger', () => {
    // Query logger(): seed lands in comm 1 (1 symbol); the BFS pulls
    // its callers main + helper into comm 0 (2 symbols). Size-sorting
    // alone would put comm 0 first and bury the seed — seed-first
    // ordering must surface comm 1 at the top.
    const r = contextQuery(G, 'logger');
    expect(r.byCommunity[0].communityId).toBe(1);
    expect(r.byCommunity[0].symbols).toContain('logger');
    // comm 0 is larger but seedless → ranks second.
    expect(r.byCommunity[1].communityId).toBe(0);
    expect(r.byCommunity[1].symbols.length).toBeGreaterThan(r.byCommunity[0].symbols.length);
  });
});

describe('contextQuery — substring opt-in', () => {
  it('does not substring-expand by default', () => {
    // "log" is not an exact symbolIndex key; default (no substring) misses.
    const r = contextQuery(G, 'log');
    expect(r.matched).toBe(false);
  });

  it('matches substrings when opted in', () => {
    const r = contextQuery(G, 'log', { substring: true });
    expect(r.matched).toBe(true);
    expect(r.selection.some((s) => s.symbol === 'logger')).toBe(true);
  });
});
