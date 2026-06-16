/**
 * Tests for src/explore/queries.ts — graph query primitives.
 *
 * Sprint 1 ships three primitives consumed by both the explore CLI
 * (Sprint 2) and the dashboard viz adapter (Sprint 3):
 * - callersOf(graph, nodeId) — predecessors via 'calls' edges
 * - calleesOf(graph, nodeId) — successors via 'calls' edges
 * - nodesInFile(graph, sourceFile) — all symbols declared in a file
 *
 * Pure tests against a synthetic Graph fixture built inline (no
 * loadGraph, no disk).
 */

import { describe, expect, it } from 'vitest';
import {
  apiSurfaceQuery,
  callersOf,
  calleesOf,
  communitiesQuery,
  enclosingSymbolFor,
  entryPointsQuery,
  featureQuery,
  fileSummaryQuery,
  findingContextQuery,
  hotFilesQuery,
  nodesInFile,
} from '../../src/explore/queries';
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

// Six-node, four-call-edge fixture:
// src/a.ts: n0 module, n1 function (main)
// src/b.ts: n2 module, n3 function (helper)
// src/c.ts: n4 module, n5 function (logger)
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

// ─── High-level queries (Sprint 2) ────────────────────────────────────────

describe('hotFilesQuery', () => {
  it('ranks files by total in-degree (calls + imports)', () => {
    const results = hotFilesQuery(G, 10);
    // src/c.ts: callsIn=2 (helper + main), importsIn=0, total=2
    // src/b.ts: callsIn=1 (main), importsIn=1 (a imports b), total=2
    // src/a.ts: total=0
    // src/b.ts and src/c.ts tie at total=2; alphabetical break → b.ts first.
    const top2 = results
      .slice(0, 2)
      .map((r) => r.sourceFile)
      .sort();
    expect(top2).toEqual(['src/b.ts', 'src/c.ts']);
    const cResult = results.find((r) => r.sourceFile === 'src/c.ts');
    expect(cResult?.callsIn).toBe(2);
  });

  it('honors the limit', () => {
    expect(hotFilesQuery(G, 2)).toHaveLength(2);
    expect(hotFilesQuery(G, 1)).toHaveLength(1);
  });

  it('returns ALL files when limit exceeds graph size', () => {
    expect(hotFilesQuery(G, 100)).toHaveLength(3);
  });
});

describe('communitiesQuery', () => {
  it('returns empty array when no communities', () => {
    // G has no communities populated.
    expect(communitiesQuery(G, 8)).toEqual([]);
  });

  it('honors the limit', () => {
    // Build a graph with 2 synthetic communities patched in via
    // `as unknown as` cast (the canonical Graph has readonly fields;
    // the cast is intentional for test-only fixture construction).
    const base = makeGraph(NODES, EDGES);
    const communities = [
      {
        id: 0,
        nodeIds: ['n0', 'n1'],
        cohesion: 0.9,
        dominantSourceDir: 'src/',
        dominantPack: 'typescript',
      },
      {
        id: 1,
        nodeIds: ['n2', 'n3'],
        cohesion: 0.8,
        dominantSourceDir: 'src/',
        dominantPack: 'typescript',
      },
    ];
    const gWithCommunities = {
      ...base,
      communities,
      communityById: new Map(communities.map((c) => [c.id, c])),
    } as unknown as Graph;
    expect(communitiesQuery(gWithCommunities, 1)).toHaveLength(1);
    expect(communitiesQuery(gWithCommunities, 5)).toHaveLength(2);
  });
});

describe('fileSummaryQuery', () => {
  it('returns found: false for a file not in the graph', () => {
    const result = fileSummaryQuery(G, 'src/missing.ts');
    expect(result.found).toBe(false);
    expect(result.symbols).toEqual([]);
  });

  it('summarizes symbols + callers + callees for a known file', () => {
    const result = fileSummaryQuery(G, 'src/c.ts');
    expect(result.found).toBe(true);
    expect(result.symbols.map((s) => s.label).sort()).toEqual(['logger()']);
    // logger() has 2 callers (helper from b.ts, main from a.ts)
    expect(result.callerFiles.map((c) => c.sourceFile).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('preserves the exported flag from the node', () => {
    const nodes: GraphNode[] = [
      { id: 'm0', kind: 'module', label: 'src/x.ts', sourceFile: 'src/x.ts' },
      {
        id: 'f0',
        kind: 'function',
        label: 'foo()',
        sourceFile: 'src/x.ts',
        line: 1,
        exported: true,
      },
      {
        id: 'f1',
        kind: 'function',
        label: 'bar()',
        sourceFile: 'src/x.ts',
        line: 2,
        exported: false,
      },
    ];
    const g = makeGraph(nodes, []);
    const result = fileSummaryQuery(g, 'src/x.ts');
    const exportedSymbols = result.symbols.filter((s) => s.exported === true);
    expect(exportedSymbols.map((s) => s.label)).toEqual(['foo()']);
  });
});

describe('entryPointsQuery', () => {
  it('returns empty when no patterns supplied', () => {
    expect(entryPointsQuery(G, [], [])).toEqual([]);
  });

  it('matches nodes by sourceFile path against primaryPaths', () => {
    const nodes: GraphNode[] = [
      {
        id: 'm0',
        kind: 'module',
        label: 'src/controllers/users.ts',
        sourceFile: 'src/controllers/users.ts',
      },
      {
        id: 'f0',
        kind: 'function',
        label: 'createUser()',
        sourceFile: 'src/controllers/users.ts',
        line: 5,
      },
      {
        id: 'm1',
        kind: 'module',
        label: 'src/utils/helpers.ts',
        sourceFile: 'src/utils/helpers.ts',
      },
      {
        id: 'f1',
        kind: 'function',
        label: 'isValid()',
        sourceFile: 'src/utils/helpers.ts',
        line: 1,
      },
    ];
    const edges: GraphEdge[] = [
      { from: 'f0', to: 'f1', relation: 'calls' }, // createUser calls isValid (gives createUser callsOut=1)
    ];
    const g = makeGraph(nodes, edges);
    const results = entryPointsQuery(g, ['/controllers/'], [], 10);
    expect(results.map((r) => r.symbol)).toEqual(['createUser()']);
    expect(results[0].componentType).toBe('controllers');
    expect(results[0].pack).toBe('typescript');
  });

  it('filters out symbols with zero call out-degree', () => {
    const nodes: GraphNode[] = [
      {
        id: 'm0',
        kind: 'module',
        label: 'src/controllers/users.ts',
        sourceFile: 'src/controllers/users.ts',
      },
      // Function in controllers/ but no outbound calls — not an entry point
      {
        id: 'f0',
        kind: 'function',
        label: 'unused()',
        sourceFile: 'src/controllers/users.ts',
        line: 5,
      },
    ];
    const g = makeGraph(nodes, []);
    expect(entryPointsQuery(g, ['/controllers/'], [])).toEqual([]);
  });
});

describe('apiSurfaceQuery', () => {
  it('returns exported symbols with zero internal callers', () => {
    const nodes: GraphNode[] = [
      { id: 'm0', kind: 'module', label: 'src/index.ts', sourceFile: 'src/index.ts' },
      {
        id: 'f0',
        kind: 'function',
        label: 'publicApi()',
        sourceFile: 'src/index.ts',
        line: 1,
        exported: true,
      },
      {
        id: 'f1',
        kind: 'function',
        label: 'usedInternally()',
        sourceFile: 'src/index.ts',
        line: 5,
        exported: true,
      },
      {
        id: 'f2',
        kind: 'function',
        label: 'private()',
        sourceFile: 'src/index.ts',
        line: 10,
        exported: false,
      },
    ];
    const edges: GraphEdge[] = [
      { from: 'f0', to: 'f1', relation: 'calls' }, // publicApi calls usedInternally → usedInternally has a caller
    ];
    const g = makeGraph(nodes, edges);
    const results = apiSurfaceQuery(g, [], 10);
    expect(results.map((r) => r.symbol)).toEqual(['publicApi()']);
  });

  it('skips packs in the packsExcluded list', () => {
    const nodes: GraphNode[] = [
      {
        id: 'f0',
        kind: 'function',
        label: 'foo()',
        sourceFile: 'src/foo.ts',
        line: 1,
        exported: true,
      },
      {
        id: 'f1',
        kind: 'function',
        label: 'bar()',
        sourceFile: 'src/bar.rb',
        line: 1,
        exported: true,
      },
    ];
    const g = makeGraph(nodes, []);
    const results = apiSurfaceQuery(g, ['ruby'], 10);
    expect(results.map((r) => r.symbol)).toEqual(['foo()']);
  });

  it('ignores symbols where exported is absent (unknown)', () => {
    const nodes: GraphNode[] = [
      { id: 'f0', kind: 'function', label: 'foo()', sourceFile: 'src/foo.ts', line: 1 }, // no exported flag
      {
        id: 'f1',
        kind: 'function',
        label: 'bar()',
        sourceFile: 'src/bar.ts',
        line: 1,
        exported: true,
      },
    ];
    const g = makeGraph(nodes, []);
    const results = apiSurfaceQuery(g, [], 10);
    expect(results.map((r) => r.symbol)).toEqual(['bar()']);
  });
});

describe('featureQuery', () => {
  const featureNodes: GraphNode[] = [
    { id: 'm0', kind: 'module', label: 'src/connectors.ts', sourceFile: 'src/connectors.ts' },
    { id: 'c0', kind: 'class', label: 'Connector', sourceFile: 'src/connectors.ts', line: 1 },
    {
      id: 'f0',
      kind: 'function',
      label: 'createConnector()',
      sourceFile: 'src/connectors.ts',
      line: 5,
    },
    { id: 'f1', kind: 'function', label: 'unrelated()', sourceFile: 'src/other.ts', line: 1 },
  ];
  const featureEdges: GraphEdge[] = [
    { from: 'f0', to: 'c0', relation: 'calls' }, // createConnector references Connector
  ];
  const baseFeatureGraph = makeGraph(featureNodes, featureEdges);
  // Patch in a symbol index via cast (test-only fixture construction;
  // the canonical Graph has readonly fields).
  const featureGraph = {
    ...baseFeatureGraph,
    symbolIndex: {
      connector: ['c0'],
      createconnector: ['f0'],
      unrelated: ['f1'],
    },
  } as unknown as Graph;

  it('returns exact match via symbolIndex', () => {
    const result = featureQuery(featureGraph, 'connector');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.suggestions).toEqual([]);
  });

  it('expands via substring when --substring opt-in', () => {
    const result = featureQuery(featureGraph, 'conn', { substring: true });
    // 'conn' substring matches 'connector' + 'createconnector'
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('skips substring expansion by default', () => {
    const result = featureQuery(featureGraph, 'conn');
    // 'conn' has no exact symbolIndex key, no edit-distance match → suggestions
    expect(result.results).toEqual([]);
  });

  it('returns edit-distance + substring suggestions on zero hits', () => {
    const result = featureQuery(featureGraph, 'connectoq'); // typo of "connector"
    expect(result.results).toEqual([]);
    // Substring 'connectoq' has no substring matches but levenshtein
    // distance to 'connector' is 1 → should suggest 'connector'.
    expect(result.suggestions.map((s) => s.key)).toContain('connector');
  });

  it('populates centralEntryPoint as the highest-in-degree seed', () => {
    // c0 has 1 caller (f0). f0 has 0 callers.
    const result = featureQuery(featureGraph, 'connector');
    expect(result.centralEntryPoint?.symbol).toBe('Connector');
    expect(result.centralEntryPoint?.calledFrom).toBe(1);
  });
});

describe('findingContextQuery', () => {
  // Fixture: src/svc/auth.ts declares login() @10 and validate() @30.
  // Two other files call into auth.ts:
  // src/api/routes.ts (n10 handler) -> login() [1 call]
  // src/api/admin.ts (n12 adminFn) -> login() + validate() [2 calls]
  // Community 0 (dominantSourceDir 'src/svc/') owns the auth.ts nodes.
  const FC_NODES: GraphNode[] = [
    { id: 'a0', kind: 'module', label: 'src/svc/auth.ts', sourceFile: 'src/svc/auth.ts' },
    { id: 'a1', kind: 'function', label: 'login()', sourceFile: 'src/svc/auth.ts', line: 10 },
    { id: 'a2', kind: 'function', label: 'validate()', sourceFile: 'src/svc/auth.ts', line: 30 },
    { id: 'r0', kind: 'module', label: 'src/api/routes.ts', sourceFile: 'src/api/routes.ts' },
    { id: 'r1', kind: 'function', label: 'handler()', sourceFile: 'src/api/routes.ts', line: 4 },
    { id: 'm0', kind: 'module', label: 'src/api/admin.ts', sourceFile: 'src/api/admin.ts' },
    { id: 'm1', kind: 'function', label: 'adminFn()', sourceFile: 'src/api/admin.ts', line: 7 },
  ];
  const FC_EDGES: GraphEdge[] = [
    { from: 'a0', to: 'a1', relation: 'method' },
    { from: 'a0', to: 'a2', relation: 'method' },
    { from: 'r1', to: 'a1', relation: 'calls' }, // routes.handler -> login
    { from: 'm1', to: 'a1', relation: 'calls' }, // admin.adminFn -> login
    { from: 'm1', to: 'a2', relation: 'calls' }, // admin.adminFn -> validate
  ];
  const FC_COMMUNITIES: Community[] = [
    {
      id: 0,
      nodeIds: ['a0', 'a1', 'a2'],
      cohesion: 0.9,
      dominantSourceDir: 'src/svc/',
      dominantPack: 'typescript',
    },
  ];
  const FC = makeGraph(FC_NODES, FC_EDGES, FC_COMMUNITIES);

  it('returns found:false for a file not in the graph (graceful degradation)', () => {
    const ctx = findingContextQuery(FC, 'src/nowhere.ts', 12);
    expect(ctx.found).toBe(false);
    expect(ctx.blastRadius).toEqual({ callerFiles: 0, callers: 0, topCallerFiles: [] });
    expect(ctx.enclosingSymbol).toBeUndefined();
  });

  it('computes file-level blast radius (unique caller files + total caller calls)', () => {
    const ctx = findingContextQuery(FC, 'src/svc/auth.ts', 12);
    expect(ctx.found).toBe(true);
    // routes.ts + admin.ts both call into auth.ts symbols → 2 caller files.
    expect(ctx.blastRadius.callerFiles).toBe(2);
    // 3 call edges land on auth.ts symbols (routes->login, admin->login, admin->validate).
    expect(ctx.blastRadius.callers).toBe(3);
    expect(ctx.blastRadius.topCallerFiles).toContain('src/api/routes.ts');
    expect(ctx.blastRadius.topCallerFiles).toContain('src/api/admin.ts');
  });

  it('resolves the community role from the dominant source dir', () => {
    const ctx = findingContextQuery(FC, 'src/svc/auth.ts', 12);
    expect(ctx.community).toEqual({ id: 0, role: 'src/svc/' });
  });

  it('maps a line to the nearest enclosing declaration at-or-above it', () => {
    // Line 12 sits below login()@10, above validate()@30 → login().
    expect(findingContextQuery(FC, 'src/svc/auth.ts', 12).enclosingSymbol).toEqual({
      symbol: 'login',
      line: 10,
    });
    // Line 35 sits below validate()@30 → validate().
    expect(findingContextQuery(FC, 'src/svc/auth.ts', 35).enclosingSymbol).toEqual({
      symbol: 'validate',
      line: 30,
    });
    // Exactly on the declaration line counts as inside it.
    expect(findingContextQuery(FC, 'src/svc/auth.ts', 10).enclosingSymbol?.symbol).toBe('login');
  });

  it('omits enclosingSymbol when no declaration sits at-or-above the line', () => {
    // Line 5 is above login()@10 (the earliest symbol) → no enclosing decl.
    expect(findingContextQuery(FC, 'src/svc/auth.ts', 5).enclosingSymbol).toBeUndefined();
  });

  it('omits enclosingSymbol when no line is supplied (file-level finding)', () => {
    const ctx = findingContextQuery(FC, 'src/svc/auth.ts');
    expect(ctx.found).toBe(true);
    expect(ctx.enclosingSymbol).toBeUndefined();
    // Blast radius is still computed for file-level findings.
    expect(ctx.blastRadius.callerFiles).toBe(2);
  });

  it('labels an unclustered file (no community) honestly', () => {
    const ctx = findingContextQuery(FC, 'src/api/routes.ts');
    expect(ctx.found).toBe(true);
    expect(ctx.community).toEqual({ role: 'unclustered' });
  });

  it('caps topCallerFiles to the requested count', () => {
    const ctx = findingContextQuery(FC, 'src/svc/auth.ts', undefined, { topCallerFiles: 1 });
    expect(ctx.blastRadius.topCallerFiles).toHaveLength(1);
    // Full count is preserved even when the sample is capped.
    expect(ctx.blastRadius.callerFiles).toBe(2);
  });

  // The focused scope query backing content-anchored code identity.
  describe('enclosingSymbolFor', () => {
    it('resolves the declaration nearest at-or-above the line (parens stripped)', () => {
      // 12 sits below login()@10, above validate()@30 → login.
      expect(enclosingSymbolFor(FC, 'src/svc/auth.ts', 12)).toBe('login');
      // 35 sits below validate()@30 → validate.
      expect(enclosingSymbolFor(FC, 'src/svc/auth.ts', 35)).toBe('validate');
      // Exactly on the declaration counts as inside it.
      expect(enclosingSymbolFor(FC, 'src/svc/auth.ts', 10)).toBe('login');
    });

    it('is line-stable within a symbol: every line in the body maps to one scope', () => {
      // The whole point of B — a finding moving 10→29 keeps scope=login,
      // so its content anchor (scope, span, ordinal) survives the move.
      const scopes = [10, 15, 20, 29].map((l) => enclosingSymbolFor(FC, 'src/svc/auth.ts', l));
      expect(new Set(scopes)).toEqual(new Set(['login']));
    });

    it('returns undefined above the earliest declaration (file-level fallback)', () => {
      expect(enclosingSymbolFor(FC, 'src/svc/auth.ts', 5)).toBeUndefined();
    });

    it('returns undefined for a file absent from the graph', () => {
      expect(enclosingSymbolFor(FC, 'src/nowhere.ts', 12)).toBeUndefined();
    });
  });
});
