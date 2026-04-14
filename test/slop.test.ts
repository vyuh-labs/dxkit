import { describe, it, expect } from 'vitest';
import { computeSlopScore } from '../src/analyzers/quality';
import { QualityMetrics } from '../src/analyzers/quality/types';

/** Neutral baseline: all optional signals null/empty, no deductions. */
function baseQuality(): QualityMetrics {
  return {
    lintErrors: 0,
    lintWarnings: 0,
    lintTool: null,
    duplication: null,
    maxFunctionsInFile: null,
    maxFunctionsFilePath: null,
    avgCohesion: null,
    communityCount: null,
    functionCount: null,
    deadImportCount: null,
    orphanModuleCount: null,
    todoCount: 0,
    fixmeCount: 0,
    hackCount: 0,
    consoleLogCount: 0,
    commentRatio: null,
    staleFiles: [],
    mixedLanguages: false,
    slopScore: 0,
  };
}

function q(overrides: Partial<QualityMetrics>): QualityMetrics {
  return { ...baseQuality(), ...overrides };
}

describe('computeSlopScore', () => {
  it('returns 100 when no signals present', () => {
    expect(computeSlopScore(baseQuality())).toBe(100);
  });

  describe('duplication', () => {
    it('no penalty when duplication is null (jscpd unavailable)', () => {
      expect(computeSlopScore(q({ duplication: null }))).toBe(100);
    });

    it('no penalty at <=5%', () => {
      expect(
        computeSlopScore(
          q({
            duplication: { totalLines: 1000, duplicatedLines: 50, percentage: 5, cloneCount: 3 },
          }),
        ),
      ).toBe(100);
    });

    it('-10 for 5.1%–15%', () => {
      expect(
        computeSlopScore(
          q({
            duplication: { totalLines: 1000, duplicatedLines: 100, percentage: 10, cloneCount: 5 },
          }),
        ),
      ).toBe(90);
    });

    it('-20 for >15%', () => {
      expect(
        computeSlopScore(
          q({
            duplication: { totalLines: 1000, duplicatedLines: 200, percentage: 20, cloneCount: 10 },
          }),
        ),
      ).toBe(80);
    });
  });

  describe('comment ratio', () => {
    it('no penalty when null', () => {
      expect(computeSlopScore(q({ commentRatio: null }))).toBe(100);
    });

    it('no penalty at <=0.4', () => {
      expect(computeSlopScore(q({ commentRatio: 0.3 }))).toBe(100);
    });

    it('-10 for 0.41–0.5', () => {
      expect(computeSlopScore(q({ commentRatio: 0.45 }))).toBe(90);
    });

    it('-15 for >0.5', () => {
      expect(computeSlopScore(q({ commentRatio: 0.6 }))).toBe(85);
    });
  });

  describe('hygiene (TODO/FIXME/HACK)', () => {
    it('no penalty at <=20 total', () => {
      expect(computeSlopScore(q({ todoCount: 10, fixmeCount: 5, hackCount: 5 }))).toBe(100);
    });

    it('-5 for 21–50', () => {
      expect(computeSlopScore(q({ todoCount: 30, fixmeCount: 0, hackCount: 0 }))).toBe(95);
    });

    it('-10 for >50', () => {
      expect(computeSlopScore(q({ todoCount: 40, fixmeCount: 10, hackCount: 5 }))).toBe(90);
    });
  });

  describe('god files', () => {
    it('no penalty when null or <=50', () => {
      expect(computeSlopScore(q({ maxFunctionsInFile: null }))).toBe(100);
      expect(computeSlopScore(q({ maxFunctionsInFile: 50 }))).toBe(100);
    });

    it('-10 when maxFunctionsInFile > 50', () => {
      expect(computeSlopScore(q({ maxFunctionsInFile: 75 }))).toBe(90);
    });
  });

  describe('dead imports & orphan modules', () => {
    it('no penalty when null', () => {
      expect(computeSlopScore(q({ deadImportCount: null, orphanModuleCount: null }))).toBe(100);
    });

    it('-10 when deadImportCount > 20', () => {
      expect(computeSlopScore(q({ deadImportCount: 25 }))).toBe(90);
    });

    it('-5 when orphanModuleCount > 30', () => {
      expect(computeSlopScore(q({ orphanModuleCount: 40 }))).toBe(95);
    });

    it('stacks both', () => {
      expect(computeSlopScore(q({ deadImportCount: 25, orphanModuleCount: 40 }))).toBe(85);
    });
  });

  describe('console density', () => {
    it('no penalty at <=20', () => {
      expect(computeSlopScore(q({ consoleLogCount: 20 }))).toBe(100);
    });

    it('-5 for 21–100', () => {
      expect(computeSlopScore(q({ consoleLogCount: 50 }))).toBe(95);
    });

    it('-10 for 101–500', () => {
      expect(computeSlopScore(q({ consoleLogCount: 300 }))).toBe(90);
    });

    it('-15 for >500', () => {
      expect(computeSlopScore(q({ consoleLogCount: 1000 }))).toBe(85);
    });
  });

  describe('lint errors', () => {
    it('no penalty at <=10', () => {
      expect(computeSlopScore(q({ lintErrors: 10 }))).toBe(100);
    });

    it('-5 for 11–50', () => {
      expect(computeSlopScore(q({ lintErrors: 30 }))).toBe(95);
    });

    it('-10 for >50', () => {
      expect(computeSlopScore(q({ lintErrors: 100 }))).toBe(90);
    });
  });

  describe('stale files', () => {
    it('no penalty when empty', () => {
      expect(computeSlopScore(q({ staleFiles: [] }))).toBe(100);
    });

    it('-2 for 1–3 stale files', () => {
      expect(computeSlopScore(q({ staleFiles: ['a.swp'] }))).toBe(98);
      expect(computeSlopScore(q({ staleFiles: ['a.swp', 'b.bak', 'c.orig'] }))).toBe(98);
    });

    it('-5 for >3 stale files', () => {
      expect(computeSlopScore(q({ staleFiles: ['a.swp', 'b.bak', 'c.orig', 'd.tmp'] }))).toBe(95);
    });
  });

  describe('mixed languages', () => {
    it('-5 when mixedLanguages true', () => {
      expect(computeSlopScore(q({ mixedLanguages: true }))).toBe(95);
    });

    it('no penalty when false', () => {
      expect(computeSlopScore(q({ mixedLanguages: false }))).toBe(100);
    });
  });

  describe('stacking and clamping', () => {
    it('stacks multiple moderate signals', () => {
      const score = computeSlopScore(
        q({
          duplication: { totalLines: 1000, duplicatedLines: 100, percentage: 10, cloneCount: 5 },
          commentRatio: 0.45,
          todoCount: 30,
          consoleLogCount: 50,
          lintErrors: 30,
          mixedLanguages: true,
        }),
      );
      // 100 - 10 (dup) - 10 (comments) - 5 (hygiene) - 5 (console) - 5 (lint) - 5 (mixed) = 60
      expect(score).toBe(60);
    });

    it('clamps to 0 when every signal is maxed out', () => {
      const score = computeSlopScore(
        q({
          duplication: { totalLines: 1000, duplicatedLines: 400, percentage: 40, cloneCount: 20 },
          commentRatio: 0.8,
          todoCount: 100,
          fixmeCount: 100,
          hackCount: 100,
          maxFunctionsInFile: 200,
          deadImportCount: 100,
          orphanModuleCount: 100,
          consoleLogCount: 2000,
          lintErrors: 500,
          staleFiles: ['a', 'b', 'c', 'd', 'e'],
          mixedLanguages: true,
        }),
      );
      expect(score).toBe(0);
    });

    it('never returns negative', () => {
      const score = computeSlopScore(
        q({
          duplication: { totalLines: 1, duplicatedLines: 1, percentage: 100, cloneCount: 1 },
          commentRatio: 1,
          todoCount: 1000,
          maxFunctionsInFile: 1000,
          deadImportCount: 1000,
          orphanModuleCount: 1000,
          consoleLogCount: 1000,
          lintErrors: 1000,
          staleFiles: Array(20).fill('x'),
          mixedLanguages: true,
        }),
      );
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });
});
