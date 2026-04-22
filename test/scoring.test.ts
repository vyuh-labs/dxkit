import { describe, it, expect } from 'vitest';
import {
  scoreTest,
  scoreQuality,
  scoreDocumentation,
  scoreSecurity,
  scoreMaintainability,
  scoreDeveloperExperience,
  computeOverall,
} from '../src/analyzers/scoring';
import { DimensionScore } from '../src/analyzers/types';
import {
  coverageCapability,
  depVulnCapability,
  lintCapability,
  secretsCapabilityWithCount,
  structuralCapability,
  withInput,
} from './fixtures/score-input';

describe('scoreTest', () => {
  it('returns 0 when no test files exist', () => {
    const s = scoreTest(withInput({ metrics: { sourceFiles: 50, testFiles: 0 } }));
    expect(s.score).toBe(0);
    expect(s.status).toBe('critical');
  });

  it('scales with test ratio, capped at 60 before bonuses', () => {
    const s = scoreTest(withInput({ metrics: { sourceFiles: 100, testFiles: 10 } }));
    // ratio 0.1 * 200 = 20
    expect(s.score).toBe(20);
  });

  it('caps base score at 60 for high ratios', () => {
    const s = scoreTest(withInput({ metrics: { sourceFiles: 100, testFiles: 80 } }));
    // ratio 0.8 * 200 = 160 → capped at 60
    expect(s.score).toBe(60);
  });

  it('adds +10 for coverage config', () => {
    const s = scoreTest(
      withInput({
        metrics: { sourceFiles: 100, testFiles: 10, coverageConfigExists: true },
      }),
    );
    expect(s.score).toBe(30);
  });

  it('adds +15 when tests pass', () => {
    const s = scoreTest(
      withInput({ metrics: { sourceFiles: 100, testFiles: 10, testsPass: true } }),
    );
    expect(s.score).toBe(35);
  });

  it('adds +10 for >=60% coverage, +15 total at >=80%', () => {
    const s60 = scoreTest(
      withInput({
        metrics: { sourceFiles: 100, testFiles: 10 },
        capabilities: { coverage: coverageCapability(60) },
      }),
    );
    expect(s60.score).toBe(30);
    const s80 = scoreTest(
      withInput({
        metrics: { sourceFiles: 100, testFiles: 10 },
        capabilities: { coverage: coverageCapability(80) },
      }),
    );
    expect(s80.score).toBe(35);
  });

  it('deducts 15 for high commented-code ratio', () => {
    const s = scoreTest(
      withInput({
        metrics: { sourceFiles: 100, testFiles: 10 },
        capabilities: { structural: structuralCapability({ commentedCodeRatio: 0.8 }) },
      }),
    );
    // 20 base - 15 = 5
    expect(s.score).toBe(5);
  });

  it('clamps score to [0, 100]', () => {
    const s = scoreTest(
      withInput({
        metrics: {
          sourceFiles: 100,
          testFiles: 80,
          coverageConfigExists: true,
          testsPass: true,
        },
        capabilities: { coverage: coverageCapability(90) },
      }),
    );
    // 60 + 10 + 15 + 10 + 5 = 100, not 110
    expect(s.score).toBe(100);
  });
});

describe('scoreQuality', () => {
  it('starts at 100 with no issues', () => {
    const s = scoreQuality(withInput({ metrics: { sourceFiles: 100 } }));
    expect(s.score).toBe(100);
  });

  it('deducts for lint errors proportional to density', () => {
    const s = scoreQuality(
      withInput({
        metrics: { sourceFiles: 100 },
        capabilities: { lint: lintCapability(0, 50) },
      }),
    );
    // critical+high = 50; ratio 0.5 * 100 = 50, capped at 40 → 100 - 40 = 60
    expect(s.score).toBe(60);
  });

  it('deducts tiered penalty for large files', () => {
    const s = scoreQuality(
      withInput({
        metrics: { sourceFiles: 100, filesOver500Lines: 25, largestFileLines: 12000 },
      }),
    );
    // -10 (>5) -10 (>20) -10 (>5000) -10 (>10000) = -40
    expect(s.score).toBe(60);
  });

  it('deducts for console density tiers', () => {
    const low = scoreQuality(withInput({ metrics: { sourceFiles: 100, consoleLogCount: 40 } }));
    expect(low.score).toBe(95); // density 0.4 → -5
    const mid = scoreQuality(withInput({ metrics: { sourceFiles: 100, consoleLogCount: 150 } }));
    expect(mid.score).toBe(90); // density 1.5 → -10
    const high = scoreQuality(withInput({ metrics: { sourceFiles: 100, consoleLogCount: 500 } }));
    expect(high.score).toBe(85); // density 5 → -15
  });

  it('deducts for any-type density', () => {
    const s = scoreQuality(withInput({ metrics: { sourceFiles: 100, anyTypeCount: 1100 } }));
    // density 11 → -15
    expect(s.score).toBe(85);
  });

  it('deducts for god files via AST', () => {
    const s = scoreQuality(
      withInput({
        metrics: { sourceFiles: 100 },
        capabilities: { structural: structuralCapability({ maxFunctionsInFile: 75 }) },
      }),
    );
    expect(s.score).toBe(90);
  });

  it('clamps to 0 when many large penalties stack', () => {
    const s = scoreQuality(
      withInput({
        metrics: {
          sourceFiles: 100,
          filesOver500Lines: 50,
          largestFileLines: 20000,
          consoleLogCount: 10000,
          anyTypeCount: 10000,
        },
        capabilities: {
          lint: lintCapability(0, 999),
          structural: structuralCapability({ maxFunctionsInFile: 200, deadImportCount: 100 }),
        },
      }),
    );
    expect(s.score).toBe(0);
  });
});

describe('scoreDocumentation', () => {
  it('returns 0 with no docs at all', () => {
    const s = scoreDocumentation(withInput({ metrics: { sourceFiles: 100 } }));
    expect(s.score).toBe(0);
    expect(s.status).toBe('critical');
  });

  it('awards README tiers', () => {
    const short = scoreDocumentation(
      withInput({ metrics: { readmeExists: true, readmeLines: 15 } }),
    );
    expect(short.score).toBe(5);
    const mid = scoreDocumentation(withInput({ metrics: { readmeExists: true, readmeLines: 60 } }));
    expect(mid.score).toBe(20);
    const long = scoreDocumentation(
      withInput({ metrics: { readmeExists: true, readmeLines: 200 } }),
    );
    expect(long.score).toBe(25);
  });

  it('awards doc comment ratio tiers', () => {
    const s = scoreDocumentation(withInput({ metrics: { sourceFiles: 100, docCommentFiles: 60 } }));
    expect(s.score).toBe(25); // ratio 0.6 → +25
  });

  it('awards additional docs flags', () => {
    const s = scoreDocumentation(
      withInput({
        metrics: {
          readmeExists: true,
          readmeLines: 200,
          apiDocsExist: true,
          architectureDocsExist: true,
          contributingExists: true,
          changelogExists: true,
        },
      }),
    );
    // 25 + 20 + 15 + 10 + 5 = 75
    expect(s.score).toBe(75);
  });

  it('clamps to 100', () => {
    const s = scoreDocumentation(
      withInput({
        metrics: {
          sourceFiles: 100,
          docCommentFiles: 60,
          readmeExists: true,
          readmeLines: 200,
          apiDocsExist: true,
          architectureDocsExist: true,
          contributingExists: true,
          changelogExists: true,
        },
      }),
    );
    expect(s.score).toBe(100);
  });
});

describe('scoreSecurity', () => {
  it('starts at 100 with no issues', () => {
    expect(scoreSecurity(withInput()).score).toBe(100);
  });

  it('deducts tiered for secrets', () => {
    expect(
      scoreSecurity(withInput({ capabilities: { secrets: secretsCapabilityWithCount(1) } })).score,
    ).toBe(85);
    expect(
      scoreSecurity(withInput({ capabilities: { secrets: secretsCapabilityWithCount(6) } })).score,
    ).toBe(80);
    expect(
      scoreSecurity(withInput({ capabilities: { secrets: secretsCapabilityWithCount(11) } })).score,
    ).toBe(75);
  });

  it('deducts 20 for any private keys', () => {
    expect(scoreSecurity(withInput({ metrics: { privateKeyFiles: 1 } })).score).toBe(80);
    expect(scoreSecurity(withInput({ metrics: { privateKeyFiles: 5 } })).score).toBe(80);
  });

  it('deducts tiered for eval usage', () => {
    expect(scoreSecurity(withInput({ metrics: { evalCount: 1 } })).score).toBe(95);
    expect(scoreSecurity(withInput({ metrics: { evalCount: 5 } })).score).toBe(90);
  });

  it('deducts for dependency vulns tiered', () => {
    expect(
      scoreSecurity(withInput({ capabilities: { depVulns: depVulnCapability(1, 0) } })).score,
    ).toBe(85);
    expect(
      scoreSecurity(withInput({ capabilities: { depVulns: depVulnCapability(0, 3) } })).score,
    ).toBe(95);
    expect(
      scoreSecurity(withInput({ capabilities: { depVulns: depVulnCapability(0, 10) } })).score,
    ).toBe(90);
  });

  it('stacks penalties, clamps to 0', () => {
    const s = scoreSecurity(
      withInput({
        metrics: {
          privateKeyFiles: 5,
          evalCount: 10,
          envFilesInGit: 1,
          tlsDisabledCount: 1,
        },
        capabilities: {
          secrets: secretsCapabilityWithCount(20),
          depVulns: depVulnCapability(5, 20),
        },
      }),
    );
    expect(s.score).toBe(0);
  });
});

describe('scoreMaintainability', () => {
  it('baseline starts at 70', () => {
    // 100 source files → no small-codebase bonus
    expect(scoreMaintainability(withInput({ metrics: { sourceFiles: 100 } })).score).toBe(70);
  });

  it('gives small-codebase bonuses', () => {
    expect(scoreMaintainability(withInput({ metrics: { sourceFiles: 40 } })).score).toBe(80);
    expect(scoreMaintainability(withInput({ metrics: { sourceFiles: 10 } })).score).toBe(85);
  });

  it('deducts for god files tiered', () => {
    expect(
      scoreMaintainability(withInput({ metrics: { sourceFiles: 100, largestFileLines: 1500 } }))
        .score,
    ).toBe(65);
    expect(
      scoreMaintainability(withInput({ metrics: { sourceFiles: 100, largestFileLines: 3000 } }))
        .score,
    ).toBe(60);
    expect(
      scoreMaintainability(withInput({ metrics: { sourceFiles: 100, largestFileLines: 7000 } }))
        .score,
    ).toBe(55);
    expect(
      scoreMaintainability(withInput({ metrics: { sourceFiles: 100, largestFileLines: 15000 } }))
        .score,
    ).toBe(45);
  });

  it('deducts for outdated node engine', () => {
    const old = scoreMaintainability(
      withInput({ metrics: { sourceFiles: 100, nodeEngineVersion: '>=14.0.0' } }),
    );
    expect(old.score).toBe(60);
    const midOld = scoreMaintainability(
      withInput({ metrics: { sourceFiles: 100, nodeEngineVersion: '>=16.0.0' } }),
    );
    expect(midOld.score).toBe(65);
    const modern = scoreMaintainability(
      withInput({ metrics: { sourceFiles: 100, nodeEngineVersion: '>=20.0.0' } }),
    );
    expect(modern.score).toBe(70);
  });

  it('deducts for AST god-node ratio', () => {
    const s = scoreMaintainability(
      withInput({
        metrics: { sourceFiles: 100 },
        capabilities: { structural: structuralCapability({ godNodeCount: 15 }) },
      }),
    );
    // ratio 0.15 → -10
    expect(s.score).toBe(60);
  });
});

describe('scoreDeveloperExperience', () => {
  it('returns 0 with nothing set up', () => {
    expect(scoreDeveloperExperience(withInput()).score).toBe(0);
  });

  it('awards points per DX signal', () => {
    const s = scoreDeveloperExperience(
      withInput({
        metrics: {
          ciConfigCount: 2,
          dockerConfigCount: 1,
          precommitConfigCount: 1,
          makefileExists: true,
          envExampleExists: true,
          npmScriptsCount: 10,
          contributingExists: true,
          readmeLines: 80,
          changelogExists: true,
        },
      }),
    );
    // 20+15+10+10+10+15+10+5+5 = 100
    expect(s.score).toBe(100);
  });

  it('awards npm-scripts tiers', () => {
    expect(scoreDeveloperExperience(withInput({ metrics: { npmScriptsCount: 1 } })).score).toBe(5);
    expect(scoreDeveloperExperience(withInput({ metrics: { npmScriptsCount: 4 } })).score).toBe(10);
    expect(scoreDeveloperExperience(withInput({ metrics: { npmScriptsCount: 8 } })).score).toBe(15);
  });
});

describe('computeOverall', () => {
  /** Build a dimension with only `score` set; rest is stubbed. */
  function dim(score: number): DimensionScore {
    return { score, maxScore: 100, status: 'critical', metrics: {}, details: '' };
  }

  it('applies weights: 25/20/10/20/10/15', () => {
    const result = computeOverall({
      testing: dim(80),
      quality: dim(60),
      documentation: dim(40),
      security: dim(70),
      maintainability: dim(50),
      developerExperience: dim(30),
    });
    // 80*0.25 + 60*0.20 + 40*0.10 + 70*0.20 + 50*0.10 + 30*0.15
    //  20     + 12     + 4      + 14     + 5      + 4.5     = 59.5 → 60
    expect(result.overallScore).toBe(60);
  });

  it('grade A at >=80', () => {
    expect(
      computeOverall({
        testing: dim(100),
        quality: dim(100),
        documentation: dim(100),
        security: dim(100),
        maintainability: dim(100),
        developerExperience: dim(100),
      }).grade,
    ).toBe('A');
    expect(
      computeOverall({
        testing: dim(80),
        quality: dim(80),
        documentation: dim(80),
        security: dim(80),
        maintainability: dim(80),
        developerExperience: dim(80),
      }).grade,
    ).toBe('A');
  });

  it('grade thresholds B/C/D/F', () => {
    const g = (s: number) =>
      computeOverall({
        testing: dim(s),
        quality: dim(s),
        documentation: dim(s),
        security: dim(s),
        maintainability: dim(s),
        developerExperience: dim(s),
      }).grade;
    expect(g(79)).toBe('B');
    expect(g(60)).toBe('B');
    expect(g(59)).toBe('C');
    expect(g(40)).toBe('C');
    expect(g(39)).toBe('D');
    expect(g(20)).toBe('D');
    expect(g(19)).toBe('F');
    expect(g(0)).toBe('F');
  });

  it('weights sum to 1.0 (round-trip with uniform scores)', () => {
    const result = computeOverall({
      testing: dim(50),
      quality: dim(50),
      documentation: dim(50),
      security: dim(50),
      maintainability: dim(50),
      developerExperience: dim(50),
    });
    expect(result.overallScore).toBe(50);
  });
});

describe('status bucketing', () => {
  it('maps score ranges to labels', () => {
    expect(
      scoreDocumentation(withInput({ metrics: { readmeExists: true, readmeLines: 15 } })).status,
    ).toBe('critical'); // 5
    expect(
      scoreDocumentation(withInput({ metrics: { readmeExists: true, readmeLines: 60 } })).status,
    ).toBe('poor'); // 20
    expect(
      scoreDocumentation(
        withInput({
          metrics: {
            sourceFiles: 100,
            readmeExists: true,
            readmeLines: 200,
            docCommentFiles: 60,
          },
        }),
      ).status,
    ).toBe('fair');
    expect(
      scoreDocumentation(
        withInput({
          metrics: {
            sourceFiles: 100,
            readmeExists: true,
            readmeLines: 200,
            docCommentFiles: 60,
            apiDocsExist: true,
          },
        }),
      ).status,
    ).toBe('good');
    expect(
      scoreDocumentation(
        withInput({
          metrics: {
            sourceFiles: 100,
            readmeExists: true,
            readmeLines: 200,
            docCommentFiles: 60,
            apiDocsExist: true,
            architectureDocsExist: true,
          },
        }),
      ).status,
    ).toBe('excellent');
  });
});
