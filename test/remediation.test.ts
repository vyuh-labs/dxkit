import { describe, it, expect } from 'vitest';
import { rank, RemediationAction } from '../src/analyzers/remediation';

/** Toy metric + scorer used to exercise the generic. */
interface ToyMetrics {
  bugs: number;
  warnings: number;
}

function toyScorer(m: ToyMetrics): { score: number } {
  // 100 baseline; -2 per bug, -1 per warning; clamped to 0.
  return { score: Math.max(0, 100 - m.bugs * 2 - m.warnings) };
}

describe('rank()', () => {
  it('sorts actions by score delta descending', () => {
    const actions: RemediationAction<ToyMetrics>[] = [
      {
        id: 'fix-one-warning',
        title: 'Fix 1 warning',
        evidence: [],
        patch: (m) => ({ ...m, warnings: m.warnings - 1 }),
      },
      {
        id: 'fix-all-bugs',
        title: 'Fix 10 bugs',
        evidence: [],
        patch: (m) => ({ ...m, bugs: 0 }),
      },
      {
        id: 'fix-some-bugs',
        title: 'Fix 3 bugs',
        evidence: [],
        patch: (m) => ({ ...m, bugs: m.bugs - 3 }),
      },
    ];
    const ranked = rank(actions, { bugs: 10, warnings: 5 }, toyScorer);
    expect(ranked.map((a) => a.id)).toEqual(['fix-all-bugs', 'fix-some-bugs', 'fix-one-warning']);
    expect(ranked[0].scoreDelta).toBe(20); // removes 10 bugs × 2
    expect(ranked[1].scoreDelta).toBe(6); // removes 3 bugs × 2
    expect(ranked[2].scoreDelta).toBe(1); // removes 1 warning
  });

  it('attaches baseline and projected scores', () => {
    const baseline = { bugs: 10, warnings: 5 }; // score = 100 - 20 - 5 = 75
    const actions: RemediationAction<ToyMetrics>[] = [
      {
        id: 'zero-bugs',
        title: 'Zero bugs',
        evidence: [],
        patch: (m) => ({ ...m, bugs: 0 }),
      },
    ];
    const ranked = rank(actions, baseline, toyScorer);
    expect(ranked[0].baselineScore).toBe(75);
    expect(ranked[0].projectedScore).toBe(95);
    expect(ranked[0].scoreDelta).toBe(20);
  });

  it('filters out negative-delta actions', () => {
    const actions: RemediationAction<ToyMetrics>[] = [
      {
        id: 'makes-it-worse',
        title: 'Add bugs',
        evidence: [],
        patch: (m) => ({ ...m, bugs: m.bugs + 5 }),
      },
      {
        id: 'genuine-fix',
        title: 'Fix bugs',
        evidence: [],
        patch: (m) => ({ ...m, bugs: 0 }),
      },
    ];
    const ranked = rank(actions, { bugs: 10, warnings: 0 }, toyScorer);
    expect(ranked.map((a) => a.id)).toEqual(['genuine-fix']);
  });

  it('keeps zero-delta actions (they are still hygienic)', () => {
    const noOp: RemediationAction<ToyMetrics> = {
      id: 'no-op',
      title: 'Rename variable',
      evidence: [],
      patch: (m) => ({ ...m }),
    };
    const ranked = rank([noOp], { bugs: 0, warnings: 0 }, toyScorer);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].scoreDelta).toBe(0);
  });

  it('empty action list returns empty', () => {
    expect(rank([], { bugs: 5, warnings: 5 }, toyScorer)).toEqual([]);
  });

  it('does not mutate input metrics (patch is pure)', () => {
    const input = { bugs: 10, warnings: 5 };
    const action: RemediationAction<ToyMetrics> = {
      id: 'fix',
      title: 'Fix',
      evidence: [],
      patch: (m) => ({ ...m, bugs: 0 }),
    };
    rank([action], input, toyScorer);
    expect(input).toEqual({ bugs: 10, warnings: 5 });
  });

  it('respects scorer clamping — delta never exceeds max', () => {
    // Bugs at 200 → score clamped at 0. Removing all bugs → 100 - 5 warnings = 95.
    const ranked = rank(
      [
        {
          id: 'mega-fix',
          title: 'Fix 200 bugs',
          evidence: [],
          patch: (m) => ({ ...m, bugs: 0 }),
        },
      ],
      { bugs: 200, warnings: 5 },
      toyScorer,
    );
    expect(ranked[0].baselineScore).toBe(0);
    expect(ranked[0].projectedScore).toBe(95);
    expect(ranked[0].scoreDelta).toBe(95);
  });
});
