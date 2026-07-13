/**
 * `clusterStats` — the union-find over the duplicate graph that turns O(k²)
 * pairs into distinct PATTERNS (connected components). The load-bearing case is
 * the framework-CRUD star: one method name recurring across N files is ONE
 * pattern, not N·(N-1)/2 pairs.
 */
import { describe, it, expect } from 'vitest';
import {
  clusterStats,
  groupDuplicatesByAdded,
  type DuplicateFinding,
} from '../../../src/analyzers/duplication/findings';

const pair = (aFile: string, aSym: string, bFile: string, bSym: string, score = 1) => ({
  anchors: [
    { file: aFile, symbol: aSym },
    { file: bFile, symbol: bSym },
  ] as const,
  score,
});

describe('clusterStats — duplicate patterns, not pairs', () => {
  it('counts disjoint pairs as separate patterns', () => {
    const stats = clusterStats([pair('a.ts', 'f', 'b.ts', 'f'), pair('c.ts', 'g', 'd.ts', 'g')]);
    expect(stats.clusters).toBe(2);
    expect(stats.largestCluster).toBe(2);
  });

  it('merges a transitive chain into one pattern', () => {
    // a≈b, b≈c → {a,b,c} is a single pattern of 3 functions.
    const stats = clusterStats([
      pair('a.ts', 'load', 'b.ts', 'load'),
      pair('b.ts', 'load', 'c.ts', 'load'),
    ]);
    expect(stats.clusters).toBe(1);
    expect(stats.largestCluster).toBe(3);
  });

  it('collapses a framework-CRUD star (N files) into ONE pattern', () => {
    // `replaceById` across 5 controllers, fully connected → 10 pairs, 1 pattern.
    const files = ['a', 'b', 'c', 'd', 'e'];
    const pairs = [];
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++)
        pairs.push(pair(`${files[i]}.ts`, 'replaceById', `${files[j]}.ts`, 'replaceById'));
    expect(pairs).toHaveLength(10);
    const stats = clusterStats(pairs);
    expect(stats.clusters).toBe(1);
    expect(stats.largestCluster).toBe(5);
  });

  it('respects the minScore floor', () => {
    const stats = clusterStats(
      [pair('a.ts', 'f', 'b.ts', 'f', 0.8), pair('c.ts', 'g', 'd.ts', 'g', 0.95)],
      0.9,
    );
    expect(stats.clusters).toBe(1); // only the 0.95 pair survives
    expect(stats.largestCluster).toBe(2);
  });

  it('is empty for no findings', () => {
    expect(clusterStats([])).toEqual({ clusters: 0, largestCluster: 0 });
  });
});

/** A net-new finding: `added` is the introduced side, `existing` the twin. */
const finding = (
  added: [string, string],
  existing: [string, string],
  score = 1,
  id = `${added[0]}-${existing[0]}`,
): DuplicateFinding => ({
  id,
  score,
  anchors: [
    { file: added[0], symbol: added[1], line: 1 },
    { file: existing[0], symbol: existing[1], line: 1 },
  ],
  changed: [true, false], // added side introduced, existing side pre-existing
});

describe('groupDuplicatesByAdded — one added function is one finding', () => {
  it('collapses N pairs for one added function into a single group with N twins', () => {
    const findings = [
      finding(['new.ts', 'GET'], ['a.ts', 'GET'], 1, 'id-a'),
      finding(['new.ts', 'GET'], ['b.ts', 'GET'], 0.95, 'id-b'),
      finding(['new.ts', 'GET'], ['c.ts', 'GET'], 0.9, 'id-c'),
    ];
    const groups = groupDuplicatesByAdded(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].added.file).toBe('new.ts');
    expect(groups[0].twins).toHaveLength(3);
    expect(groups[0].topScore).toBe(1);
    // Per-pair identities are RETAINED on the twins (granular allowlisting).
    expect(groups[0].twins.map((t) => t.id).sort()).toEqual(['id-a', 'id-b', 'id-c']);
    // Twins are ranked by descending score.
    expect(groups[0].twins.map((t) => t.score)).toEqual([1, 0.95, 0.9]);
  });

  it('keeps distinct added functions as separate groups, ranked by top score', () => {
    const groups = groupDuplicatesByAdded([
      finding(['x.ts', 'f'], ['a.ts', 'f'], 0.8, 'x'),
      finding(['y.ts', 'g'], ['b.ts', 'g'], 0.99, 'y'),
    ]);
    expect(groups.map((g) => g.added.file)).toEqual(['y.ts', 'x.ts']); // 0.99 first
  });

  it('uses the uniquely-changed side as the added function', () => {
    // changed marks the SECOND anchor as the introduced one.
    const f: DuplicateFinding = {
      id: 'z',
      score: 1,
      anchors: [
        { file: 'existing.ts', symbol: 'h', line: 1 },
        { file: 'added.ts', symbol: 'h', line: 1 },
      ],
      changed: [false, true],
    };
    const groups = groupDuplicatesByAdded([f]);
    expect(groups[0].added.file).toBe('added.ts');
    expect(groups[0].twins[0].anchor.file).toBe('existing.ts');
  });
});
