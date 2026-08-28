/**
 * The score projection (impact surface P2): pure core + IO wrapper seams.
 *
 * Pins the honesty constraints as behavior:
 *
 *   - methodology guard BOTH directions: same version projects; a different
 *     or absent version discloses "not comparable" and diffs nothing;
 *   - base-from-snapshot: the base side is the history's latest entry, and
 *     a missing/empty history is a disclosed unavailable, never an invented
 *     base;
 *   - reuse-first: the wrapper never builds an analysis (peek-only), and
 *     when there is no shared envelope it does not even read the history
 *     (no network fetch on the path that cannot project);
 *   - the policy knob both values (default on; `false` disables with a
 *     disclosed status);
 *   - one phrasing: every rendered form labels the number projected, zero
 *     is reported as zero, unmeasured dimensions are named.
 */
import { describe, it, expect } from 'vitest';
import {
  computeScoreProjection,
  formatScoreProjection,
  gatherScoreProjection,
  impactProjectionMarker,
  impactScoreInputsFromReport,
  parseImpactProjectionMarker,
  type ScoreProjection,
} from '../../src/baseline/impact-projection';
import { SCORING_METHODOLOGY_VERSION } from '../../src/scoring/methodology';
import type { ReportHistoryEntry, ReportScores } from '../../src/reports/history';
import type { HealthReport } from '../../src/analyzers/types';

function scores(overrides: Partial<ReportScores> = {}): ReportScores {
  return {
    overall: 50,
    security: 40,
    quality: 60,
    tests: 55,
    documentation: 30,
    maintainability: 70,
    developerExperience: 65,
    ...overrides,
  };
}

function entry(overrides: Partial<ReportHistoryEntry> = {}): ReportHistoryEntry {
  return {
    sha: 'aaaabbbbccccdddd',
    date: '2026-08-20T00:00:00.000Z',
    dxkitVersion: '4.4.7',
    methodology: SCORING_METHODOLOGY_VERSION,
    scores: scores(),
    ...overrides,
  };
}

describe('computeScoreProjection (pure core)', () => {
  it('projects per-dimension deltas against the latest snapshot under a matching methodology', () => {
    const projection = computeScoreProjection({
      current: scores({ security: 46, overall: 52 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [entry({ sha: 'older', scores: scores({ security: 10 }) }), entry()],
    });
    expect(projection.status).toBe('projected');
    if (projection.status !== 'projected') return;
    // The base is the LATEST entry, not an older one.
    expect(projection.base.sha).toBe('aaaabbbbccccdddd');
    const security = projection.deltas.find((d) => d.key === 'security');
    expect(security).toEqual({ key: 'security', from: 40, to: 46, delta: 6 });
    // Zero movement is present as zero, never dropped.
    const quality = projection.deltas.find((d) => d.key === 'quality');
    expect(quality).toEqual({ key: 'quality', from: 60, to: 60, delta: 0 });
  });

  it('discloses a methodology MISMATCH as not comparable and diffs nothing', () => {
    const projection = computeScoreProjection({
      current: scores({ security: 46 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [entry({ methodology: 'spec-v0' })],
    });
    expect(projection.status).toBe('not-comparable');
    if (projection.status !== 'not-comparable') return;
    expect(projection.reason).toContain("'spec-v0'");
    expect(projection.reason).toContain(`'${SCORING_METHODOLOGY_VERSION}'`);
  });

  it('treats an UNSTAMPED base snapshot as not comparable (absent evidence is not evidence)', () => {
    const unstamped: ReportHistoryEntry = {
      sha: entry().sha,
      date: entry().date,
      dxkitVersion: entry().dxkitVersion,
      scores: scores(),
    };
    const projection = computeScoreProjection({
      current: scores(),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [unstamped],
    });
    expect(projection.status).toBe('not-comparable');
    if (projection.status !== 'not-comparable') return;
    expect(projection.reason).toContain('predates scoring-methodology stamping');
  });

  it('score-input drift => not comparable, naming the moved input, both directions', () => {
    const gone = computeScoreProjection({
      current: scores({ security: 46 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      inputs: ['grep-secrets', 'semgrep'],
      history: [entry({ scoreInputs: ['gitleaks', 'semgrep'] })],
    });
    expect(gone.status).toBe('not-comparable');
    if (gone.status !== 'not-comparable') return;
    expect(gone.reason).toContain('gitleaks');
    expect(gone.reason).toContain('grep-secrets');

    const added = computeScoreProjection({
      current: scores({ security: 46 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      inputs: ['gitleaks', 'semgrep', '!osv-scanner'],
      history: [entry({ scoreInputs: ['gitleaks', 'semgrep'] })],
    });
    expect(added.status).toBe('not-comparable');
    if (added.status !== 'not-comparable') return;
    expect(added.reason).toContain('!osv-scanner');
  });

  it('matching score inputs project; an unstamped side defers to the methodology guard', () => {
    const matching = computeScoreProjection({
      current: scores({ security: 46 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      inputs: ['gitleaks', 'semgrep'],
      history: [entry({ scoreInputs: ['gitleaks', 'semgrep'] })],
    });
    expect(matching.status).toBe('projected');
    // A base entry without the stamp (methodology present, inputs absent:
    // theoretical) never claims drift it cannot see.
    const unstamped = computeScoreProjection({
      current: scores({ security: 46 }),
      methodology: SCORING_METHODOLOGY_VERSION,
      inputs: ['gitleaks'],
      history: [entry()],
    });
    expect(unstamped.status).toBe('projected');
  });

  it('discloses an empty history as unavailable, never inventing a base', () => {
    const projection = computeScoreProjection({
      current: scores(),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [],
    });
    expect(projection.status).toBe('unavailable');
    if (projection.status !== 'unavailable') return;
    expect(projection.reason).toContain('no score history');
  });
});

describe('gatherScoreProjection (IO wrapper seams)', () => {
  const report = {
    dimensions: {
      security: { score: 46, capsApplied: [], topActions: [] },
      quality: { score: 60 },
      testing: { score: 55 },
      documentation: { score: 30 },
      maintainability: { score: 70 },
      developerExperience: { score: 65 },
    },
    summary: { overallScore: 52 },
  } as unknown as HealthReport;

  it('policy knob false => disabled, and neither the envelope nor the history is touched', async () => {
    let peeked = 0;
    let read = 0;
    const out = await gatherScoreProjection(
      '/nowhere',
      { impact: { projectScores: false } },
      {
        peek: async () => {
          peeked += 1;
          return { report };
        },
        readHistory: () => {
          read += 1;
          return [entry()];
        },
      },
    );
    expect(out.projection.status).toBe('disabled');
    expect(out.scoreInputs).toBeUndefined();
    expect(peeked).toBe(0);
    expect(read).toBe(0);
  });

  it('knob absent (default on) => projects when the envelope and a comparable snapshot exist', async () => {
    const out = await gatherScoreProjection(
      '/nowhere',
      {},
      {
        peek: async () => ({ report }),
        readHistory: () => [entry()],
      },
    );
    expect(out.projection.status).toBe('projected');
    if (out.projection.status !== 'projected') return;
    const security = out.projection.deltas.find((d) => d.key === 'security');
    expect(security?.delta).toBe(6);
    // Same-run score inputs (the cap-aware slot) come out beside it.
    expect(out.scoreInputs?.map((s) => s.dimension)).toContain('security');
  });

  it('no shared envelope => disclosed unavailable, and the history is NOT read (no fetch on a path that cannot project)', async () => {
    let read = 0;
    const out = await gatherScoreProjection(
      '/nowhere',
      {},
      {
        peek: async () => null,
        readHistory: () => {
          read += 1;
          return [entry()];
        },
      },
    );
    expect(out.projection.status).toBe('unavailable');
    if (out.projection.status !== 'unavailable') return;
    expect(out.projection.reason).toContain('no full shared analysis');
    expect(read).toBe(0);
  });

  it('ref-based mode => quiet structural unavailable: JSON disclosure, no human line, no work', async () => {
    let peeked = 0;
    let read = 0;
    const out = await gatherScoreProjection(
      '/nowhere',
      {},
      {
        peek: async () => {
          peeked += 1;
          return { report };
        },
        readHistory: () => {
          read += 1;
          return [entry()];
        },
      },
      'ref-based',
    );
    expect(out.projection.status).toBe('unavailable');
    if (out.projection.status !== 'unavailable') return;
    expect(out.projection.reason).toContain('ref-based mode');
    expect(out.projection.reason).toContain('impact.projectScores');
    expect(out.projection.quiet).toBe(true);
    // The human line is suppressed; the JSON keeps the disclosure.
    expect(formatScoreProjection(out.projection)).toBeNull();
    expect(peeked).toBe(0);
    expect(read).toBe(0);
    // A committed mode takes the normal path.
    const committed = await gatherScoreProjection(
      '/nowhere',
      {},
      { peek: async () => ({ report }), readHistory: () => [entry()] },
      'committed-full',
    );
    expect(committed.projection.status).toBe('projected');
  });

  it('a throwing seam degrades to a disclosed unavailable, never an exception into the gate', async () => {
    const out = await gatherScoreProjection(
      '/nowhere',
      {},
      {
        peek: async () => {
          throw new Error('boom from the envelope');
        },
        readHistory: () => [],
      },
    );
    expect(out.projection.status).toBe('unavailable');
    if (out.projection.status !== 'unavailable') return;
    expect(out.projection.reason).toContain('boom from the envelope');
  });
});

describe('impactScoreInputsFromReport', () => {
  it('maps report dimensions onto the durable score-key vocabulary (testing -> tests)', () => {
    const report = {
      dimensions: {
        security: { score: 40, capsApplied: [{ id: 'x' }], topActions: [] },
        testing: { score: 55 },
      },
      summary: { overallScore: 50 },
    } as unknown as HealthReport;
    const inputs = impactScoreInputsFromReport(report);
    expect(inputs.map((i) => i.dimension)).toEqual(['security', 'tests']);
    expect(inputs[0]?.capsApplied).toHaveLength(1);
  });
});

describe('formatScoreProjection (one phrasing)', () => {
  function projected(current: Partial<ReportScores>): ScoreProjection {
    return computeScoreProjection({
      current: scores(current),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [entry()],
    });
  }

  it('movement: names the moved dimension, labels it projected, folds the flat rest', () => {
    const line = formatScoreProjection(projected({ security: 46 }));
    expect(line).toBe('security 40 -> 46 (projected) · other dimensions unchanged');
  });

  it('zero movement is reported as zero, still labeled projected', () => {
    expect(formatScoreProjection(projected({}))).toBe('scores unchanged (projected)');
  });

  it('an unmeasured dimension is named, never silently dropped', () => {
    const line = formatScoreProjection(projected({ security: 46, tests: null }));
    expect(line).toContain('security 40 -> 46 (projected)');
    expect(line).toContain('tests not projected (unmeasured)');
  });

  it('not-comparable and unavailable render their disclosure; disabled renders nothing', () => {
    expect(formatScoreProjection({ status: 'not-comparable', reason: 'versions differ' })).toBe(
      'scores not comparable this PR: versions differ',
    );
    expect(formatScoreProjection({ status: 'unavailable', reason: 'no history' })).toBe(
      'scores not projected: no history',
    );
    expect(
      formatScoreProjection({ status: 'unavailable', reason: 'structural', quiet: true }),
    ).toBeNull();
    expect(formatScoreProjection({ status: 'disabled', reason: 'off' })).toBeNull();
  });
});

describe('the projection marker codec', () => {
  it('round-trips measured dimensions + methodology through the hidden marker', () => {
    const projection = computeScoreProjection({
      current: scores({ security: 46, tests: null }),
      methodology: SCORING_METHODOLOGY_VERSION,
      history: [entry({ scores: scores({ tests: null }) })],
    });
    const marker = impactProjectionMarker(projection);
    expect(marker).not.toBeNull();
    const parsed = parseImpactProjectionMarker(`prefix text\n${marker}\nsuffix`);
    expect(parsed?.methodology).toBe(SCORING_METHODOLOGY_VERSION);
    expect(parsed?.scores.security).toEqual({ from: 40, to: 46 });
    // Unmeasured on either side never enters the marker.
    expect(parsed?.scores.tests).toBeUndefined();
    // Overall stays out (a P3 concern).
    expect(parsed?.scores.overall).toBeUndefined();
  });

  it('non-projected outcomes emit no marker; a malformed marker parses to null', () => {
    expect(impactProjectionMarker({ status: 'unavailable', reason: 'x' })).toBeNull();
    expect(parseImpactProjectionMarker('no marker here')).toBeNull();
    expect(parseImpactProjectionMarker('<!-- dxkit-impact-projection not-json -->')).toBeNull();
    expect(
      parseImpactProjectionMarker('<!-- dxkit-impact-projection {"scores":{}} -->'),
    ).toBeNull();
  });
});
