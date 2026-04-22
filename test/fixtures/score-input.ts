/**
 * Shared test fixtures for the `ScoreInput` shape (`HealthMetrics` +
 * `CapabilityReport`).
 *
 * The scorers in `src/analyzers/scoring.ts` consume capability envelopes
 * for the fields owned by the dispatcher (lint tier counts, dep-vuln
 * counts, coverage percent, test framework, secret findings, structural
 * stats). Tests construct both halves via the helpers below so fixtures
 * mirror real-run shapes without re-stating envelope schema versions or
 * empty defaults in every spec.
 */
import { CapabilityReport, HealthMetrics } from '../../src/analyzers/types';
import { ScoreInput } from '../../src/analyzers/scoring';
import type {
  CoverageResult,
  DepVulnResult,
  LintResult,
  SecretsResult,
  SecretFinding,
  StructuralResult,
  TestFrameworkResult,
} from '../../src/languages/capabilities/types';

/** Neutral baseline: no signal in either direction, 100 source files. */
export function baseMetrics(): HealthMetrics {
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

export function lintCapability(
  critical: number,
  high: number,
  medium = 0,
  low = 0,
  tool = 'eslint',
): LintResult {
  return {
    schemaVersion: 1,
    tool,
    counts: { critical, high, medium, low },
  };
}

export function depVulnCapability(
  critical: number,
  high: number,
  medium = 0,
  low = 0,
  tool = 'npm-audit',
): DepVulnResult {
  return {
    schemaVersion: 1,
    tool,
    enrichment: null,
    counts: { critical, high, medium, low },
  };
}

export function coverageCapability(
  linePercent: number,
  tool = 'coverage:istanbul-summary',
): CoverageResult {
  return {
    schemaVersion: 1,
    tool,
    coverage: {
      source: 'istanbul-summary',
      sourceFile: 'coverage/coverage-summary.json',
      linePercent,
      files: new Map(),
    },
  };
}

export function testFrameworkCapability(name: string, tool = 'typescript'): TestFrameworkResult {
  return { schemaVersion: 1, tool, name };
}

export function secretsCapability(
  findings: SecretFinding[] = [],
  tool = 'gitleaks',
  suppressedCount = 0,
): SecretsResult {
  return { schemaVersion: 1, tool, findings, suppressedCount };
}

/** Convenience: one generic secret finding per requested count. */
export function secretsCapabilityWithCount(count: number, tool = 'gitleaks'): SecretsResult {
  const findings: SecretFinding[] = Array.from({ length: count }, (_, i) => ({
    file: `src/leaked-${i}.ts`,
    line: 1,
    rule: 'generic-api-key',
    severity: 'high',
  }));
  return secretsCapability(findings, tool);
}

/**
 * Defaults are "neutral" — chosen so that a structural envelope with only
 * one field overridden does not incidentally trigger any OTHER field's
 * penalty. In particular `avgCohesion: 1.0` keeps the cohesion penalty off
 * (the scorer deducts when `avgCohesion < 0.15`); zero is a valid value but
 * would flip the penalty on for tests that only care about god-node ratio
 * or similar.
 */
export function structuralCapability(
  overrides: Partial<Omit<StructuralResult, 'schemaVersion' | 'tool'>> = {},
  tool = 'graphify',
): StructuralResult {
  return {
    schemaVersion: 1,
    tool,
    functionCount: 0,
    classCount: 0,
    maxFunctionsInFile: 0,
    maxFunctionsFilePath: '',
    godNodeCount: 0,
    communityCount: 0,
    avgCohesion: 1,
    orphanModuleCount: 0,
    deadImportCount: 0,
    commentedCodeRatio: 0,
    ...overrides,
  };
}

export interface ScoreInputOverrides {
  metrics?: Partial<HealthMetrics>;
  capabilities?: Partial<CapabilityReport>;
}

export function withInput(overrides: ScoreInputOverrides = {}): ScoreInput {
  return {
    metrics: { ...baseMetrics(), ...overrides.metrics },
    capabilities: { ...overrides.capabilities },
  };
}
