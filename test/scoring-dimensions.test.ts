import { describe, it, expect } from 'vitest';

import { scoreDocsDimension } from '../src/analyzers/docs/shallow';
import { scoreMaintainabilityDimension } from '../src/analyzers/maintainability/shallow';
import { scoreDxDimension } from '../src/analyzers/dx/shallow';
import { scoreSecurityDimension } from '../src/analyzers/security/shallow';
import { scoreQualityDimension } from '../src/analyzers/quality/shallow';
import { scoreTestsDimension } from '../src/analyzers/tests/shallow';
import { scoreSecurityCounts } from '../src/analyzers/security/scoring';
import { scoreTestGapsCounts } from '../src/analyzers/tests/scoring';
import {
  coverageCapability,
  lintCapability,
  secretsCapabilityWithCount,
  withInput,
} from './fixtures/score-input';

// ── Shallow dimension scorers (all delegate to scoring.ts) ─────────────

describe('shallow dimension scorers', () => {
  const baseInput = withInput();

  it('scoreDocsDimension returns a DimensionScore', () => {
    const r = scoreDocsDimension(baseInput);
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('maxScore', 100);
    expect(r).toHaveProperty('status');
    expect(typeof r.score).toBe('number');
  });

  it('scoreMaintainabilityDimension returns a DimensionScore', () => {
    const r = scoreMaintainabilityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreDxDimension returns a DimensionScore', () => {
    const r = scoreDxDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreSecurityDimension returns a DimensionScore', () => {
    const r = scoreSecurityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreQualityDimension returns a DimensionScore', () => {
    const r = scoreQualityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreTestsDimension returns a DimensionScore', () => {
    const r = scoreTestsDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('docs score improves with README + CONTRIBUTING', () => {
    const good = withInput({
      metrics: { readmeExists: true, readmeLines: 100, contributingExists: true },
    });
    expect(scoreDocsDimension(good).score).toBeGreaterThan(scoreDocsDimension(baseInput).score);
  });

  it('security score drops with secret findings', () => {
    const bad = withInput({
      metrics: { privateKeyFiles: 2, evalCount: 3 },
      capabilities: { secrets: secretsCapabilityWithCount(5) },
    });
    expect(scoreSecurityDimension(bad).score).toBeLessThan(scoreSecurityDimension(baseInput).score);
  });

  it('quality score drops with lint errors + large files', () => {
    const bad = withInput({
      metrics: { filesOver500Lines: 20, consoleLogCount: 200 },
      capabilities: { lint: lintCapability(0, 100) },
    });
    expect(scoreQualityDimension(bad).score).toBeLessThan(scoreQualityDimension(baseInput).score);
  });

  it('maintainability score drops with huge god files', () => {
    const bad = withInput({
      metrics: { largestFileLines: 10000, filesOver500Lines: 40, controllers: 200 },
    });
    expect(scoreMaintainabilityDimension(bad).score).toBeLessThan(
      scoreMaintainabilityDimension(baseInput).score,
    );
  });

  it('dx score improves with CI + Docker + pre-commit', () => {
    const good = withInput({
      metrics: {
        ciConfigCount: 2,
        dockerConfigCount: 1,
        precommitConfigCount: 1,
        makefileExists: true,
        envExampleExists: true,
        npmScriptsCount: 8,
      },
    });
    expect(scoreDxDimension(good).score).toBeGreaterThan(scoreDxDimension(baseInput).score);
  });

  it('test score improves with test files + passing tests', () => {
    const good = withInput({
      metrics: { testFiles: 20, testsPass: true, coverageConfigExists: true },
      capabilities: { coverage: coverageCapability(80) },
    });
    expect(scoreTestsDimension(good).score).toBeGreaterThan(scoreTestsDimension(baseInput).score);
  });
});

// ── Security sub-scorer ────────────────────────────────────────────────

describe('scoreSecurityCounts', () => {
  it('returns 100 for zero findings', () => {
    const r = scoreSecurityCounts({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      depCritical: 0,
      depHigh: 0,
      depMedium: 0,
      depLow: 0,
    });
    expect(r.score).toBe(100);
  });

  it('penalizes critical findings heavily', () => {
    const r = scoreSecurityCounts({
      critical: 3,
      high: 0,
      medium: 0,
      low: 0,
      depCritical: 0,
      depHigh: 0,
      depMedium: 0,
      depLow: 0,
    });
    expect(r.score).toBe(85);
  });

  it('stacks code + dep penalties', () => {
    const r = scoreSecurityCounts({
      critical: 11,
      high: 6,
      medium: 15,
      low: 0,
      depCritical: 1,
      depHigh: 6,
      depMedium: 0,
      depLow: 0,
    });
    expect(r.score).toBeLessThanOrEqual(35);
  });

  it('clamps within 0-100 on extreme inputs', () => {
    const r = scoreSecurityCounts({
      critical: 100,
      high: 100,
      medium: 100,
      low: 100,
      depCritical: 100,
      depHigh: 100,
      depMedium: 100,
      depLow: 100,
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

// ── Test gaps sub-scorer ───────────────────────────────────────────────

describe('scoreTestGapsCounts', () => {
  it('returns high score when everything is tested', () => {
    const r = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    expect(r.score).toBe(100);
  });

  it('penalizes untested critical files most', () => {
    const withCrit = scoreTestGapsCounts({
      untestedCritical: 5,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    const withLow = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 5,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    expect(withCrit.score).toBeLessThan(withLow.score);
  });

  it('penalizes commented-out test files', () => {
    const clean = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    const withCommented = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 3,
    });
    expect(withCommented.score).toBeLessThan(clean.score);
  });

  it('clamps to 0-100', () => {
    const worst = scoreTestGapsCounts({
      untestedCritical: 100,
      untestedHigh: 100,
      untestedMedium: 100,
      untestedLow: 100,
      testedSource: 0,
      commentedOutFiles: 10,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});
