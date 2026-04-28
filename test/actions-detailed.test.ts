/**
 * Tests for actions.ts + detailed.ts modules across the 5 analyzers.
 *
 * These are pure transformation functions: they take a report (or report +
 * metrics) and return a list of remediation actions or a detailed report.
 * Test by hand-crafting minimal but realistic input shapes and asserting
 * on the structure of the output. No filesystem or tool execution.
 */
import { describe, it, expect } from 'vitest';

import {
  countsFromReport as securityCountsFromReport,
  buildSecurityActions,
} from '../src/analyzers/security/actions';
import {
  buildSecurityDetailed,
  formatSecurityDetailedMarkdown,
} from '../src/analyzers/security/detailed';

import { buildSlopActions } from '../src/analyzers/quality/actions';
import {
  buildQualityDetailed,
  formatQualityDetailedMarkdown,
} from '../src/analyzers/quality/detailed';

import {
  countsFromReport as testsCountsFromReport,
  buildTestGapsActions,
} from '../src/analyzers/tests/actions';
import {
  buildTestGapsDetailed,
  formatTestGapsDetailedMarkdown,
} from '../src/analyzers/tests/detailed';

import { buildHealthPlans } from '../src/analyzers/health/actions';
import {
  buildHealthDetailed,
  formatHealthDetailedMarkdown,
} from '../src/analyzers/health/detailed';

import {
  buildObservations,
  buildDevDetailed,
  formatDevDetailedMarkdown,
} from '../src/analyzers/developer/detailed';

import { SecurityReport } from '../src/analyzers/security/types';
import { QualityReport, QualityMetrics } from '../src/analyzers/quality/types';
import { TestGapsReport } from '../src/analyzers/tests/types';
import { CapabilityReport, HealthReport, HealthMetrics } from '../src/analyzers/types';
import { ScoreInput } from '../src/analyzers/scoring';
import { DevReport } from '../src/analyzers/developer/types';
import {
  depVulnCapability,
  lintCapability,
  secretsCapabilityWithCount,
  structuralCapability,
  testFrameworkCapability,
} from './fixtures/score-input';

// ── Fixtures ────────────────────────────────────────────────────────────

function securityReport(overrides: Partial<SecurityReport> = {}): SecurityReport {
  return {
    repo: 'test',
    analyzedAt: '2026-04-16T00:00:00Z',
    commitSha: 'abc123',
    branch: 'main',
    summary: {
      findings: { critical: 2, high: 5, medium: 10, low: 3, total: 20 },
      dependencies: {
        critical: 1,
        high: 3,
        medium: 8,
        low: 2,
        total: 14,
        tool: 'npm-audit',
        findings: [],
      },
    },
    findings: [
      {
        rule: 'hardcoded-secret',
        severity: 'critical',
        file: 'src/config.ts',
        line: 42,
        message: 'API key found',
        tool: 'gitleaks',
      },
      {
        rule: 'eval-usage',
        severity: 'high',
        file: 'src/parser.ts',
        line: 100,
        message: 'eval() use',
        tool: 'semgrep',
      },
    ],
    toolsUsed: ['gitleaks', 'semgrep', 'npm-audit'],
    toolsUnavailable: [],
    ...overrides,
  } as SecurityReport;
}

function qualityMetrics(overrides: Partial<QualityMetrics> = {}): QualityMetrics {
  return {
    lintErrors: 5,
    lintWarnings: 12,
    consoleLogCount: 25,
    todoCount: 8,
    fixmeCount: 4,
    hackCount: 1,
    staleFiles: ['src/old.ts'],
    duplication: { percentage: 3.2, cloneCount: 7, topClones: [] },
    maxFunctionsInFile: 22,
    deadImportCount: 4,
    mixedLanguages: false,
    commentRatio: 0.12,
    orphanModuleCount: 2,
    functionCount: 200,
    topConsoleFiles: [{ path: 'src/x.ts', count: 10 }],
    topTodoFiles: [{ path: 'src/y.ts', count: 5 }],
    ...overrides,
  } as QualityMetrics;
}

function qualityReport(overrides: Partial<QualityReport> = {}): QualityReport {
  return {
    repo: 'test',
    analyzedAt: '2026-04-16T00:00:00Z',
    commitSha: 'abc123',
    branch: 'main',
    metrics: qualityMetrics(),
    slopScore: 75,
    toolsUsed: ['eslint'],
    toolsUnavailable: [],
    ...overrides,
  } as QualityReport;
}

function testGapsReport(overrides: Partial<TestGapsReport> = {}): TestGapsReport {
  return {
    repo: 'test',
    analyzedAt: '2026-04-16T00:00:00Z',
    commitSha: 'abc123',
    branch: 'main',
    summary: {
      testFiles: 10,
      activeTestFiles: 9,
      commentedOutFiles: 1,
      effectiveCoverage: 45,
      coverageSource: 'import-graph',
      sourceFiles: 50,
      untestedCritical: 3,
      untestedHigh: 2,
      untestedMedium: 5,
      untestedLow: 18,
    },
    testFiles: [{ path: 'test/a.test.ts', status: 'active', framework: 'vitest' }],
    gaps: [
      {
        path: 'src/auth.ts',
        lines: 200,
        type: 'service',
        risk: 'critical',
        hasMatchingTest: false,
      },
      { path: 'src/util.ts', lines: 50, type: 'other', risk: 'low', hasMatchingTest: false },
    ],
    toolsUsed: ['find', 'grep'],
    toolsUnavailable: [],
    ...overrides,
  } as TestGapsReport;
}

function healthMetrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    sourceFiles: 50,
    testFiles: 5,
    totalLines: 5000,
    testsPass: null,
    testsPassing: 0,
    testsFailing: 0,
    coverageConfigExists: false,
    typeErrors: null,
    filesOver500Lines: 2,
    largestFileLines: 800,
    largestFilePath: 'src/big.ts',
    consoleLogCount: 20,
    anyTypeCount: 15,
    readmeExists: true,
    readmeLines: 100,
    docCommentFiles: 5,
    apiDocsExist: false,
    architectureDocsExist: false,
    contributingExists: false,
    changelogExists: false,
    evalCount: 1,
    privateKeyFiles: 0,
    envFilesInGit: 0,
    tlsDisabledCount: 0,
    controllers: 5,
    models: 8,
    directories: 10,
    languages: [{ name: 'TypeScript', files: 50, lines: 5000, percentage: 100 }],
    nodeEngineVersion: '18.0.0',
    ciConfigCount: 1,
    dockerConfigCount: 1,
    precommitConfigCount: 0,
    makefileExists: false,
    envExampleExists: true,
    npmScriptsCount: 6,
    toolsUsed: [],
    toolsUnavailable: [],
    clocLanguages: null,
    ...overrides,
  };
}

/**
 * Capability fixture mirroring the legacy `healthMetrics()` signals: 3 lint
 * errors / 8 warnings, vitest framework, 2 high + 5 medium + 1 low dep
 * vulns, 1 gitleaks hit, graphify stats matching the legacy values.
 */
function healthCapabilities(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    lint: lintCapability(0, 3, 8, 0),
    testFramework: testFrameworkCapability('vitest'),
    depVulns: depVulnCapability(0, 2, 5, 1, 'npm-audit'),
    secrets: secretsCapabilityWithCount(1, 'gitleaks'),
    structural: structuralCapability({
      functionCount: 100,
      classCount: 20,
      maxFunctionsInFile: 18,
      maxFunctionsFilePath: 'src/util.ts',
      godNodeCount: 1,
      communityCount: 5,
      avgCohesion: 0.4,
      orphanModuleCount: 2,
      deadImportCount: 4,
      commentedCodeRatio: 0.05,
    }),
    ...overrides,
  };
}

function healthInput(
  metrics: HealthMetrics,
  capabilities: CapabilityReport = healthCapabilities(),
): ScoreInput {
  return { metrics, capabilities };
}

function healthReport(metrics: HealthMetrics, capabilities?: CapabilityReport): HealthReport {
  // Minimal report with placeholder dimension scores — actions/detailed
  // builders look at metrics + capabilities, the report is just for echo.
  const dim = (score: number) => ({
    score,
    maxScore: 100,
    status: 'good' as const,
    metrics: {},
    details: '',
  });
  return {
    repo: 'test',
    analyzedAt: '2026-04-16T00:00:00Z',
    commitSha: 'abc123',
    branch: 'main',
    summary: { overallScore: 70, grade: 'B' as const },
    dimensions: {
      testing: dim(60),
      quality: dim(70),
      documentation: dim(65),
      security: dim(75),
      maintainability: dim(70),
      developerExperience: dim(70),
    },
    languages: metrics.languages,
    toolsUsed: ['cloc', 'gitleaks'],
    toolsUnavailable: [],
    capabilities: capabilities ?? healthCapabilities(),
  };
}

function devReport(): DevReport {
  return {
    repo: 'test',
    analyzedAt: '2026-04-16T00:00:00Z',
    commitSha: 'abc123',
    branch: 'main',
    period: { since: '2026-01-16', until: '2026-04-16' },
    summary: {
      totalCommits: 50,
      nonMergeCommits: 45,
      mergeCommits: 5,
      mergeRatio: 0.1,
      contributors: 3,
    },
    commitQuality: {
      conventional: 35,
      descriptive: 8,
      vague: 7,
      total: 50,
      conventionalPercent: 70,
    },
    contributors: [
      {
        name: 'Alice',
        commits: 30,
        linesAdded: 1500,
        linesRemoved: 400,
        netChange: 1100,
        mergeCommits: 2,
      },
    ],
    hotFiles: [{ path: 'src/cli.ts', changes: 18 }],
    velocity: [{ week: '2026-04-13', commits: 5 }],
    toolsUsed: ['git'],
    toolsUnavailable: [],
  } as DevReport;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('security/actions', () => {
  it('countsFromReport projects findings + deps into SecurityCounts', () => {
    const c = securityCountsFromReport(securityReport());
    expect(c.critical).toBe(2);
    expect(c.high).toBe(5);
    expect(c.depCritical).toBe(1);
    expect(c.depHigh).toBe(3);
  });

  it('buildSecurityActions returns ranked actions', () => {
    const actions = buildSecurityActions(securityReport());
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.id).toBeTruthy();
      expect(a.title).toBeTruthy();
      expect(typeof a.patch).toBe('function');
    }
  });

  it('buildSecurityActions returns empty list when there are no findings', () => {
    const clean = securityReport({
      summary: {
        findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        dependencies: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          total: 0,
          tool: null,
          findings: [],
        },
      },
      findings: [],
    });
    expect(buildSecurityActions(clean)).toEqual([]);
  });
});

describe('security/detailed', () => {
  it('buildSecurityDetailed produces a structured report', () => {
    const d = buildSecurityDetailed(securityReport());
    expect(d.schemaVersion).toBeTruthy();
    expect(d.actions).toBeDefined();
    expect(Array.isArray(d.actions)).toBe(true);
  });

  it('formatSecurityDetailedMarkdown produces non-empty markdown', () => {
    const d = buildSecurityDetailed(securityReport());
    const md = formatSecurityDetailedMarkdown(d, '1.0');
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain('#');
  });
});

describe('quality/actions', () => {
  it('buildSlopActions returns actions when there are issues', () => {
    const actions = buildSlopActions(qualityMetrics());
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.id).toBeTruthy();
      expect(typeof a.patch).toBe('function');
    }
  });

  it('buildSlopActions returns empty for clean metrics', () => {
    const clean = qualityMetrics({
      lintErrors: 0,
      consoleLogCount: 0,
      todoCount: 0,
      fixmeCount: 0,
      hackCount: 0,
      staleFiles: [],
      duplication: {
        totalLines: 0,
        duplicatedLines: 0,
        percentage: 0,
        cloneCount: 0,
        topClones: [],
      },
      deadImportCount: 0,
      orphanModuleCount: 0,
    });
    const actions = buildSlopActions(clean);
    expect(actions.length).toBe(0);
  });
});

describe('quality/detailed', () => {
  it('buildQualityDetailed structures the report', () => {
    const d = buildQualityDetailed(qualityReport());
    expect(d).toBeDefined();
    expect(d.actions).toBeDefined();
  });

  it('formatQualityDetailedMarkdown produces markdown with actions', () => {
    const d = buildQualityDetailed(qualityReport());
    const md = formatQualityDetailedMarkdown(d, '1.0');
    expect(md.length).toBeGreaterThan(100);
  });
});

describe('tests/actions', () => {
  it('countsFromReport derives counts from summary', () => {
    const c = testsCountsFromReport(testGapsReport());
    expect(c.untestedCritical).toBe(3);
    expect(c.untestedLow).toBe(18);
    expect(c.commentedOutFiles).toBe(1);
    expect(c.testedSource).toBe(48); // 50 sourceFiles - 2 gaps
  });

  it('buildTestGapsActions returns actions for non-empty gaps', () => {
    const actions = buildTestGapsActions(testGapsReport());
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].id).toMatch(/tests/);
  });

  it('buildTestGapsActions returns empty when nothing needs action', () => {
    const clean = testGapsReport({
      summary: {
        ...testGapsReport().summary,
        untestedCritical: 0,
        untestedHigh: 0,
        untestedMedium: 0,
        untestedLow: 0,
        commentedOutFiles: 0,
      },
      gaps: [],
    });
    expect(buildTestGapsActions(clean)).toEqual([]);
  });
});

describe('tests/detailed', () => {
  it('buildTestGapsDetailed structures the report', () => {
    const d = buildTestGapsDetailed(testGapsReport());
    expect(d).toBeDefined();
    expect(d.actions).toBeDefined();
  });

  it('formatTestGapsDetailedMarkdown produces markdown', () => {
    const d = buildTestGapsDetailed(testGapsReport());
    const md = formatTestGapsDetailedMarkdown(d, '1.0');
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain('Test');
  });
});

describe('health/actions', () => {
  it('buildHealthPlans returns one plan per dimension', () => {
    const plans = buildHealthPlans(healthInput(healthMetrics()));
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.dimension).toBeTruthy();
      expect(Array.isArray(p.actions)).toBe(true);
    }
  });

  it('buildHealthPlans includes more actions for problematic metrics', () => {
    const badInput = healthInput(
      healthMetrics({ consoleLogCount: 500, anyTypeCount: 200, privateKeyFiles: 3 }),
      healthCapabilities({
        lint: lintCapability(0, 100, 0, 0),
        secrets: secretsCapabilityWithCount(5),
        depVulns: depVulnCapability(5, 0, 0, 0, 'npm-audit'),
      }),
    );
    const cleanInput = healthInput(
      healthMetrics({ consoleLogCount: 0 }),
      healthCapabilities({ lint: lintCapability(0, 0, 0, 0) }),
    );
    const cleanPlans = buildHealthPlans(cleanInput);
    const badPlans = buildHealthPlans(badInput);
    const cleanCount = cleanPlans.reduce((sum, p) => sum + p.actions.length, 0);
    const badCount = badPlans.reduce((sum, p) => sum + p.actions.length, 0);
    expect(badCount).toBeGreaterThanOrEqual(cleanCount);
  });
});

describe('health/detailed', () => {
  it('buildHealthDetailed combines report + metrics', () => {
    const m = healthMetrics();
    const r = healthReport(m);
    const d = buildHealthDetailed(r, m);
    expect(d).toBeDefined();
    expect(d.plans).toBeDefined();
  });

  it('formatHealthDetailedMarkdown produces markdown with dimensions', () => {
    const m = healthMetrics();
    const r = healthReport(m);
    const d = buildHealthDetailed(r, m);
    const md = formatHealthDetailedMarkdown(d, '1.0');
    expect(md.length).toBeGreaterThan(100);
  });
});

describe('developer/detailed', () => {
  it('buildObservations returns observations from a report', () => {
    const obs = buildObservations(devReport());
    expect(Array.isArray(obs)).toBe(true);
  });

  it('buildDevDetailed structures the report', () => {
    const d = buildDevDetailed(devReport());
    expect(d).toBeDefined();
    expect(d.observations).toBeDefined();
  });

  it('buildDevDetailed accepts vague-commit examples', () => {
    const d = buildDevDetailed(devReport(), ['fix stuff', 'wip']);
    expect(d).toBeDefined();
  });

  it('formatDevDetailedMarkdown produces markdown', () => {
    const d = buildDevDetailed(devReport());
    const md = formatDevDetailedMarkdown(d, '1.0');
    expect(md.length).toBeGreaterThan(50);
  });
});
