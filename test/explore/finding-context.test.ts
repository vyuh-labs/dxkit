/**
 * Tests for src/explore/finding-context.ts — the finding-enrichment
 * adapter that attaches graph context to analyzer findings (Sprint 3.6).
 *
 * The pure helpers (locationKey, formatGraphContextCell,
 * graphContextProvenanceLine) are tested directly. buildFindingContextMap
 * loads the graph from disk, so it's exercised against a temp graph.json
 * fixture — including the fail-open path (no graph → undefined).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildEnclosingScopeMap,
  buildFindingContextMap,
  formatGraphContextCell,
  graphContextProvenanceLine,
  locationKey,
} from '../../src/explore/finding-context';
import type { FindingContext } from '../../src/explore/queries';
import { GRAPH_REPORT_PATH } from '../../src/explore/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-finding-ctx-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeGraphFixture(content: unknown) {
  const filePath = path.join(tmpDir, GRAPH_REPORT_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content));
}

// auth.ts declares login()@10 + validate()@30; routes.ts + admin.ts
// both call into it. Community 0 = src/svc/.
const fixtureGraph = () => ({
  schemaVersion: 1,
  meta: {
    tool: 'graphify',
    graphifyVersion: '',
    dxkitVersion: '2.7.0',
    generatedAt: '2026-05-28T00:00:00Z',
    sourceFilesInGraph: 3,
    excludedFileCount: 0,
    packs: ['typescript'],
    truncated: false,
    truncatedReason: '',
  },
  nodes: [
    { id: 'a0', kind: 'module', label: 'src/svc/auth.ts', sourceFile: 'src/svc/auth.ts' },
    { id: 'a1', kind: 'function', label: 'login()', sourceFile: 'src/svc/auth.ts', line: 10 },
    { id: 'a2', kind: 'function', label: 'validate()', sourceFile: 'src/svc/auth.ts', line: 30 },
    { id: 'r0', kind: 'module', label: 'src/api/routes.ts', sourceFile: 'src/api/routes.ts' },
    { id: 'r1', kind: 'function', label: 'handler()', sourceFile: 'src/api/routes.ts', line: 4 },
    { id: 'm0', kind: 'module', label: 'src/api/admin.ts', sourceFile: 'src/api/admin.ts' },
    { id: 'm1', kind: 'function', label: 'adminFn()', sourceFile: 'src/api/admin.ts', line: 7 },
    // A C# file — graphify's call graph is unreliable for .cs, so its
    // blast radius must be suppressed even though it's in the graph.
    { id: 'c0', kind: 'module', label: 'src/Svc/Auth.cs', sourceFile: 'src/Svc/Auth.cs' },
    { id: 'c1', kind: 'method', label: 'Login()', sourceFile: 'src/Svc/Auth.cs', line: 10 },
  ],
  edges: [
    { from: 'a0', to: 'a1', relation: 'method' },
    { from: 'a0', to: 'a2', relation: 'method' },
    { from: 'r1', to: 'a1', relation: 'calls' },
    { from: 'm1', to: 'a1', relation: 'calls' },
    { from: 'm1', to: 'a2', relation: 'calls' },
    { from: 'c0', to: 'c1', relation: 'method' },
  ],
  communities: [
    {
      id: 0,
      nodeIds: ['a0', 'a1', 'a2'],
      cohesion: 0.9,
      dominantSourceDir: 'src/svc/',
      dominantPack: 'typescript',
    },
  ],
  symbolIndex: {},
});

describe('locationKey', () => {
  it('includes the line when present', () => {
    expect(locationKey('src/a.ts', 42)).toBe('src/a.ts:42');
  });
  it('omits the line for file-level findings', () => {
    expect(locationKey('src/a.ts')).toBe('src/a.ts');
  });
});

describe('buildFindingContextMap', () => {
  it('returns undefined (fail-open) when no graph.json exists', () => {
    expect(buildFindingContextMap(tmpDir, [{ file: 'src/svc/auth.ts', line: 12 }])).toBeUndefined();
  });

  it('returns undefined (fail-open) when graph.json is corrupt', () => {
    const filePath = path.join(tmpDir, GRAPH_REPORT_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not valid json');
    expect(buildFindingContextMap(tmpDir, [{ file: 'src/svc/auth.ts', line: 12 }])).toBeUndefined();
  });

  it('enriches findings located in graph files + carries provenance', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(tmpDir, [{ file: 'src/svc/auth.ts', line: 12 }]);
    expect(gc).toBeDefined();
    expect(gc!.generatedAt).toBe('2026-05-28T00:00:00Z');
    expect(gc!.truncated).toBe(false);
    const ctx = gc!.contexts['src/svc/auth.ts:12'];
    expect(ctx.found).toBe(true);
    expect(ctx.blastRadius.callerFiles).toBe(2);
    expect(ctx.community).toEqual({ id: 0, role: 'src/svc/' });
    expect(ctx.enclosingSymbol).toEqual({ symbol: 'login', line: 10 });
  });

  it('omits findings whose file is not in the graph (lean payload)', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(tmpDir, [
      { file: 'src/svc/auth.ts', line: 12 },
      { file: 'src/not-parsed.ts', line: 3 },
    ]);
    expect(Object.keys(gc!.contexts)).toEqual(['src/svc/auth.ts:12']);
  });

  it('dedupes identical locations', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(tmpDir, [
      { file: 'src/svc/auth.ts', line: 12 },
      { file: 'src/svc/auth.ts', line: 12 },
    ]);
    expect(Object.keys(gc!.contexts)).toHaveLength(1);
  });

  it('stamps callGraphReliability=unreliable for a C# finding (real language registry)', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(tmpDir, [{ file: 'src/Svc/Auth.cs', line: 12 }]);
    const ctx = gc!.contexts['src/Svc/Auth.cs:12'];
    expect(ctx.found).toBe(true);
    expect(ctx.callGraphReliability).toBe('unreliable');
  });

  it('does NOT stamp reliability for a reliable-language (TS) finding', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(tmpDir, [{ file: 'src/svc/auth.ts', line: 12 }]);
    // Absent ⇒ treated as 'full' by consumers; kept off the payload to stay lean.
    expect(gc!.contexts['src/svc/auth.ts:12'].callGraphReliability).toBeUndefined();
  });

  it('budget-caps enrichment at maxFindings unique locations', () => {
    writeGraphFixture(fixtureGraph());
    const gc = buildFindingContextMap(
      tmpDir,
      [
        { file: 'src/svc/auth.ts', line: 12 },
        { file: 'src/api/routes.ts', line: 4 },
        { file: 'src/api/admin.ts', line: 7 },
      ],
      { maxFindings: 1 },
    );
    // Only the first unique location is enriched.
    expect(Object.keys(gc!.contexts)).toEqual(['src/svc/auth.ts:12']);
  });
});

describe('buildEnclosingScopeMap (D-G5 scope pre-pass)', () => {
  it('returns undefined (fail-open) when no graph.json exists', () => {
    expect(buildEnclosingScopeMap(tmpDir, [{ file: 'src/svc/auth.ts', line: 12 }])).toBeUndefined();
  });

  it('maps code locations to their enclosing symbol, keyed by file:line', () => {
    writeGraphFixture(fixtureGraph());
    const map = buildEnclosingScopeMap(tmpDir, [
      { file: 'src/svc/auth.ts', line: 12 }, // inside login()@10
      { file: 'src/svc/auth.ts', line: 35 }, // inside validate()@30
    ]);
    expect(map).toEqual({
      'src/svc/auth.ts:12': 'login',
      'src/svc/auth.ts:35': 'validate',
    });
  });

  it('omits locations with no resolvable symbol (→ file-level fallback downstream)', () => {
    writeGraphFixture(fixtureGraph());
    const map = buildEnclosingScopeMap(tmpDir, [
      { file: 'src/svc/auth.ts', line: 5 }, // above the earliest declaration
      { file: 'src/nowhere.ts', line: 9 }, // file not in graph
      { file: 'src/svc/auth.ts' }, // no line (file-level finding)
    ]);
    expect(map).toEqual({});
  });

  it('dedupes identical locations (resolves each file:line once)', () => {
    writeGraphFixture(fixtureGraph());
    const map = buildEnclosingScopeMap(tmpDir, [
      { file: 'src/svc/auth.ts', line: 12 },
      { file: 'src/svc/auth.ts', line: 12 },
    ]);
    expect(map).toEqual({ 'src/svc/auth.ts:12': 'login' });
  });
});

describe('formatGraphContextCell', () => {
  const found: FindingContext = {
    found: true,
    sourceFile: 'src/svc/auth.ts',
    community: { id: 0, role: 'src/svc/' },
    blastRadius: { callerFiles: 2, callers: 3, topCallerFiles: ['src/api/routes.ts'] },
  };

  it('renders role + caller-file count', () => {
    expect(formatGraphContextCell(found)).toBe('src/svc/ · 2 caller files');
  });

  it('singularizes a single caller file', () => {
    expect(
      formatGraphContextCell({
        ...found,
        blastRadius: { callerFiles: 1, callers: 1, topCallerFiles: [] },
      }),
    ).toBe('src/svc/ · 1 caller file');
  });

  it('renders a dash for missing / not-found context', () => {
    expect(formatGraphContextCell(undefined)).toBe('—');
    expect(
      formatGraphContextCell({
        found: false,
        sourceFile: 'x',
        blastRadius: { callerFiles: 0, callers: 0, topCallerFiles: [] },
      }),
    ).toBe('—');
  });

  it('suppresses the caller count for unreliable call graphs (never shows "0 caller files")', () => {
    const cell = formatGraphContextCell({
      found: true,
      sourceFile: 'src/Svc/Auth.cs',
      community: { id: 3, role: 'src/Svc/' },
      blastRadius: { callerFiles: 0, callers: 0, topCallerFiles: [] },
      callGraphReliability: 'unreliable',
    });
    expect(cell).toBe('src/Svc/ · blast radius n/a (call graph)');
    expect(cell).not.toContain('caller file');
  });
});

describe('graphContextProvenanceLine', () => {
  it('stamps the graph generation date', () => {
    const line = graphContextProvenanceLine({
      generatedAt: '2026-05-28T00:00:00Z',
      truncated: false,
      contexts: {},
    });
    expect(line).toContain('2026-05-28');
    expect(line).not.toContain('truncated — coverage partial');
  });

  it('notes truncation when the graph is partial', () => {
    const line = graphContextProvenanceLine({
      generatedAt: '2026-05-28T00:00:00Z',
      truncated: true,
      contexts: {},
    });
    expect(line).toContain('graph truncated — coverage partial');
  });
});
