import { describe, it, expect } from 'vitest';
import {
  floorRequired,
  floorRequiredGap,
  requiredCustomCheckGaps,
  requiredCustomCheckNames,
} from '../../src/gate/required-observation';
import { verdictWordFrom } from '../../src/baseline/check-renderers';
import { DEFAULT_BROWNFIELD_POLICY, type BrownfieldPolicy } from '../../src/baseline/policy';
import type { CustomChecksUnobserved } from '../../src/analyzers/custom-checks/gather';

/**
 * WP1 (§7.1) — the ONE required-observation evaluator. The refusal
 * discipline under test: a gap is minted ONLY for a declared-required
 * check that was demonstrably not observed (never invented), and any
 * gap makes PASSED unconstructible through the one verdict derivation.
 */

function policyWith(overrides: Partial<BrownfieldPolicy>): BrownfieldPolicy {
  return { ...DEFAULT_BROWNFIELD_POLICY, ...overrides } as BrownfieldPolicy;
}

const NOTHING_UNOBSERVED: CustomChecksUnobserved = { gathered: true, checks: [] };

describe('floorRequired / floorRequiredGap', () => {
  it('defaults to required — the §7.1 reversal', () => {
    expect(floorRequired(DEFAULT_BROWNFIELD_POLICY)).toBe(true);
  });

  it('a policy opts out with floor.required: false', () => {
    expect(floorRequired(policyWith({ floor: { required: false } }))).toBe(false);
  });

  it('mints a gap for a skipped floor under the default, with cause and remedy', () => {
    const gap = floorRequiredGap(DEFAULT_BROWNFIELD_POLICY, {
      cause: 'untrusted',
      detail: 'tree is untrusted',
    });
    expect(gap?.checkId).toBe('floor');
    expect(gap?.reason).toContain('untrusted');
    expect(gap?.remedy).toContain('--trusted');
  });

  it('mints nothing when the floor ran (no skip), and nothing under the opt-out', () => {
    expect(floorRequiredGap(DEFAULT_BROWNFIELD_POLICY, undefined)).toBeUndefined();
    expect(
      floorRequiredGap(policyWith({ floor: { required: false } }), {
        cause: 'untrusted',
        detail: 'tree is untrusted',
      }),
    ).toBeUndefined();
  });
});

describe('requiredCustomCheckGaps', () => {
  const requiredCheckPolicy = policyWith({
    checks: [
      { name: 'arch', command: 'scripts/check-arch.sh', required: true },
      { name: 'optional-audit', command: 'scripts/audit.sh' },
    ],
  });

  it('names only required: true checks', () => {
    expect(requiredCustomCheckNames(requiredCheckPolicy)).toEqual(['arch']);
    expect(requiredCustomCheckNames(DEFAULT_BROWNFIELD_POLICY)).toEqual([]);
  });

  it('no required checks → no gaps regardless of skips (nothing is invented)', () => {
    const skipped: CustomChecksUnobserved = {
      gathered: true,
      checks: [{ name: 'optional-audit', status: 'skipped-untrusted' }],
    };
    expect(requiredCustomCheckGaps(DEFAULT_BROWNFIELD_POLICY, skipped, [])).toEqual([]);
  });

  it('a required check recorded unobserved gaps, with the per-cause remedy', () => {
    const skipped: CustomChecksUnobserved = {
      gathered: true,
      checks: [{ name: 'arch', status: 'skipped-untrusted', reason: 'untrusted tree' }],
    };
    const gaps = requiredCustomCheckGaps(requiredCheckPolicy, skipped, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].checkId).toBe('custom:arch');
    expect(gaps[0].reason).toContain('skipped-untrusted');
    expect(gaps[0].remedy).toContain('--trusted');
  });

  it('a required check that RAN mints nothing — pass or fail, it was observed', () => {
    expect(requiredCustomCheckGaps(requiredCheckPolicy, NOTHING_UNOBSERVED, [])).toEqual([]);
  });

  it('an optional check skipped beside a required one that ran mints nothing', () => {
    const skipped: CustomChecksUnobserved = {
      gathered: true,
      checks: [{ name: 'optional-audit', status: 'skipped-environment' }],
    };
    expect(requiredCustomCheckGaps(requiredCheckPolicy, skipped, [])).toEqual([]);
  });

  it('an invalid required entry gaps — a config typo must not silently disarm it', () => {
    const invalid = policyWith({
      // no command and no pattern → dropped by the ONE normalizer
      checks: [{ name: 'broken', required: true }],
    });
    const gaps = requiredCustomCheckGaps(invalid, NOTHING_UNOBSERVED, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toContain('not a runnable check');
  });

  it('the gather itself not running gaps every required check', () => {
    const gaps = requiredCustomCheckGaps(
      requiredCheckPolicy,
      { gathered: false, reason: 'scope excluded custom checks' },
      [],
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toContain('scope excluded custom checks');
  });

  it('ref-based mode gaps every required check with the mode remedy', () => {
    const gaps = requiredCustomCheckGaps(requiredCheckPolicy, NOTHING_UNOBSERVED, [
      { kind: 'custom-check' },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toContain('ref-based');
    expect(gaps[0].remedy).toContain('committed');
  });

  it('every gap carries a non-empty remedy — a refusal always names the way out', () => {
    const shapes: Array<CustomChecksUnobserved> = [
      { gathered: false, reason: 'x' },
      { gathered: true, checks: [{ name: 'arch', status: 'skipped-environment' }] },
      { gathered: true, checks: [{ name: 'arch', status: 'skipped-unavailable' }] },
      { gathered: true, checks: [{ name: 'arch', status: 'skipped-timeout' }] },
    ];
    for (const shape of shapes) {
      for (const gap of requiredCustomCheckGaps(requiredCheckPolicy, shape, [])) {
        expect(gap.remedy.trim().length).toBeGreaterThan(10);
      }
    }
  });
});

describe('the verdict derivation folds required gaps into the refusal tier', () => {
  it('a required gap makes PASSED unconstructible', () => {
    const word = verdictWordFrom({
      blocks: false,
      warns: false,
      unattributable: 0,
      requiredMissing: 1,
    });
    expect(word.verdict).toBe('CANNOT GATE');
    expect(word.exitCode).toBe(1);
  });

  it('a definite regression still outranks the refusal (both non-zero exits)', () => {
    const word = verdictWordFrom({
      blocks: true,
      warns: false,
      unattributable: 0,
      requiredMissing: 1,
    });
    expect(word.verdict).toBe('BLOCKED');
  });

  it('zero gaps leaves the pass tiers untouched (absent means zero for old callers)', () => {
    expect(verdictWordFrom({ blocks: false, warns: true, unattributable: 0 }).verdict).toBe(
      'PASSED (with warnings)',
    );
    expect(
      verdictWordFrom({ blocks: false, warns: false, unattributable: 0, requiredMissing: 0 })
        .verdict,
    ).toBe('PASSED');
  });
});
