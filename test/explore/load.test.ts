/**
 * Tests for src/explore/load.ts:loadGraph — the canonical graph
 * artifact reader. Covers the four contract surfaces:
 *   1. Success path (returns a Graph with populated indices)
 *   2. GraphNotFoundError when the file is missing
 *   3. GraphSchemaVersionError when the wire format is newer
 *   4. GraphCorruptError on malformed JSON / missing fields
 *
 * Pure tests — no subprocess, no graphify dependency. Fixtures
 * are synthesized inline + written to a per-test temp dir.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GraphCorruptError,
  GraphNotFoundError,
  GraphSchemaVersionError,
  loadGraph,
} from '../../src/explore/load';
import { GRAPH_REPORT_PATH } from '../../src/explore/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-load-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeGraphFixture(content: unknown) {
  const filePath = path.join(tmpDir, GRAPH_REPORT_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content));
}

const validGraph = () => ({
  schemaVersion: 2,
  meta: {
    tool: 'graphify',
    graphifyVersion: '',
    dxkitVersion: '2.7.0',
    generatedAt: '2026-05-27T00:00:00Z',
    sourceFilesInGraph: 2,
    excludedFileCount: 0,
    packs: ['typescript'],
    truncated: false,
    truncatedReason: '',
  },
  nodes: [
    { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
    { id: 'n1', kind: 'function', label: 'foo()', sourceFile: 'src/a.ts', line: 5, exported: true },
    {
      id: 'n2',
      kind: 'function',
      label: 'bar()',
      sourceFile: 'src/b.ts',
      line: 10,
      exported: false,
    },
  ],
  edges: [
    { from: 'n0', to: 'n1', relation: 'method' },
    { from: 'n1', to: 'n2', relation: 'calls' },
    { from: 'n1', to: 'ep0', relation: 'calls-endpoint', fromFile: 'src/a.ts', fromLine: 6 },
  ],
  communities: [
    {
      id: 0,
      nodeIds: ['n0', 'n1', 'n2'],
      cohesion: 0.8,
      dominantSourceDir: 'src/',
      dominantPack: 'typescript',
    },
  ],
  symbolIndex: { foo: ['n1'], bar: ['n2'] },
  endpoints: [
    {
      id: 'ep0',
      kind: 'http-endpoint',
      label: 'GET /articles/{var}',
      method: 'GET',
      path: '/articles/{var}',
      via: 'spec',
      handler: 'ArticleController.find',
      sourceFile: 'openapi.json',
    },
  ],
});

describe('loadGraph', () => {
  it('reads + indexes a valid graph artifact', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.schemaVersion).toBe(2);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(3);
    expect(g.communities).toHaveLength(1);
    expect(Object.keys(g.symbolIndex)).toEqual(['foo', 'bar']);
    expect(g.endpoints).toHaveLength(1);
  });

  it('builds endpointById + endpointByKey indices from the flow overlay', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.endpointById.size).toBe(1);
    expect(g.endpointById.get('ep0')?.method).toBe('GET');
    expect(g.endpointByKey.get('GET /articles/{var}')?.id).toBe('ep0');
    expect(g.endpointByKey.get('POST /nope')).toBeUndefined();
  });

  it('indexes calls-endpoint edges into edgesFromNode / edgesToNode', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    // The consumer's structural node links to the endpoint id.
    const toEp = g.edgesToNode.get('ep0') ?? [];
    expect(toEp).toHaveLength(1);
    expect(toEp[0].relation).toBe('calls-endpoint');
    expect(toEp[0].from).toBe('n1');
    expect(toEp[0].fromFile).toBe('src/a.ts');
    expect(toEp[0].fromLine).toBe(6);
  });

  it('migrates a v1 artifact (no endpoints field) forward to an empty overlay', () => {
    const v1 = validGraph() as Record<string, unknown>;
    v1.schemaVersion = 1;
    delete v1.endpoints;
    // Drop the v2-only calls-endpoint edge so the fixture is a clean v1 shape.
    v1.edges = [
      { from: 'n0', to: 'n1', relation: 'method' },
      { from: 'n1', to: 'n2', relation: 'calls' },
    ];
    writeGraphFixture(v1);

    const g = loadGraph(tmpDir);
    expect(g.schemaVersion).toBe(1);
    expect(g.endpoints).toEqual([]);
    expect(g.endpointById.size).toBe(0);
    expect(g.endpointByKey.size).toBe(0);
  });

  it('throws GraphCorruptError when endpoints is present but not an array', () => {
    const bad = validGraph() as Record<string, unknown>;
    bad.endpoints = { not: 'an array' };
    writeGraphFixture(bad);

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
    expect(() => loadGraph(tmpDir)).toThrow(/endpoints/);
  });

  it('builds nodeById index keyed by node id', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.nodeById.size).toBe(3);
    expect(g.nodeById.get('n1')?.label).toBe('foo()');
    expect(g.nodeById.get('n2')?.line).toBe(10);
    expect(g.nodeById.get('missing')).toBeUndefined();
  });

  it('builds edgesFromNode + edgesToNode indices', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.edgesFromNode.get('n0')).toHaveLength(1);
    expect(g.edgesFromNode.get('n1')?.[0].relation).toBe('calls');
    expect(g.edgesToNode.get('n2')?.[0].from).toBe('n1');
    expect(g.edgesFromNode.get('n2')).toBeUndefined();
  });

  it('builds nodesByFile index keyed by sourceFile', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.nodesByFile.get('src/a.ts')).toHaveLength(2);
    expect(g.nodesByFile.get('src/b.ts')).toHaveLength(1);
    expect(g.nodesByFile.get('src/missing.ts')).toBeUndefined();
  });

  it('builds communityByNode lookup', () => {
    writeGraphFixture(validGraph());
    const g = loadGraph(tmpDir);

    expect(g.communityByNode.get('n0')?.id).toBe(0);
    expect(g.communityByNode.get('n1')?.id).toBe(0);
    expect(g.communityByNode.get('n2')?.id).toBe(0);
    expect(g.communityByNode.get('missing')).toBeUndefined();
  });

  it('throws GraphNotFoundError when graph.json is absent', () => {
    expect(() => loadGraph(tmpDir)).toThrow(GraphNotFoundError);
    // Hint phrasing names the canonical regeneration command.
    expect(() => loadGraph(tmpDir)).toThrow(/vyuh-dxkit health/);
  });

  it('throws GraphSchemaVersionError when wire format is newer than loader', () => {
    const future = validGraph();
    future.schemaVersion = 99;
    writeGraphFixture(future);

    expect(() => loadGraph(tmpDir)).toThrow(GraphSchemaVersionError);
    // Error carries actionable guidance (upgrade hint).
    expect(() => loadGraph(tmpDir)).toThrow(/Upgrade dxkit/);
  });

  it('throws GraphCorruptError on invalid JSON', () => {
    const filePath = path.join(tmpDir, GRAPH_REPORT_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"schemaVersion": 1,'); // truncated

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
  });

  it('throws GraphCorruptError when top-level is not an object', () => {
    writeGraphFixture(['array', 'not', 'object']);

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
    expect(() => loadGraph(tmpDir)).toThrow(/not an object/);
  });

  it('throws GraphCorruptError when schemaVersion is missing', () => {
    const bad = validGraph() as Record<string, unknown>;
    delete bad.schemaVersion;
    writeGraphFixture(bad);

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
    expect(() => loadGraph(tmpDir)).toThrow(/schemaVersion/);
  });

  it('throws GraphCorruptError when a required top-level field is missing', () => {
    const bad = validGraph() as Record<string, unknown>;
    delete bad.nodes;
    writeGraphFixture(bad);

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
    expect(() => loadGraph(tmpDir)).toThrow(/nodes/);
  });

  it('throws GraphCorruptError when nodes / edges / communities are not arrays', () => {
    const bad = validGraph() as Record<string, unknown>;
    bad.nodes = 'not an array';
    writeGraphFixture(bad);

    expect(() => loadGraph(tmpDir)).toThrow(GraphCorruptError);
    expect(() => loadGraph(tmpDir)).toThrow(/not an array/);
  });

  it('GraphNotFoundError carries the absolute path it tried', () => {
    try {
      loadGraph(tmpDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphNotFoundError);
      expect((err as GraphNotFoundError).absPath).toContain(GRAPH_REPORT_PATH);
    }
  });

  it('handles an empty-but-valid graph (no nodes, no edges, no communities)', () => {
    const empty = {
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
      nodes: [],
      edges: [],
      communities: [],
      symbolIndex: {},
    };
    writeGraphFixture(empty);

    const g = loadGraph(tmpDir);
    expect(g.nodes).toHaveLength(0);
    expect(g.nodeById.size).toBe(0);
    expect(g.edgesFromNode.size).toBe(0);
    expect(g.communityByNode.size).toBe(0);
  });
});
