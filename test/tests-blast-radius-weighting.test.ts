import { describe, it, expect } from 'vitest';
import { weightGapsByBlastRadius } from '../src/analyzers/tests/actions';
import { buildTestGapsDetailed } from '../src/analyzers/tests/detailed';
import type { SourceFile, TestGapsReport } from '../src/analyzers/tests/types';
import type { DetailedGraphContext } from '../src/explore/finding-context';
import type { FindingContext } from '../src/explore/queries';

function gap(path: string, lines: number, risk: SourceFile['risk']): SourceFile {
  return { path, lines, type: 'other', risk, hasMatchingTest: false };
}

function ctx(
  sourceFile: string,
  callerFiles: number,
  reliability?: FindingContext['callGraphReliability'],
): FindingContext {
  return {
    found: true,
    sourceFile,
    blastRadius: { callerFiles, callers: callerFiles, topCallerFiles: [] },
    ...(reliability ? { callGraphReliability: reliability } : {}),
  };
}

function graphContext(contexts: Record<string, FindingContext>): DetailedGraphContext {
  return { generatedAt: '2026-06-09T00:00:00Z', truncated: false, contexts };
}

describe('weightGapsByBlastRadius', () => {
  it('orders most-depended-on first within a tier (overriding LOC)', () => {
    // Small file with many callers should beat a big file with few callers.
    const gaps = [gap('src/big.ts', 500, 'high'), gap('src/hub.ts', 40, 'high')];
    const gc = graphContext({
      'src/big.ts': ctx('src/big.ts', 1),
      'src/hub.ts': ctx('src/hub.ts', 30),
    });
    const out = weightGapsByBlastRadius(gaps, gc);
    expect(out.map((g) => g.path)).toEqual(['src/hub.ts', 'src/big.ts']);
    expect(out[0].blastRadius).toBe(30);
  });

  it('keeps risk tier as the primary key', () => {
    const gaps = [gap('src/low-hub.ts', 10, 'low'), gap('src/crit-leaf.ts', 10, 'critical')];
    const gc = graphContext({
      'src/low-hub.ts': ctx('src/low-hub.ts', 99),
      'src/crit-leaf.ts': ctx('src/crit-leaf.ts', 0),
    });
    const out = weightGapsByBlastRadius(gaps, gc);
    // critical tier outranks low regardless of blast radius
    expect(out[0].path).toBe('src/crit-leaf.ts');
  });

  it('treats an unreliable call graph as UNKNOWN (no blastRadius stamped, LOC fallback)', () => {
    const gaps = [gap('a.cs', 100, 'high'), gap('b.cs', 300, 'high')];
    const gc = graphContext({
      'a.cs': ctx('a.cs', 0, 'unreliable'),
      'b.cs': ctx('b.cs', 0, 'unreliable'),
    });
    const out = weightGapsByBlastRadius(gaps, gc);
    // No trustworthy blast radius → fall back to LOC desc (today's behavior)
    expect(out.map((g) => g.path)).toEqual(['b.cs', 'a.cs']);
    expect(out[0].blastRadius).toBeUndefined();
    expect(out[1].blastRadius).toBeUndefined();
  });

  it('ranks known-blast files ahead of graph-unknown files, then by LOC', () => {
    const gaps = [
      gap('src/known.ts', 10, 'medium'), // in graph, 5 callers
      gap('src/unknown-big.ts', 400, 'medium'), // not in graph
      gap('src/unknown-small.ts', 20, 'medium'), // not in graph
    ];
    const gc = graphContext({ 'src/known.ts': ctx('src/known.ts', 5) });
    const out = weightGapsByBlastRadius(gaps, gc);
    expect(out.map((g) => g.path)).toEqual([
      'src/known.ts', // confirmed impact first
      'src/unknown-big.ts', // unknowns fall back to LOC desc
      'src/unknown-small.ts',
    ]);
  });
});

describe('buildTestGapsDetailed — weighting is score-invariant (A/B)', () => {
  function report(gaps: SourceFile[]): TestGapsReport {
    const byRisk = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const g of gaps) byRisk[g.risk]++;
    return {
      repo: 'r',
      analyzedAt: '2026-06-09T00:00:00Z',
      commitSha: 'abc',
      branch: 'main',
      summary: {
        testFiles: 1,
        activeTestFiles: 1,
        commentedOutFiles: 0,
        effectiveCoverage: 40,
        coverageSource: 'import-graph',
        coverageFidelity: 'import-graph',
        sourceFiles: 10,
        untestedCritical: byRisk.critical,
        untestedHigh: byRisk.high,
        untestedMedium: byRisk.medium,
        untestedLow: byRisk.low,
      },
      testFiles: [],
      gaps,
      toolsUsed: ['find'],
      toolsUnavailable: [],
    } as TestGapsReport;
  }

  it('produces an IDENTICAL coverageScore with vs without graph context, but reorders gaps', () => {
    const gaps = [gap('src/big.ts', 500, 'high'), gap('src/hub.ts', 40, 'high')];
    const gc = graphContext({
      'src/big.ts': ctx('src/big.ts', 1),
      'src/hub.ts': ctx('src/hub.ts', 30),
    });

    const withoutGraph = buildTestGapsDetailed(report(gaps));
    const withGraph = buildTestGapsDetailed(report(gaps), gc);

    // The score is byte-stable — weighting can never move the Tests dimension.
    expect(withGraph.coverageScore).toBe(withoutGraph.coverageScore);
    // But the worklist reorders: the 30-caller hub leads, not the 500-line file.
    expect(withoutGraph.gaps.map((g) => g.path)).toEqual(['src/big.ts', 'src/hub.ts']);
    expect(withGraph.gaps.map((g) => g.path)).toEqual(['src/hub.ts', 'src/big.ts']);
  });
});
