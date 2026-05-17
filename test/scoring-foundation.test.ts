import { describe, expect, it } from 'vitest';

import {
  CAP_TIERS,
  evaluateSpec,
  RATING_THRESHOLDS,
  ratingFromScore,
  type DimensionScoringSpec,
} from '../src/scoring';

// Pure-function evaluator tests. Foundation only — per-dimension specs
// land in later commits; here we exercise the engine using synthetic
// specs.

interface Toy {
  errors: number;
  hasSecret: boolean;
  toolMissing: boolean;
  open: boolean;
}

function toyInput(overrides: Partial<Toy> = {}): Toy {
  return {
    errors: 0,
    hasSecret: false,
    toolMissing: false,
    open: false,
    ...overrides,
  };
}

const TOY_SPEC: DimensionScoringSpec<Toy> = {
  dimension: 'toy',
  methodology: 'test-only',
  baseline: 100,
  penalties: [
    {
      id: 'error-density',
      describe: (i) => `${i.errors} error(s) detected`,
      applies: (i) => i.errors > 0,
      delta: (i) => -Math.min(50, i.errors * 5),
    },
  ],
  caps: [
    {
      id: 'secret-present',
      tier: 'trust-broken',
      describe: () => 'a secret is committed to source',
      applies: (i) => i.hasSecret,
    },
    {
      id: 'tool-missing',
      tier: 'uncertainty',
      describe: () => 'scanner did not run',
      applies: (i) => i.toolMissing,
    },
    {
      id: 'finding-open',
      tier: 'fixable-finding',
      describe: () => 'a HIGH+ finding is open',
      applies: (i) => i.open,
    },
  ],
};

describe('ratingFromScore', () => {
  it('maps numeric scores to uniform letter ratings at 80/60/40/20', () => {
    expect(ratingFromScore(100)).toBe('A');
    expect(ratingFromScore(80)).toBe('A');
    expect(ratingFromScore(79)).toBe('B');
    expect(ratingFromScore(60)).toBe('B');
    expect(ratingFromScore(59)).toBe('C');
    expect(ratingFromScore(40)).toBe('C');
    expect(ratingFromScore(39)).toBe('D');
    expect(ratingFromScore(20)).toBe('D');
    expect(ratingFromScore(19)).toBe('E');
    expect(ratingFromScore(0)).toBe('E');
  });

  it('matches the RATING_THRESHOLDS table exactly at boundaries', () => {
    expect(ratingFromScore(RATING_THRESHOLDS.A)).toBe('A');
    expect(ratingFromScore(RATING_THRESHOLDS.A - 1)).toBe('B');
    expect(ratingFromScore(RATING_THRESHOLDS.B)).toBe('B');
    expect(ratingFromScore(RATING_THRESHOLDS.B - 1)).toBe('C');
    expect(ratingFromScore(RATING_THRESHOLDS.C)).toBe('C');
    expect(ratingFromScore(RATING_THRESHOLDS.C - 1)).toBe('D');
    expect(ratingFromScore(RATING_THRESHOLDS.D)).toBe('D');
    expect(ratingFromScore(RATING_THRESHOLDS.D - 1)).toBe('E');
  });
});

describe('CAP_TIERS taxonomy', () => {
  it('orders tiers by severity (lower ceiling = more serious)', () => {
    expect(CAP_TIERS.unmeasured).toBeLessThan(CAP_TIERS['trust-broken']);
    expect(CAP_TIERS['trust-broken']).toBeLessThan(CAP_TIERS.uncertainty);
    expect(CAP_TIERS.uncertainty).toBeLessThan(CAP_TIERS['partial-uncertainty']);
    expect(CAP_TIERS['partial-uncertainty']).toBeLessThan(CAP_TIERS['fixable-finding']);
  });

  it('every cap ceiling falls inside a rating band', () => {
    for (const ceiling of Object.values(CAP_TIERS)) {
      expect(ceiling).toBeGreaterThanOrEqual(0);
      expect(ceiling).toBeLessThanOrEqual(100);
    }
  });
});

describe('evaluateSpec — penalties', () => {
  it('returns baseline score with rating A when no rules apply', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput());
    expect(r.score).toBe(100);
    expect(r.rawScore).toBe(100);
    expect(r.rawPenalty).toBe(0);
    expect(r.rating).toBe('A');
    expect(r.deductions).toEqual([]);
    expect(r.capsApplied).toEqual([]);
    expect(r.topActions).toEqual([]);
  });

  it('applies penalties and records deductions with reasons + upliftIfFixed', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 3 }));
    expect(r.score).toBe(85);
    expect(r.rawScore).toBe(85);
    expect(r.rawPenalty).toBe(-15);
    expect(r.deductions).toHaveLength(1);
    expect(r.deductions[0].id).toBe('error-density');
    expect(r.deductions[0].delta).toBe(-15);
    expect(r.deductions[0].upliftIfFixed).toBe(15);
    expect(r.deductions[0].reason).toBe('3 error(s) detected');
  });

  it('respects per-rule delta caps inside the rule', () => {
    // The toy rule self-caps at -50 regardless of error count. rawScore
    // reflects post-rule delta, not raw error * 5.
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 30 }));
    expect(r.score).toBe(50);
    expect(r.rawScore).toBe(50);
    expect(r.deductions[0].delta).toBe(-50);
  });

  it('exposes negative rawScore + rawPenalty when penalties exceed baseline', () => {
    // Separate spec where rules can drive deltas unbounded. The final
    // score clamps to 0, but rawScore + rawPenalty surface how far past
    // the floor we went — closes the "0/100 (mild) vs 0/100 (severe)"
    // indistinguishability problem.
    const BRUTAL: DimensionScoringSpec<{ count: number }> = {
      dimension: 'brutal',
      methodology: 'test-only',
      baseline: 100,
      penalties: [
        {
          id: 'unbounded',
          describe: (i) => `${i.count} issue(s)`,
          applies: (i) => i.count > 0,
          delta: (i) => -i.count * 10,
        },
      ],
      caps: [],
    };
    const r = evaluateSpec(BRUTAL, { count: 20 });
    expect(r.score).toBe(0);
    expect(r.rawScore).toBe(-100);
    expect(r.rawPenalty).toBe(-200);
    expect(r.rating).toBe('E');
  });

  it('uses Math.abs(delta) as default upliftIfFixed when rule does not override', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 2 }));
    expect(r.deductions[0].upliftIfFixed).toBe(10);
  });
});

describe('evaluateSpec — caps', () => {
  it('binds the most-aggressive applicable cap (lowest ceiling wins)', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput({ hasSecret: true, toolMissing: true, open: true }));
    expect(r.score).toBe(CAP_TIERS['trust-broken']);
    expect(r.capsApplied).toHaveLength(1);
    expect(r.capsApplied[0].tier).toBe('trust-broken');
    expect(r.capsApplied[0].id).toBe('secret-present');
  });

  it('upliftIfRemoved on the binding cap equals next-cap ceiling minus current', () => {
    // secret-present binds at 40; next cap (uncertainty) ceilings at 65.
    // Lifting the secret cap moves score to 65 (still bounded by
    // uncertainty cap). Uplift = 25.
    const r = evaluateSpec(TOY_SPEC, toyInput({ hasSecret: true, toolMissing: true }));
    expect(r.capsApplied[0].upliftIfRemoved).toBe(25);
  });

  it('upliftIfRemoved equals clamped rawScore minus ceiling when no other cap applies', () => {
    // Only secret-present applies; lifting it returns to scoreAfterClamp=100.
    const r = evaluateSpec(TOY_SPEC, toyInput({ hasSecret: true }));
    expect(r.capsApplied[0].upliftIfRemoved).toBe(60);
  });

  it('does not surface non-binding caps', () => {
    // fixable-finding (79) would apply, but rawScore is below 79 due
    // to penalty so the cap never binds. Should not appear.
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 5, open: true }));
    expect(r.score).toBe(75);
    expect(r.capsApplied).toEqual([]);
  });

  it('fixable-finding cap binds at 79 when score would otherwise be Excellent', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput({ open: true }));
    expect(r.score).toBe(CAP_TIERS['fixable-finding']);
    expect(r.rating).toBe('B');
    expect(r.capsApplied[0].id).toBe('finding-open');
  });
});

describe('evaluateSpec — topActions', () => {
  it('surfaces only the binding cap when a cap binds', () => {
    // With cap binding, deduction uplift = 0 (blocked). Cap is the
    // sole actionable item.
    const r = evaluateSpec(TOY_SPEC, toyInput({ hasSecret: true, errors: 2 }));
    expect(r.topActions).toHaveLength(1);
    expect(r.topActions[0].source).toBe('cap');
    expect(r.topActions[0].id).toBe('secret-present');
  });

  it('surfaces deductions sorted by uplift desc when no cap binds', () => {
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 2 }));
    expect(r.topActions).toHaveLength(1);
    expect(r.topActions[0].source).toBe('deduction');
    expect(r.topActions[0].upliftIfFixed).toBe(10);
  });

  it('annotates ratingTransition when uplift crosses a rating boundary', () => {
    // fixable-finding cap at 79 (B). Removing it returns score to
    // baseline=100 (A). Transition B → A should be flagged.
    const r = evaluateSpec(TOY_SPEC, toyInput({ open: true }));
    expect(r.topActions[0].ratingTransition).toEqual({ from: 'B', to: 'A' });
  });

  it('omits ratingTransition when uplift stays inside the current band', () => {
    // 2 errors → -10 → 90 (A). Fixing returns to 100 (A). No
    // transition.
    const r = evaluateSpec(TOY_SPEC, toyInput({ errors: 2 }));
    expect(r.topActions[0].ratingTransition).toBeUndefined();
  });

  it('omits zero-uplift actions', () => {
    // No penalties fire; deductions empty; no caps; topActions empty.
    const r = evaluateSpec(TOY_SPEC, toyInput());
    expect(r.topActions).toEqual([]);
  });
});

describe('evaluateSpec — determinism', () => {
  it('produces identical ScoreResult on repeated calls with the same input', () => {
    const input = toyInput({ errors: 7, hasSecret: true });
    const a = evaluateSpec(TOY_SPEC, input);
    const b = evaluateSpec(TOY_SPEC, input);
    expect(a).toEqual(b);
  });

  it('produces identical results for equivalent inputs (same metrics → same score)', () => {
    const a = evaluateSpec(TOY_SPEC, toyInput({ errors: 3, open: true }));
    const b = evaluateSpec(TOY_SPEC, {
      errors: 3,
      open: true,
      hasSecret: false,
      toolMissing: false,
    });
    expect(a).toEqual(b);
  });
});
