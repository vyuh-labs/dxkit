/**
 * The trend surface model (impact P3, #332): segmentation at comparability
 * boundaries, the fixed-scale sparkline, the since-install context, and the
 * one phrasing every surface composes.
 *
 * The comparability discipline is the projection's, reused: adjacent
 * snapshots segment together only under a matching methodology stamp and
 * matching score inputs, and the trend NEVER claims movement across a
 * boundary (the observed 0 -> 20 -> 0 cross-version blip from #332 is the
 * class this pins shut).
 */
import { describe, it, expect } from 'vitest';
import {
  computeTrendContext,
  describeTrendBoundary,
  formatTrendContext,
  segmentHistory,
  sparkline,
} from '../../src/reports/trend';
import type { ReportHistoryEntry, ReportScores } from '../../src/reports/history';

function scores(overrides: Partial<ReportScores> = {}): ReportScores {
  return {
    overall: 24,
    security: 40,
    quality: 60,
    tests: 55,
    documentation: 30,
    maintainability: 70,
    developerExperience: 65,
    ...overrides,
  };
}

let seq = 0;
function entry(overrides: Partial<ReportHistoryEntry> = {}): ReportHistoryEntry {
  seq += 1;
  return {
    sha: `sha-${seq}`,
    date: `2026-07-${String(Math.min(seq, 28)).padStart(2, '0')}T00:00:00.000Z`,
    dxkitVersion: '4.4.7',
    methodology: 'spec-v1',
    scoreInputs: ['gitleaks', 'semgrep'],
    scores: scores(),
    ...overrides,
  };
}

/** A pre-stamping entry: no methodology, no scoreInputs. */
function unstampedEntry(overrides: Partial<ReportHistoryEntry> = {}): ReportHistoryEntry {
  seq += 1;
  return {
    sha: 'sha-u-' + String(seq),
    date: '2026-06-' + String(Math.min(seq, 28)).padStart(2, '0') + 'T00:00:00.000Z',
    dxkitVersion: '4.3.8',
    scores: scores(),
    ...overrides,
  };
}

describe('segmentHistory (the comparability discipline applied to a series)', () => {
  it('a uniform series is one segment with its methodology', () => {
    const segments = segmentHistory([entry(), entry(), entry()]);
    expect(segments).toHaveLength(1);
    expect(segments[0].entries).toHaveLength(3);
    expect(segments[0].methodology).toBe('spec-v1');
    expect(segments[0].unverified).toBeUndefined();
    expect(segments[0].boundary).toBeUndefined();
  });

  it('a methodology change splits, and the boundary names both versions', () => {
    const segments = segmentHistory([
      entry(),
      entry(),
      entry({ methodology: 'spec-v2' }),
      entry({ methodology: 'spec-v2' }),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0].entries).toHaveLength(2);
    expect(segments[1].entries).toHaveLength(2);
    expect(segments[1].boundary).toContain('scoring methodology changed');
    expect(segments[1].boundary).toContain("'spec-v1'");
    expect(segments[1].boundary).toContain("'spec-v2'");
  });

  it('score-input drift splits under one methodology, naming the moved input', () => {
    const segments = segmentHistory([
      entry(),
      entry({ scoreInputs: ['semgrep'] }), // gitleaks fell out
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[1].boundary).toContain('tools behind the scores differ');
    expect(segments[1].boundary).toContain('gitleaks');
  });

  it('unstamped (pre-stamping) entries group together, marked unverified; the stamp transition is a boundary', () => {
    const segments = segmentHistory([unstampedEntry(), unstampedEntry(), entry()]);
    expect(segments).toHaveLength(2);
    expect(segments[0].unverified).toBe(true);
    expect(segments[0].methodology).toBeUndefined();
    expect(segments[1].boundary).toContain('unstamped');
  });

  it('empty history yields no segments', () => {
    expect(segmentHistory([])).toEqual([]);
  });
});

describe('describeTrendBoundary (the ONE adjacency predicate)', () => {
  it('comparable adjacents => null; unstamped inputs on either side claim no drift', () => {
    expect(describeTrendBoundary(entry(), entry())).toBeNull();
    const noInputs = entry();
    const sameMethodNoInputs: ReportHistoryEntry = {
      sha: noInputs.sha,
      date: noInputs.date,
      dxkitVersion: noInputs.dxkitVersion,
      methodology: noInputs.methodology,
      scores: noInputs.scores,
    };
    expect(describeTrendBoundary(sameMethodNoInputs, entry())).toBeNull();
  });
});

describe('sparkline (fixed honest scale)', () => {
  it('scores map on a fixed 0..100 scale: 0 is the lowest block, 100 the highest', () => {
    expect(sparkline([0, 100])).toBe('▁█');
    // A small wiggle stays low on the absolute scale, never a mountain.
    expect(sparkline([24, 26])).toBe('▂▃');
  });

  it('null (unmeasured) renders as a dot, never as zero', () => {
    expect(sparkline([50, null, 50])).toBe('▅·▅');
  });

  it('count series scale to their own max via the max option', () => {
    expect(sparkline([0, 3, 6], { max: 6 })).toBe('▁▅█');
  });

  it('out-of-range values clamp instead of throwing', () => {
    expect(sparkline([120, -5])).toBe('█▁');
  });
});

describe('computeTrendContext', () => {
  it('null on empty history (no line is invented)', () => {
    expect(computeTrendContext([])).toBeNull();
  });

  it('a flat since-install series: anchor is the FIRST entry, direction flat, no improvement on record', () => {
    const ctx = computeTrendContext([
      entry({ date: '2026-07-20T00:00:00.000Z' }),
      entry(),
      entry(),
    ]);
    expect(ctx).toMatchObject({
      overall: 24,
      from: 24,
      direction: 'flat',
      sinceDate: '2026-07-20',
      sinceInstall: true,
      snapshots: 3,
      totalSnapshots: 3,
      improvementOnRecord: false,
    });
  });

  it('rising and falling series carry both ends and the direction', () => {
    const up = computeTrendContext([
      entry({ scores: scores({ overall: 24 }) }),
      entry({ scores: scores({ overall: 30 }) }),
    ]);
    expect(up).toMatchObject({ direction: 'up', from: 24, overall: 30, improvementOnRecord: true });
    const down = computeTrendContext([
      entry({ scores: scores({ overall: 30 }) }),
      entry({ scores: scores({ overall: 20 }) }),
    ]);
    expect(down).toMatchObject({ direction: 'down', from: 30, overall: 20 });
  });

  it('a segmented series anchors on the LATEST comparable segment and discloses the partial window', () => {
    const ctx = computeTrendContext([
      entry({ date: '2026-07-01T00:00:00.000Z' }),
      entry({ date: '2026-07-10T00:00:00.000Z' }),
      entry({ date: '2026-08-01T00:00:00.000Z', methodology: 'spec-v2' }),
      entry({ date: '2026-08-10T00:00:00.000Z', methodology: 'spec-v2' }),
    ]);
    expect(ctx).toMatchObject({
      sinceDate: '2026-08-01',
      sinceInstall: false,
      snapshots: 2,
      totalSnapshots: 4,
    });
  });

  it('a cross-boundary increase is NOT an improvement on record; a within-segment one is', () => {
    // 0 -> 20 across a methodology bump (the #332 blip): not real movement.
    const acrossOnly = computeTrendContext([
      entry({ scores: scores({ overall: 0 }) }),
      entry({ methodology: 'spec-v2', scores: scores({ overall: 20 }) }),
    ]);
    expect(acrossOnly?.improvementOnRecord).toBe(false);
    // The same increase inside one segment counts, even in an OLDER segment.
    const withinOld = computeTrendContext([
      entry({ scores: scores({ overall: 10 }) }),
      entry({ scores: scores({ overall: 20 }) }),
      entry({ methodology: 'spec-v2', scores: scores({ overall: 20 }) }),
    ]);
    expect(withinOld?.improvementOnRecord).toBe(true);
  });

  it('an unverified latest segment carries the caveat flag', () => {
    const ctx = computeTrendContext([unstampedEntry()]);
    expect(ctx?.unverified).toBe(true);
  });
});

describe('formatTrendContext (one phrasing, every surface)', () => {
  const flat = computeTrendContext([
    entry({ date: '2026-07-20T00:00:00.000Z' }),
    ...Array.from({ length: 15 }, () => entry()),
  ])!;

  it('the flat since-install form matches the design sketch', () => {
    expect(formatTrendContext(flat)).toBe(
      'Repo trend: overall 24, flat since 2026-07-20 (16 snapshots)',
    );
  });

  it('up and down name both ends', () => {
    const up = computeTrendContext([
      entry({ date: '2026-07-20T00:00:00.000Z', scores: scores({ overall: 24 }) }),
      entry({ scores: scores({ overall: 30 }) }),
    ])!;
    expect(formatTrendContext(up)).toBe(
      'Repo trend: overall 30, up from 24 since 2026-07-20 (2 snapshots)',
    );
  });

  it('a partial (post-boundary) window is disclosed, never presented as since install', () => {
    const ctx = computeTrendContext([
      entry({ date: '2026-07-01T00:00:00.000Z' }),
      entry({ date: '2026-08-01T00:00:00.000Z', methodology: 'spec-v2' }),
      entry({ date: '2026-08-10T00:00:00.000Z', methodology: 'spec-v2' }),
    ])!;
    expect(formatTrendContext(ctx)).toContain('since 2026-08-01');
    expect(formatTrendContext(ctx)).toContain('2 of 3 snapshots');
    expect(formatTrendContext(ctx)).toContain('earlier ones scored under different methodology');
  });

  it('one snapshot on record reads as exactly that', () => {
    const ctx = computeTrendContext([entry({ date: '2026-07-20T00:00:00.000Z' })])!;
    expect(formatTrendContext(ctx)).toBe(
      'Repo trend: overall 24, one snapshot on record (2026-07-20)',
    );
  });

  it('the first-improvement claim is conditional: positive projected overall AND no improvement on record', () => {
    expect(formatTrendContext(flat, { projectedOverallDelta: 2 })).toContain(
      '; this PR would be the first improvement on record',
    );
    expect(formatTrendContext(flat, { projectedOverallDelta: 0 })).not.toContain(
      'first improvement',
    );
    expect(formatTrendContext(flat, { projectedOverallDelta: -1 })).not.toContain(
      'first improvement',
    );
    expect(
      formatTrendContext({ ...flat, improvementOnRecord: true }, { projectedOverallDelta: 2 }),
    ).not.toContain('first improvement');
  });

  it('an unverified segment appends the comparability caveat', () => {
    const a = unstampedEntry({ date: '2026-07-20T00:00:00.000Z' });
    const ctx = computeTrendContext([a, { ...a, sha: 'sha-x' }])!;
    expect(formatTrendContext(ctx)).toContain('comparability unverified');
  });
});
