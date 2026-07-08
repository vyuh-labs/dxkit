/**
 * Small-repo self-triage (#28): on a small graph, a dead-ended `explore` /
 * `context` query points the agent at grep instead of reading as "nothing here"
 * or costing a second call — the graph's payoff scales with codebase size, and
 * the CLI is honest about it. These tests pin the size predicate, the hint text,
 * and that a miss on a small repo surfaces the hint.
 */
import { describe, expect, it, vi } from 'vitest';
import { isSmallRepo, SMALL_REPO_FILE_THRESHOLD } from '../../src/explore/queries';
import type { Graph, GraphNode } from '../../src/explore/types';
import { smallRepoGrepHint } from '../../src/explore/format';
import { runFeature } from '../../src/explore/cli/feature';

/** Minimal graph with `fileCount` distinct source files — only `nodesByFile`
 *  matters for the size predicate + hint. */
function graphWithFiles(fileCount: number): Graph {
  const nodes: GraphNode[] = [];
  const nodesByFile = new Map<string, GraphNode[]>();
  for (let i = 0; i < fileCount; i++) {
    const n = { id: `n${i}`, label: `sym${i}`, sourceFile: `src/f${i}.ts` } as unknown as GraphNode;
    nodes.push(n);
    nodesByFile.set(n.sourceFile, [n]);
  }
  return {
    meta: {
      tool: 'graphify',
      graphifyVersion: '',
      dxkitVersion: '3.0.0',
      generatedAt: '2026-07-06T00:00:00Z',
      sourceFilesInGraph: fileCount,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    schemaVersion: 1,
    nodes,
    edges: [],
    communities: [],
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    edgesFromNode: new Map(),
    edgesToNode: new Map(),
    nodesByFile,
    communityById: new Map(),
    communityByNode: new Map(),
    endpointById: new Map(),
    endpointByKey: new Map(),
    symbolIndex: {},
    endpoints: [],
  } as unknown as Graph;
}

describe('isSmallRepo — size predicate', () => {
  it('is true below the threshold, false at/above it', () => {
    expect(isSmallRepo(graphWithFiles(10))).toBe(true);
    expect(isSmallRepo(graphWithFiles(SMALL_REPO_FILE_THRESHOLD - 1))).toBe(true);
    expect(isSmallRepo(graphWithFiles(SMALL_REPO_FILE_THRESHOLD))).toBe(false);
    expect(isSmallRepo(graphWithFiles(SMALL_REPO_FILE_THRESHOLD + 50))).toBe(false);
  });

  it('is false for an empty graph (nothing to advise about)', () => {
    expect(isSmallRepo(graphWithFiles(0))).toBe(false);
  });
});

describe('smallRepoGrepHint', () => {
  it('names the file count and a concrete grep command on a small repo', () => {
    const hint = smallRepoGrepHint(graphWithFiles(12), 'auth');
    expect(hint).toContain('12 files');
    expect(hint).toContain('grep -rin auth');
  });

  it('returns null on a large repo (the graph is the better tool there)', () => {
    expect(smallRepoGrepHint(graphWithFiles(500), 'auth')).toBeNull();
  });

  it('never emits a shell-unsafe keyword — substitutes a placeholder', () => {
    const hint = smallRepoGrepHint(graphWithFiles(12), 'auth; rm -rf /');
    expect(hint).toContain('<keyword>');
    expect(hint).not.toContain('rm -rf');
  });
});

describe('explore feature — small-repo miss surfaces the grep hint', () => {
  it('prints the no-match guidance + the grep advisory on a small repo', () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    try {
      // Nonexistent keyword on a small graph → auto-substring also misses →
      // no-match guidance + the grep hint.
      runFeature(graphWithFiles(15), ['nonexistent-xyz'], {});
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('No symbols matched');
    expect(out).toContain('grep -rin nonexistent-xyz');
  });
});
