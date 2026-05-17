/**
 * Recipe playbook test — synthetic dimension spec injection.
 *
 * Verifies that the spec engine (`evaluateSpec`) and the central
 * `SCORING_SPECS` registry consume any well-formed
 * `DimensionScoringSpec<T>` uniformly. Catches future regressions
 * where someone adds a one-off scorer that bypasses the spec model
 * — a synthetic 7th dimension landing here should "just work"
 * end-to-end without touching the engine.
 *
 * Mirrors the same playbook discipline applied to language packs
 * (`test/recipe-playbook.test.ts`). A new dimension added per the
 * recipe should fall through the existing infrastructure without
 * needing engine changes.
 */

import { describe, expect, it } from 'vitest';

import {
  CAP_TIERS,
  evaluateSpec,
  formatTopActionLine,
  formatTopActionsBlock,
  ratingFromScore,
  SCORING_SPECS,
  type DimensionScoringSpec,
} from '../src/scoring';

interface SyntheticInput {
  readonly violations: number;
  readonly missingCriticalArtifact: boolean;
  readonly toolRan: boolean;
}

const SYNTHETIC_SPEC: DimensionScoringSpec<SyntheticInput> = {
  dimension: 'synthetic',
  methodology: 'test-only-playbook',
  baseline: 100,
  penalties: [
    {
      id: 'violation-density',
      describe: (i) => `${i.violations} violations`,
      applies: (i) => i.violations > 0,
      delta: (i) => -Math.min(50, i.violations * 5),
    },
  ],
  caps: [
    {
      id: 'critical-artifact-missing',
      tier: 'trust-broken',
      describe: () => 'foundational artifact missing',
      applies: (i) => i.missingCriticalArtifact,
    },
    {
      id: 'tool-not-run',
      tier: 'uncertainty',
      describe: () => 'measurement tool did not run',
      applies: (i) => !i.toolRan,
    },
  ],
};

describe('Scoring recipe playbook — synthetic dimension', () => {
  it('the spec engine consumes any well-formed spec uniformly', () => {
    const r = evaluateSpec(SYNTHETIC_SPEC, {
      violations: 3,
      missingCriticalArtifact: false,
      toolRan: true,
    });
    expect(r.score).toBe(85);
    expect(r.rating).toBe('A');
    expect(r.deductions).toHaveLength(1);
    expect(r.deductions[0].id).toBe('violation-density');
  });

  it('cap tiers resolve to the canonical CAP_TIERS table', () => {
    const r = evaluateSpec(SYNTHETIC_SPEC, {
      violations: 0,
      missingCriticalArtifact: true,
      toolRan: true,
    });
    expect(r.score).toBe(CAP_TIERS['trust-broken']);
    expect(r.capsApplied).toHaveLength(1);
    expect(r.capsApplied[0].tier).toBe('trust-broken');
  });

  it('rating mapping is consistent with the global thresholds', () => {
    // Score 50 should rate C across every dimension (spec-agnostic).
    const r = evaluateSpec(SYNTHETIC_SPEC, {
      violations: 10,
      missingCriticalArtifact: false,
      toolRan: true,
    });
    expect(r.score).toBe(50);
    expect(r.rating).toBe(ratingFromScore(r.score));
    expect(r.rating).toBe('C');
  });

  it('format helpers consume the synthetic ScoreResult without per-dimension branching', () => {
    const r = evaluateSpec(SYNTHETIC_SPEC, {
      violations: 2,
      missingCriticalArtifact: false,
      toolRan: true,
    });
    expect(formatTopActionLine(r)).toContain('2 violations');
    const block = formatTopActionsBlock(r);
    expect(block.some((line) => line.includes('2 violations'))).toBe(true);
  });
});

describe('Scoring registry', () => {
  it('contains exactly one spec per dxkit dimension', () => {
    const ids = SCORING_SPECS.map((s) => s.dimension).sort();
    expect(ids).toEqual([
      'documentation',
      'dx',
      'maintainability',
      'quality',
      'security',
      'testing',
    ]);
  });

  it('every registered spec declares a methodology citation', () => {
    for (const spec of SCORING_SPECS) {
      expect(spec.methodology).toBeTruthy();
      expect(spec.methodology.length).toBeGreaterThan(3);
    }
  });

  it('every registered spec has at least one penalty rule', () => {
    for (const spec of SCORING_SPECS) {
      expect(spec.penalties.length).toBeGreaterThan(0);
    }
  });

  it('every registered cap tier resolves to a valid CAP_TIERS entry', () => {
    for (const spec of SCORING_SPECS) {
      for (const cap of spec.caps) {
        expect(CAP_TIERS).toHaveProperty(cap.tier);
        expect(CAP_TIERS[cap.tier]).toBeGreaterThanOrEqual(0);
        expect(CAP_TIERS[cap.tier]).toBeLessThanOrEqual(100);
      }
    }
  });
});
