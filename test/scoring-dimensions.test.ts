import { describe, it, expect } from 'vitest';
import { HealthMetrics } from '../src/analyzers/types';

import { scoreDocsDimension } from '../src/analyzers/docs/shallow';
import { scoreMaintainabilityDimension } from '../src/analyzers/maintainability/shallow';
import { scoreDxDimension } from '../src/analyzers/dx/shallow';
import { scoreSecurityDimension } from '../src/analyzers/security/shallow';
import { scoreQualityDimension } from '../src/analyzers/quality/shallow';
import { scoreTestsDimension } from '../src/analyzers/tests/shallow';
import { scoreSecurityCounts } from '../src/analyzers/security/scoring';
import { scoreTestGapsCounts } from '../src/analyzers/tests/scoring';

function baseMetrics(): HealthMetrics {
  return {
    sourceFiles: 100,
    testFiles: 0,
    totalLines: 0,
    testsPass: null,
    testsPassing: 0,
    testsFailing: 0,
    testFramework: null,
    coveragePercent: null,
    coverageConfigExists: false,
    lintErrors: 0,
    lintWarnings: 0,
    lintTool: null,
    typeErrors: null,
    filesOver500Lines: 0,
    largestFileLines: 0,
    largestFilePath: '',
    consoleLogCount: 0,
    anyTypeCount: 0,
    readmeExists: false,
    readmeLines: 0,
    docCommentFiles: 0,
    apiDocsExist: false,
    architectureDocsExist: false,
    contributingExists: false,
    changelogExists: false,
    secretFindings: 0,
    secretDetails: [],
    evalCount: 0,
    privateKeyFiles: 0,
    envFilesInGit: 0,
    tlsDisabledCount: 0,
    depVulnCritical: 0,
    depVulnHigh: 0,
    depVulnMedium: 0,
    depVulnLow: 0,
    depAuditTool: null,
    controllers: 0,
    models: 0,
    directories: 0,
    languages: [],
    nodeEngineVersion: null,
    ciConfigCount: 0,
    dockerConfigCount: 0,
    precommitConfigCount: 0,
    makefileExists: false,
    envExampleExists: false,
    npmScriptsCount: 0,
    toolsUsed: [],
    toolsUnavailable: [],
    clocLanguages: null,
    functionCount: null,
    classCount: null,
    maxFunctionsInFile: null,
    maxFunctionsFilePath: null,
    godNodeCount: null,
    communityCount: null,
    avgCohesion: null,
    orphanModuleCount: null,
    deadImportCount: null,
    commentedCodeRatio: null,
  };
}

// ── Shallow dimension scorers (all delegate to scoring.ts) ─────────────

describe('shallow dimension scorers', () => {
  const m = baseMetrics();

  it('scoreDocsDimension returns a DimensionScore', () => {
    const r = scoreDocsDimension(m);
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('maxScore', 100);
    expect(r).toHaveProperty('status');
    expect(typeof r.score).toBe('number');
  });

  it('scoreMaintainabilityDimension returns a DimensionScore', () => {
    const r = scoreMaintainabilityDimension(m);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreDxDimension returns a DimensionScore', () => {
    const r = scoreDxDimension(m);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreSecurityDimension returns a DimensionScore', () => {
    const r = scoreSecurityDimension(m);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreQualityDimension returns a DimensionScore', () => {
    const r = scoreQualityDimension(m);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreTestsDimension returns a DimensionScore', () => {
    const r = scoreTestsDimension(m);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('docs score improves with README + CONTRIBUTING', () => {
    const good = { ...m, readmeExists: true, readmeLines: 100, contributingExists: true };
    expect(scoreDocsDimension(good).score).toBeGreaterThan(scoreDocsDimension(m).score);
  });

  it('security score drops with secret findings', () => {
    const bad = { ...m, secretFindings: 5, privateKeyFiles: 2, evalCount: 3 };
    expect(scoreSecurityDimension(bad).score).toBeLessThan(scoreSecurityDimension(m).score);
  });

  it('quality score drops with lint errors + large files', () => {
    const bad = { ...m, lintErrors: 100, filesOver500Lines: 20, consoleLogCount: 200 };
    expect(scoreQualityDimension(bad).score).toBeLessThan(scoreQualityDimension(m).score);
  });

  it('maintainability score drops with huge god files', () => {
    const bad = { ...m, largestFileLines: 10000, filesOver500Lines: 40, controllers: 200 };
    expect(scoreMaintainabilityDimension(bad).score).toBeLessThan(
      scoreMaintainabilityDimension(m).score,
    );
  });

  it('dx score improves with CI + Docker + pre-commit', () => {
    const good = {
      ...m,
      ciConfigCount: 2,
      dockerConfigCount: 1,
      precommitConfigCount: 1,
      makefileExists: true,
      envExampleExists: true,
      npmScriptsCount: 8,
    };
    expect(scoreDxDimension(good).score).toBeGreaterThan(scoreDxDimension(m).score);
  });

  it('test score improves with test files + passing tests', () => {
    const good = {
      ...m,
      testFiles: 20,
      testsPass: true,
      coverageConfigExists: true,
      coveragePercent: 80,
    };
    expect(scoreTestsDimension(good).score).toBeGreaterThan(scoreTestsDimension(m).score);
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
