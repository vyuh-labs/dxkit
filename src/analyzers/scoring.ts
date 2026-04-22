/**
 * Deterministic scoring formulas.
 *
 * Every score is computed from `ScoreInput` (metrics + capabilities) via
 * fixed formulas — same input, same score, every time.
 *
 * Phase 10e.C.2: scorers read capability-owned fields (lint counts,
 * dep-vuln counts, coverage percent, test framework, structural stats,
 * secret findings) from `input.capabilities`; metrics-owned fields
 * (sourceFiles, readmeLines, filesOver500Lines, etc.) still come from
 * `input.metrics`. The legacy `HealthMetrics` bridge is the source of
 * truth until C.7/C.8 narrows the type and drops the legacy fields.
 */
import { CapabilityReport, DimensionScore, HealthMetrics } from './types';

/**
 * Bundle of every signal a dimension scorer can read. Passed through the
 * shallow wrappers and `health/actions.ts` unchanged. Patches clone both
 * halves as needed.
 */
export interface ScoreInput {
  metrics: HealthMetrics;
  capabilities: CapabilityReport;
}

function status(score: number): DimensionScore['status'] {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'poor';
  return 'critical';
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

/**
 * Round a capability's coverage percent to match the legacy integer contract.
 * CoverageResult carries one decimal place; scoring thresholds and the
 * `Coverage: XX%` detail string both expect an integer.
 */
function coveragePercentFrom(c: CapabilityReport): number | null {
  const raw = c.coverage?.coverage.linePercent;
  return raw === undefined ? null : Math.round(raw);
}

/** Testing: 0-100 */
export function scoreTest(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const sourceCount = Math.max(m.sourceFiles, 1);
  const testRatio = m.testFiles / sourceCount;

  const coveragePercent = coveragePercentFrom(c);
  const testFramework = c.testFramework?.name ?? null;
  const commentedCodeRatio = c.structural?.commentedCodeRatio ?? null;

  let score: number;
  if (m.testFiles === 0) {
    score = 0;
  } else {
    score = Math.min(testRatio * 200, 60);
    if (m.coverageConfigExists) score += 10;
    if (m.testsPass === true) score += 15;
    if (coveragePercent !== null && coveragePercent >= 60) score += 10;
    if (coveragePercent !== null && coveragePercent >= 80) score += 5;
  }

  if (commentedCodeRatio !== null && commentedCodeRatio > 0.5) {
    score -= 15;
  }

  score = clamp(score);
  // Schema v11: `metrics` surfaces only the non-capability signals
  // (filesystem counts, derived ratios). Capability-owned values live in
  // `report.capabilities.coverage` / `testFramework` / `structural` so
  // downstream consumers read them from one place.
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      sourceFiles: m.sourceFiles,
      testFiles: m.testFiles,
      testRatio: Math.round(testRatio * 100) / 100,
      testsPass: m.testsPass,
      coverageConfigExists: m.coverageConfigExists,
    },
    details:
      m.testFiles === 0
        ? `No test files found across ${m.sourceFiles} source files. 0% test coverage.`
        : `${m.testFiles} test files for ${m.sourceFiles} source files (ratio: ${(testRatio * 100).toFixed(1)}%). ` +
          `Tests ${m.testsPass === true ? 'pass' : m.testsPass === false ? 'fail' : 'not run'}. ` +
          (coveragePercent !== null ? `Coverage: ${coveragePercent}%. ` : 'No coverage data. ') +
          (testFramework ? `Framework: ${testFramework}.` : '') +
          (commentedCodeRatio !== null && commentedCodeRatio > 0.5
            ? ` Warning: ${(commentedCodeRatio * 100).toFixed(0)}% of source files appear to contain only comments.`
            : ''),
  };
}

/** Code Quality: 0-100 */
export function scoreQuality(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const sourceCount = Math.max(m.sourceFiles, 1);

  const lintErrors = (c.lint?.counts.critical ?? 0) + (c.lint?.counts.high ?? 0);
  const lintWarnings = (c.lint?.counts.medium ?? 0) + (c.lint?.counts.low ?? 0);
  const lintTool = c.lint?.tool ?? null;
  const maxFunctionsInFile = c.structural?.maxFunctionsInFile ?? null;
  const deadImportCount = c.structural?.deadImportCount ?? null;

  let score = 100;

  if (lintErrors > 0) {
    const errorRatio = lintErrors / sourceCount;
    score -= Math.min(errorRatio * 100, 40);
  }

  if (m.filesOver500Lines > 5) score -= 10;
  if (m.filesOver500Lines > 20) score -= 10;
  if (m.largestFileLines > 5000) score -= 10;
  if (m.largestFileLines > 10000) score -= 10;

  const consoleDensity = m.consoleLogCount / sourceCount;
  if (consoleDensity > 3) score -= 15;
  else if (consoleDensity > 1) score -= 10;
  else if (consoleDensity > 0.3) score -= 5;

  const anyDensity = m.anyTypeCount / sourceCount;
  if (anyDensity > 10) score -= 15;
  else if (anyDensity > 5) score -= 10;
  else if (anyDensity > 1) score -= 5;

  if (m.typeErrors !== null && m.typeErrors > 0) {
    score -= Math.min((m.typeErrors / sourceCount) * 50, 15);
  }

  if (maxFunctionsInFile !== null && maxFunctionsInFile > 50) score -= 10;
  if (deadImportCount !== null && deadImportCount > 20) score -= 5;

  score = clamp(score);
  // Schema v11: `metrics` surfaces only the non-capability signals.
  // Lint counts + tool live in `report.capabilities.lint`; god-file +
  // dead-import stats live in `report.capabilities.structural`.
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      filesOver500Lines: m.filesOver500Lines,
      largestFileLines: m.largestFileLines,
      largestFilePath: m.largestFilePath,
      consoleLogCount: m.consoleLogCount,
      anyTypeCount: m.anyTypeCount,
      typeErrors: m.typeErrors,
    },
    details:
      `${lintErrors} lint errors, ${lintWarnings} warnings` +
      (lintTool ? ` (${lintTool})` : '') +
      `. ${m.filesOver500Lines} files exceed 500 lines` +
      `. Largest file: ${m.largestFilePath} (${m.largestFileLines} lines)` +
      `. ${m.consoleLogCount} console/debug statements` +
      (m.anyTypeCount > 0 ? `. ${m.anyTypeCount} loose type annotations` : '') +
      (maxFunctionsInFile !== null ? `. Densest file: ${maxFunctionsInFile} functions` : '') +
      '.',
  };
}

/** Documentation: 0-100 */
export function scoreDocumentation(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const sourceCount = Math.max(m.sourceFiles, 1);
  let score = 0;

  if (m.readmeExists) {
    if (m.readmeLines > 100) score += 25;
    else if (m.readmeLines > 50) score += 20;
    else if (m.readmeLines > 20) score += 15;
    else score += 5;
  }

  const docRatio = m.docCommentFiles / sourceCount;
  if (docRatio > 0.5) score += 25;
  else if (docRatio > 0.2) score += 15;
  else if (docRatio > 0.05) score += 5;

  if (m.apiDocsExist) score += 20;
  if (m.architectureDocsExist) score += 15;
  if (m.contributingExists) score += 10;
  if (m.changelogExists) score += 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      readmeExists: m.readmeExists,
      readmeLines: m.readmeLines,
      docCommentFiles: m.docCommentFiles,
      docRatio: Math.round(docRatio * 100) / 100,
      apiDocsExist: m.apiDocsExist,
      architectureDocsExist: m.architectureDocsExist,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `README: ${m.readmeExists ? `${m.readmeLines} lines` : 'missing'}` +
      `. ${m.docCommentFiles}/${m.sourceFiles} files have doc comments (${(docRatio * 100).toFixed(1)}%)` +
      `. API docs: ${m.apiDocsExist ? 'yes' : 'no'}` +
      `. Architecture docs: ${m.architectureDocsExist ? 'yes' : 'no'}` +
      `. Contributing: ${m.contributingExists ? 'yes' : 'no'}` +
      '.',
  };
}

/** Security: 0-100 */
export function scoreSecurity(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;

  const secretFindings = c.secrets?.findings.length ?? 0;
  const depVulnCritical = c.depVulns?.counts.critical ?? 0;
  const depVulnHigh = c.depVulns?.counts.high ?? 0;
  const depVulnMedium = c.depVulns?.counts.medium ?? 0;
  const depVulnLow = c.depVulns?.counts.low ?? 0;
  const depAuditTool = c.depVulns?.tool ?? null;

  let score = 100;

  if (secretFindings > 10) score -= 25;
  else if (secretFindings > 5) score -= 20;
  else if (secretFindings > 0) score -= 15;

  if (m.privateKeyFiles > 0) score -= 20;

  if (m.evalCount > 3) score -= 10;
  else if (m.evalCount > 0) score -= 5;

  if (m.envFilesInGit > 0) score -= 10;

  if (m.tlsDisabledCount > 0) score -= 10;

  if (depVulnCritical > 0) score -= 15;
  if (depVulnHigh > 5) score -= 10;
  else if (depVulnHigh > 0) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // Secret findings live in `report.capabilities.secrets`; dep-vuln
    // counts + audit-tool name live in `report.capabilities.depVulns`.
    metrics: {
      privateKeyFiles: m.privateKeyFiles,
      evalCount: m.evalCount,
      envFilesInGit: m.envFilesInGit,
      tlsDisabledCount: m.tlsDisabledCount,
    },
    details:
      `${secretFindings} hardcoded secret patterns found` +
      `. ${m.privateKeyFiles} private key files in repo` +
      `. ${m.evalCount} eval/exec calls` +
      `. ${m.envFilesInGit} .env files tracked in git` +
      `. ${m.tlsDisabledCount} TLS verification disabled` +
      `. Dependency vulns: ${depVulnCritical} critical, ${depVulnHigh} high, ${depVulnMedium} medium, ${depVulnLow} low` +
      (depAuditTool ? ` (${depAuditTool})` : '') +
      '.',
  };
}

/** Maintainability: 0-100 */
export function scoreMaintainability(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;

  const godNodeCount = c.structural?.godNodeCount ?? null;
  const communityCount = c.structural?.communityCount ?? null;
  const avgCohesion = c.structural?.avgCohesion ?? null;
  const orphanModuleCount = c.structural?.orphanModuleCount ?? null;

  let score = 70;

  if (m.largestFileLines > 10000) score -= 25;
  else if (m.largestFileLines > 5000) score -= 15;
  else if (m.largestFileLines > 2000) score -= 10;
  else if (m.largestFileLines > 1000) score -= 5;

  if (m.filesOver500Lines > 30) score -= 15;
  else if (m.filesOver500Lines > 15) score -= 10;
  else if (m.filesOver500Lines > 5) score -= 5;

  if (m.consoleLogCount > 500) score -= 10;
  else if (m.consoleLogCount > 100) score -= 5;

  if (m.nodeEngineVersion) {
    const majorMatch = m.nodeEngineVersion.match(/(\d+)/);
    if (majorMatch) {
      const major = parseInt(majorMatch[1]);
      if (major < 16) score -= 10;
      else if (major < 18) score -= 5;
    }
  }

  if (m.sourceFiles < 50) score += 10;
  if (m.sourceFiles < 20) score += 5;

  if (godNodeCount !== null) {
    const godRatio = godNodeCount / Math.max(m.sourceFiles, 1);
    if (godRatio > 0.1) score -= 10;
    else if (godRatio > 0.05) score -= 5;
  }
  if (avgCohesion !== null && avgCohesion < 0.15) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // AST-derived stats (god-node / community / cohesion / orphan module
    // counts) live in `report.capabilities.structural`.
    metrics: {
      sourceFiles: m.sourceFiles,
      controllers: m.controllers,
      models: m.models,
      directories: m.directories,
      largestFileLines: m.largestFileLines,
      filesOver500Lines: m.filesOver500Lines,
      nodeEngineVersion: m.nodeEngineVersion,
    },
    details:
      `${m.sourceFiles} source files across ${m.directories} directories` +
      `. ${m.controllers} controllers/handlers, ${m.models} models` +
      `. Largest file: ${m.largestFileLines} lines` +
      `. ${m.filesOver500Lines} files over 500 lines` +
      (m.nodeEngineVersion ? `. Node engine: ${m.nodeEngineVersion}` : '') +
      (communityCount !== null ? `. ${communityCount} architectural communities` : '') +
      (avgCohesion !== null ? `. Avg cohesion: ${avgCohesion.toFixed(2)}` : '') +
      '.',
  };
}

/** Developer Experience: 0-100 */
export function scoreDeveloperExperience(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  let score = 0;

  if (m.ciConfigCount > 0) score += 20;
  if (m.dockerConfigCount > 0) score += 15;
  if (m.precommitConfigCount > 0) score += 10;
  if (m.makefileExists) score += 10;
  if (m.envExampleExists) score += 10;

  if (m.npmScriptsCount >= 8) score += 15;
  else if (m.npmScriptsCount >= 4) score += 10;
  else if (m.npmScriptsCount >= 1) score += 5;

  if (m.contributingExists) score += 10;
  if (m.readmeLines > 50) score += 5;
  if (m.changelogExists) score += 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      ciConfigCount: m.ciConfigCount,
      dockerConfigCount: m.dockerConfigCount,
      precommitConfigCount: m.precommitConfigCount,
      makefileExists: m.makefileExists,
      envExampleExists: m.envExampleExists,
      npmScriptsCount: m.npmScriptsCount,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `CI configs: ${m.ciConfigCount}` +
      `. Docker: ${m.dockerConfigCount > 0 ? 'yes' : 'no'}` +
      `. Pre-commit hooks: ${m.precommitConfigCount > 0 ? 'yes' : 'no'}` +
      `. Makefile: ${m.makefileExists ? 'yes' : 'no'}` +
      `. .env.example: ${m.envExampleExists ? 'yes' : 'no'}` +
      `. npm scripts: ${m.npmScriptsCount}` +
      '.',
  };
}

/** Compute overall weighted score and grade. */
export function computeOverall(dimensions: {
  testing: DimensionScore;
  quality: DimensionScore;
  documentation: DimensionScore;
  security: DimensionScore;
  maintainability: DimensionScore;
  developerExperience: DimensionScore;
}): { overallScore: number; grade: 'A' | 'B' | 'C' | 'D' | 'F' } {
  const weights = {
    testing: 0.25,
    quality: 0.2,
    documentation: 0.1,
    security: 0.2,
    maintainability: 0.1,
    developerExperience: 0.15,
  };

  const overallScore = Math.round(
    dimensions.testing.score * weights.testing +
      dimensions.quality.score * weights.quality +
      dimensions.documentation.score * weights.documentation +
      dimensions.security.score * weights.security +
      dimensions.maintainability.score * weights.maintainability +
      dimensions.developerExperience.score * weights.developerExperience,
  );

  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (overallScore >= 80) grade = 'A';
  else if (overallScore >= 60) grade = 'B';
  else if (overallScore >= 40) grade = 'C';
  else if (overallScore >= 20) grade = 'D';
  else grade = 'F';

  return { overallScore, grade };
}
