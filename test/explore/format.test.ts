/**
 * Tests for src/explore/format.ts — the shared markdown + JSON
 * output helpers used by every explore subcommand. Pure functions,
 * pure assertions.
 */

import { describe, expect, it } from 'vitest';
import { envelope, markdownFooter, markdownHeader, markdownTable } from '../../src/explore/format';
import type { Graph } from '../../src/explore/types';

const SAMPLE_GRAPH = {
  schemaVersion: 1,
  meta: {
    tool: 'graphify',
    graphifyVersion: '',
    dxkitVersion: '2.7.0',
    generatedAt: '2026-05-27T00:00:00Z',
    sourceFilesInGraph: 100,
    excludedFileCount: 50,
    packs: ['typescript'],
    truncated: false,
    truncatedReason: '',
  },
  nodes: [],
  edges: [],
  communities: [],
  symbolIndex: {},
  nodeById: new Map(),
  edgesFromNode: new Map(),
  edgesToNode: new Map(),
  nodesByFile: new Map(),
  communityById: new Map(),
  communityByNode: new Map(),
} as unknown as Graph;

describe('envelope', () => {
  it('packages command + args + meta + results into the stable shape', () => {
    const env = envelope('explore.test', { foo: 'bar' }, SAMPLE_GRAPH, [1, 2, 3]);
    expect(env.command).toBe('explore.test');
    expect(env.args).toEqual({ foo: 'bar' });
    expect(env.meta.schemaVersion).toBe(1);
    expect(env.meta.graphGeneratedAt).toBe('2026-05-27T00:00:00Z');
    expect(env.meta.truncated).toBe(false);
    expect(env.results).toEqual([1, 2, 3]);
  });

  it('surfaces truncated state from the graph meta', () => {
    const truncatedGraph = {
      ...SAMPLE_GRAPH,
      meta: { ...SAMPLE_GRAPH.meta, truncated: true, truncatedReason: 'dropped method edges' },
    } as Graph;
    const env = envelope('explore.test', {}, truncatedGraph, []);
    expect(env.meta.truncated).toBe(true);
  });
});

describe('markdownHeader', () => {
  it('renders the title + framing + meta line', () => {
    const md = markdownHeader('Hot files', "what's central?", SAMPLE_GRAPH);
    expect(md).toContain("## Hot files — what's central?");
    expect(md).toContain('100 source files');
    expect(md).toContain('0 nodes'); // SAMPLE_GRAPH has no nodes
    expect(md).toContain('2026-05-27');
  });

  it('emits a truncation note when the graph is truncated', () => {
    const truncatedGraph = {
      ...SAMPLE_GRAPH,
      meta: { ...SAMPLE_GRAPH.meta, truncated: true, truncatedReason: 'method edges dropped' },
    } as Graph;
    const md = markdownHeader('Test', 'demo', truncatedGraph);
    expect(md).toContain('truncated');
    expect(md).toContain('method edges dropped');
  });
});

describe('markdownTable', () => {
  it('renders rows as a markdown table with header alignment', () => {
    const md = markdownTable(['Name', 'Count'] as const, [
      { Name: 'alpha', Count: 1 },
      { Name: 'beta', Count: 2 },
    ]);
    expect(md).toContain('| Name | Count |');
    expect(md).toContain('|---|---|');
    expect(md).toContain('| alpha | 1 |');
    expect(md).toContain('| beta | 2 |');
  });

  it('returns empty string for empty rows', () => {
    expect(markdownTable(['A'] as const, [])).toBe('');
  });

  it('renders empty string for missing values', () => {
    const md = markdownTable(['A', 'B'] as const, [{ A: 'x' } as { A: string; B: string }]);
    expect(md).toContain('| x |  |');
  });
});

describe('markdownFooter', () => {
  it('prefixes the hint with a newline for spacing', () => {
    expect(markdownFooter('Drill in: foo')).toBe('\nDrill in: foo');
  });
});
