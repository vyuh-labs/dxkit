import { describe, it, expect } from 'vitest';
import {
  scoreQualityFromInput,
  QUALITY_ALL_UNMEASURED_CAP,
  QUALITY_PARTIAL_CAP,
  type QualityScoreInput,
} from '../src/analyzers/quality/scoring';

/** A QualityScoreInput with every signal at the "no penalty" value
 *  and every measurement available. Score from this baseline is 100.
 *  Tests override only the field(s) under test. */
function clean(): QualityScoreInput {
  return {
    sourceFiles: 100,
    lintErrors: 0,
    lintAvailable: true,
    consoleLogCount: 0,
    todoCount: 0,
    fixmeCount: 0,
    hackCount: 0,
    staleFiles: 0,
    mixedLanguages: false,
    filesOver500Lines: 0,
    largestFileLines: 0,
    anyTypeCount: 0,
    typeErrors: null,
    duplicationPercentage: 0,
    duplicationAvailable: true,
    maxFunctionsInFile: 0,
    deadImportCount: 0,
    orphanModuleCount: 0,
    structuralAvailable: true,
    commentRatio: 0,
  };
}

describe('scoreQualityFromInput — baseline', () => {
  it('returns 100 for a fully clean fully measured repo', () => {
    expect(scoreQualityFromInput(clean()).score).toBe(100);
  });

  it('clamps negative scores to 0', () => {
    // Stack every penalty class to drive the raw score below 0.
    const input: QualityScoreInput = {
      ...clean(),
      lintErrors: 5000,
      filesOver500Lines: 100,
      largestFileLines: 20000,
      consoleLogCount: 500,
      anyTypeCount: 5000,
      typeErrors: 5000,
      maxFunctionsInFile: 200,
      deadImportCount: 100,
      orphanModuleCount: 100,
      duplicationPercentage: 50,
      commentRatio: 0.9,
      todoCount: 100,
      fixmeCount: 100,
      hackCount: 100,
      staleFiles: 50,
      mixedLanguages: true,
    };
    expect(scoreQualityFromInput(input).score).toBe(0);
  });
});

describe('scoreQualityFromInput — lint', () => {
  it('penalizes lint errors by density', () => {
    // 100 source files, 10 errors → 10% density → 10 point penalty
    const score = scoreQualityFromInput({ ...clean(), lintErrors: 10 }).score;
    expect(score).toBe(90);
  });

  it('caps the lint penalty at 40 regardless of error count', () => {
    // 100 source files, 1000 errors → 1000% density → would exceed 40, capped
    const score = scoreQualityFromInput({ ...clean(), lintErrors: 1000 }).score;
    expect(score).toBe(60); // 100 - 40
  });
});

describe('scoreQualityFromInput — file size', () => {
  it('applies a 10-point penalty when filesOver500Lines > 5', () => {
    expect(scoreQualityFromInput({ ...clean(), filesOver500Lines: 6 }).score).toBe(90);
  });
  it('stacks a second 10-point penalty when filesOver500Lines > 20', () => {
    expect(scoreQualityFromInput({ ...clean(), filesOver500Lines: 21 }).score).toBe(80);
  });
  it('penalizes largestFileLines > 5000 (-10) and > 10000 (-20 total)', () => {
    expect(scoreQualityFromInput({ ...clean(), largestFileLines: 6000 }).score).toBe(90);
    expect(scoreQualityFromInput({ ...clean(), largestFileLines: 11000 }).score).toBe(80);
  });
});

describe('scoreQualityFromInput — console density', () => {
  it('penalizes density > 0.3 (-5)', () => {
    expect(scoreQualityFromInput({ ...clean(), consoleLogCount: 31 }).score).toBe(95);
  });
  it('escalates at density > 1 (-10) and > 3 (-15)', () => {
    expect(scoreQualityFromInput({ ...clean(), consoleLogCount: 101 }).score).toBe(90);
    expect(scoreQualityFromInput({ ...clean(), consoleLogCount: 301 }).score).toBe(85);
  });
});

describe('scoreQualityFromInput — anyType density', () => {
  it('penalizes density > 1 (-5), > 5 (-10), > 10 (-15)', () => {
    expect(scoreQualityFromInput({ ...clean(), anyTypeCount: 101 }).score).toBe(95);
    expect(scoreQualityFromInput({ ...clean(), anyTypeCount: 501 }).score).toBe(90);
    expect(scoreQualityFromInput({ ...clean(), anyTypeCount: 1001 }).score).toBe(85);
  });
});

describe('scoreQualityFromInput — type errors', () => {
  it('treats null as no signal (no penalty)', () => {
    expect(scoreQualityFromInput({ ...clean(), typeErrors: null }).score).toBe(100);
  });
  it('penalizes by density × 50, capped at 15', () => {
    // 30 errors / 100 sources = 0.3, × 50 = 15 (cap)
    expect(scoreQualityFromInput({ ...clean(), typeErrors: 30 }).score).toBe(85);
    // 5 errors / 100 sources = 0.05, × 50 = 2.5 → 100 - 2.5 = 97.5
    // Math.round rounds .5 up to 98.
    expect(scoreQualityFromInput({ ...clean(), typeErrors: 5 }).score).toBe(98);
  });
});

describe('scoreQualityFromInput — structural (graphify)', () => {
  it('penalizes maxFunctionsInFile > 50 (-10)', () => {
    expect(scoreQualityFromInput({ ...clean(), maxFunctionsInFile: 51 }).score).toBe(90);
  });
  it('penalizes deadImportCount > 20 (-10)', () => {
    expect(scoreQualityFromInput({ ...clean(), deadImportCount: 21 }).score).toBe(90);
  });
  it('penalizes orphanModuleCount > 30 (-5)', () => {
    expect(scoreQualityFromInput({ ...clean(), orphanModuleCount: 31 }).score).toBe(95);
  });
  it('treats null structural fields as no signal', () => {
    expect(
      scoreQualityFromInput({
        ...clean(),
        maxFunctionsInFile: null,
        deadImportCount: null,
        orphanModuleCount: null,
      }).score,
    ).toBe(100);
  });
});

describe('scoreQualityFromInput — duplication (jscpd)', () => {
  it('penalizes > 5% (-10) and > 15% (-20)', () => {
    expect(scoreQualityFromInput({ ...clean(), duplicationPercentage: 6 }).score).toBe(90);
    expect(scoreQualityFromInput({ ...clean(), duplicationPercentage: 16 }).score).toBe(80);
  });
  it('treats null as no signal', () => {
    expect(scoreQualityFromInput({ ...clean(), duplicationPercentage: null }).score).toBe(100);
  });
});

describe('scoreQualityFromInput — comment ratio (cloc)', () => {
  it('penalizes > 0.4 (-10) and > 0.5 (-15)', () => {
    expect(scoreQualityFromInput({ ...clean(), commentRatio: 0.41 }).score).toBe(90);
    expect(scoreQualityFromInput({ ...clean(), commentRatio: 0.51 }).score).toBe(85);
  });
});

describe('scoreQualityFromInput — hygiene markers', () => {
  it('penalizes total TODO+FIXME+HACK > 20 (-5) and > 50 (-10)', () => {
    expect(scoreQualityFromInput({ ...clean(), todoCount: 21 }).score).toBe(95);
    expect(scoreQualityFromInput({ ...clean(), fixmeCount: 51 }).score).toBe(90);
    expect(
      scoreQualityFromInput({ ...clean(), todoCount: 20, fixmeCount: 20, hackCount: 20 }).score,
    ).toBe(90);
  });
});

describe('scoreQualityFromInput — stale files + mixed languages', () => {
  it('penalizes staleFiles > 0 (-2) and > 3 (-5)', () => {
    expect(scoreQualityFromInput({ ...clean(), staleFiles: 1 }).score).toBe(98);
    expect(scoreQualityFromInput({ ...clean(), staleFiles: 4 }).score).toBe(95);
  });
  it('penalizes mixedLanguages (-5)', () => {
    expect(scoreQualityFromInput({ ...clean(), mixedLanguages: true }).score).toBe(95);
  });
});

describe('scoreQualityFromInput — honesty cap', () => {
  it('caps at PARTIAL_CAP (75) when one tool is unavailable', () => {
    const input = { ...clean(), lintAvailable: false };
    expect(scoreQualityFromInput(input).score).toBe(QUALITY_PARTIAL_CAP);
  });

  it('caps at PARTIAL_CAP when two tools are unavailable', () => {
    const input = { ...clean(), lintAvailable: false, duplicationAvailable: false };
    expect(scoreQualityFromInput(input).score).toBe(QUALITY_PARTIAL_CAP);
  });

  it('caps at ALL_UNMEASURED_CAP (35) when all three tools are unavailable', () => {
    const input = {
      ...clean(),
      lintAvailable: false,
      duplicationAvailable: false,
      structuralAvailable: false,
    };
    expect(scoreQualityFromInput(input).score).toBe(QUALITY_ALL_UNMEASURED_CAP);
  });

  it('does not raise a low score; cap is a ceiling, not a floor', () => {
    // Heavy penalties drive raw score below the cap → cap doesn't apply
    const input: QualityScoreInput = {
      ...clean(),
      lintErrors: 1000, // -40
      consoleLogCount: 500, // -15
      anyTypeCount: 2000, // -15
      duplicationPercentage: 20, // -20
      lintAvailable: false, // would cap at 75 if final > 75
    };
    // 100 - 40 - 15 - 15 - 20 = 10 (below cap; cap doesn't fire)
    expect(scoreQualityFromInput(input).score).toBe(10);
  });
});
