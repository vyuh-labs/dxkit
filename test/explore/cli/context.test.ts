/**
 * Output-shape tests for the `context` CLI handler (runContext). The
 * pure selection logic lives in contextQuery (see
 * test/explore/context-query.test.ts); this file captures stdout and
 * asserts the markdown + JSON rendering — anchor line, blast-radius
 * framing, seed marker, per-community cap, honest truncation footer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runContext } from '../../../src/explore/cli/context';
import type {
  Community,
  Graph,
  GraphEdge,
  GraphJson,
  GraphNode,
  SymbolIndex,
} from '../../../src/explore/types';

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
      sourceFilesInGraph: 3,
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

const NODES: GraphNode[] = [
  { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
  { id: 'n1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 5 },
  { id: 'n2', kind: 'module', label: 'src/b.ts', sourceFile: 'src/b.ts' },
  { id: 'n3', kind: 'function', label: 'helper()', sourceFile: 'src/b.ts', line: 3 },
  { id: 'n4', kind: 'module', label: 'src/c.ts', sourceFile: 'src/c.ts' },
  { id: 'n5', kind: 'function', label: 'logger()', sourceFile: 'src/c.ts', line: 1 },
];
const EDGES: GraphEdge[] = [
  { from: 'n1', to: 'n3', relation: 'calls' },
  { from: 'n1', to: 'n5', relation: 'calls' },
  { from: 'n3', to: 'n5', relation: 'calls' },
];
const COMMUNITIES: Community[] = [
  { id: 0, nodeIds: ['n0', 'n1'], cohesion: 0.8, dominantSourceDir: 'src/a', dominantPack: 'ts' },
  {
    id: 1,
    nodeIds: ['n2', 'n3', 'n4', 'n5'],
    cohesion: 0.6,
    dominantSourceDir: 'src/lib',
    dominantPack: 'ts',
  },
];
const INDEX: SymbolIndex = { main: ['n1'], helper: ['n3'], logger: ['n5'] };
const G = makeGraph(NODES, EDGES, COMMUNITIES, INDEX);

/** Capture everything written to stdout during `fn`. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

afterEach(() => vi.restoreAllMocks());

describe('runContext — markdown', () => {
  it('renders the header + anchor line', () => {
    const out = captureStdout(() => runContext(G, ['logger'], {}, '.'));
    expect(out).toContain('## Context — `logger`');
    expect(out).toContain('**Start here:**');
    expect(out).toContain('`logger`');
  });

  it('renders the blast-radius line for a called symbol', () => {
    const out = captureStdout(() => runContext(G, ['logger'], {}, '.'));
    // logger has 2 callers across 2 files.
    expect(out).toMatch(/\*\*Blast radius:\*\* changing.*2 callers across 2 files/);
  });

  it('frames an uncalled symbol as an entry point / public API', () => {
    const out = captureStdout(() => runContext(G, ['main'], {}, '.'));
    expect(out).toContain('no internal callers');
  });

  it('marks the seed symbol with a [seed] tag', () => {
    const out = captureStdout(() => runContext(G, ['main'], {}, '.'));
    expect(out).toMatch(/`main`.*_\[seed\]_/);
  });

  it('shows the honest truncation footer when the budget overflows', () => {
    const out = captureStdout(
      () => runContext(G, ['main'], { budget: '15' }, '.'), // ~1 node fits
    );
    expect(out).toMatch(/\+\d+ more symbols? omitted to fit the 15-token budget/);
  });

  it('includes the same-name conflation caveat', () => {
    const out = captureStdout(() => runContext(G, ['main'], {}, '.'));
    expect(out).toContain('conflates same-name symbols');
  });
});

describe('runContext — file:line routing', () => {
  // src/a.ts: module n0 + main() @5. Give it real source on disk so the
  // slice can be read. The graph fixture G already places main() at line 5.
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ctx-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const lines = Array.from({ length: 12 }, (_, i) => `// line ${i + 1}`);
    lines[4] = 'function main() {'; // line 5 (1-based)
    lines[6] = '  return helper();'; // line 7
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), lines.join('\n'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('renders the enclosing symbol + a line-numbered source chunk', () => {
    const out = captureStdout(() => runContext(G, ['src/a.ts:7'], {}, tmp));
    expect(out).toContain('## Context — `src/a.ts:7`');
    expect(out).toContain('**Enclosing symbol:** `main`');
    expect(out).toContain('return helper();');
    // Line-numbered fence — line 7 prefixed with its number.
    expect(out).toMatch(/7 {2}\s*return helper\(\)/);
  });

  it('emits a JSON envelope carrying the chunk + structural context', () => {
    const out = captureStdout(() => runContext(G, ['src/a.ts:7'], { json: true }, tmp));
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('context');
    expect(parsed.args).toMatchObject({ file: 'src/a.ts', line: 7 });
    expect(parsed.results.enclosingSymbol.symbol).toBe('main');
    expect(Array.isArray(parsed.results.chunk.lines)).toBe(true);
  });

  it('falls back to a centered window for a file absent from the graph', () => {
    fs.writeFileSync(path.join(tmp, 'src/other.ts'), 'a\nb\nc\nd\ne\n');
    const out = captureStdout(() => runContext(G, ['src/other.ts:3'], {}, tmp));
    expect(out).toContain('file not in the code graph');
    expect(out).toContain('c'); // the requested line is shown
  });

  it('exits non-zero with a clear message when the file cannot be read', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => runContext(G, ['src/nope.ts:3'], {}, tmp)).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('Cannot read src/nope.ts');
  });
});

describe('runContext — no match', () => {
  it('prints did-you-mean suggestions for a typo', () => {
    const out = captureStdout(() => runContext(G, ['mian'], {}, '.'));
    expect(out).toContain('No symbols matched');
    expect(out).toContain('`main`');
  });
});

describe('runContext — json', () => {
  it('emits the stable envelope with command=context', () => {
    const out = captureStdout(() => runContext(G, ['logger'], { json: true }, '.'));
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('context');
    expect(parsed.args.query).toBe('logger');
    expect(parsed.results.matched).toBe(true);
    expect(parsed.results.anchor.symbol).toBe('logger');
    expect(parsed.results.blastRadius).toEqual({ callers: 2, callerFiles: 2 });
  });

  it('carries the budget + substring args in the envelope', () => {
    const out = captureStdout(() =>
      runContext(G, ['log'], { json: true, substring: true, budget: '500' }, '.'),
    );
    const parsed = JSON.parse(out);
    expect(parsed.args.budget).toBe(500);
    expect(parsed.args.substring).toBe(true);
    expect(parsed.results.matched).toBe(true);
  });
});
