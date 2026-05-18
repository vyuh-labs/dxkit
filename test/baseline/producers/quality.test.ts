import { describe, it, expect } from 'vitest';
import {
  duplicationToBaselineEntries,
  staleFilesToBaselineEntries,
} from '../../../src/baseline/producers/quality';
import { identityFor } from '../../../src/baseline/finding-identity';
import type {
  DuplicationClone,
  DuplicationResult,
} from '../../../src/languages/capabilities/types';

function clone(over: Partial<DuplicationClone> = {}): DuplicationClone {
  return {
    lines: 10,
    tokens: 80,
    a: { file: 'src/a.ts', startLine: 1, endLine: 10 },
    b: { file: 'src/b.ts', startLine: 5, endLine: 14 },
    ...over,
  };
}

function emptyDup(over: Partial<DuplicationResult> = {}): DuplicationResult {
  return {
    schemaVersion: 1,
    tool: 'jscpd',
    totalLines: 1000,
    duplicatedLines: 0,
    percentage: 0,
    cloneCount: 0,
    topClones: [],
    ...over,
  };
}

describe('duplicationToBaselineEntries', () => {
  it('emits nothing when the envelope is absent', () => {
    expect(duplicationToBaselineEntries(undefined)).toEqual([]);
  });

  it('emits nothing when no clones reported', () => {
    expect(duplicationToBaselineEntries(emptyDup())).toEqual([]);
  });

  it('maps each clone to a duplication entry with canonical identity', () => {
    const c = clone();
    const entries = duplicationToBaselineEntries(emptyDup({ topClones: [c] }));
    expect(entries).toHaveLength(1);
    const e = entries[0];
    if (e.kind !== 'duplication') throw new Error('shape');
    expect(e.fileA).toBe(c.a.file);
    expect(e.fileB).toBe(c.b.file);
    expect(e.lines).toBe(c.lines);
    expect(e.startLineA).toBe(c.a.startLine);
    expect(e.startLineB).toBe(c.b.startLine);
    expect(e.id).toBe(
      identityFor({
        kind: 'duplication',
        fileA: c.a.file,
        fileB: c.b.file,
        lines: c.lines,
        startLineA: c.a.startLine,
        startLineB: c.b.startLine,
      }),
    );
  });

  it('produces the same identity when the clone is reported with swapped sides', () => {
    const ab = clone();
    const ba = clone({ a: ab.b, b: ab.a });
    const [eAB] = duplicationToBaselineEntries(emptyDup({ topClones: [ab] }));
    const [eBA] = duplicationToBaselineEntries(emptyDup({ topClones: [ba] }));
    expect(eAB.id).toBe(eBA.id);
  });

  it('distinguishes intra-file clones at different positions (D142 closure)', () => {
    const intraA = clone({
      a: { file: 'src/big.ts', startLine: 100, endLine: 160 },
      b: { file: 'src/big.ts', startLine: 250, endLine: 310 },
    });
    const intraB = clone({
      a: { file: 'src/big.ts', startLine: 500, endLine: 560 },
      b: { file: 'src/big.ts', startLine: 700, endLine: 760 },
    });
    const [eA] = duplicationToBaselineEntries(emptyDup({ topClones: [intraA] }));
    const [eB] = duplicationToBaselineEntries(emptyDup({ topClones: [intraB] }));
    expect(eA.id).not.toBe(eB.id);
  });

  it('identity changes when the block grows or shrinks (D142 closure)', () => {
    const small = clone({ lines: 30 });
    const big = clone({ lines: 80 });
    const [eS] = duplicationToBaselineEntries(emptyDup({ topClones: [small] }));
    const [eB] = duplicationToBaselineEntries(emptyDup({ topClones: [big] }));
    expect(eS.id).not.toBe(eB.id);
  });

  it('three intra-file clones at distinct positions produce three distinct ids', () => {
    const clones = [
      clone({
        a: { file: 'src/big.ts', startLine: 100, endLine: 180 },
        b: { file: 'src/big.ts', startLine: 250, endLine: 330 },
      }),
      clone({
        a: { file: 'src/big.ts', startLine: 500, endLine: 580 },
        b: { file: 'src/big.ts', startLine: 700, endLine: 780 },
      }),
      clone({
        a: { file: 'src/big.ts', startLine: 900, endLine: 980 },
        b: { file: 'src/big.ts', startLine: 1200, endLine: 1280 },
      }),
    ];
    const entries = duplicationToBaselineEntries(emptyDup({ topClones: clones }));
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(3);
  });
});

describe('staleFilesToBaselineEntries', () => {
  it('emits nothing for an empty list', () => {
    expect(staleFilesToBaselineEntries([])).toEqual([]);
  });

  it('emits one entry per stale file with the lowercase suffix', () => {
    const entries = staleFilesToBaselineEntries([
      'src/.foo.ts.swp',
      'docs/README.bak',
      'tmp/old.ORIG',
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['stale-file', 'stale-file', 'stale-file']);
    if (entries[0].kind !== 'stale-file') throw new Error('shape');
    expect(entries[0].suffix).toBe('swp');
    if (entries[1].kind !== 'stale-file') throw new Error('shape');
    expect(entries[1].suffix).toBe('bak');
    if (entries[2].kind !== 'stale-file') throw new Error('shape');
    expect(entries[2].suffix).toBe('orig');
  });

  it('skips files whose suffix is not in the canonical stale set', () => {
    const entries = staleFilesToBaselineEntries(['src/index.ts', 'README.md']);
    expect(entries).toEqual([]);
  });

  it('skips files with no extension', () => {
    const entries = staleFilesToBaselineEntries(['Makefile']);
    expect(entries).toEqual([]);
  });
});
