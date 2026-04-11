/**
 * Deterministic scoring formulas.
 *
 * Every score is computed from metrics via fixed formulas.
 * Same metrics -> same score, every time.
 */
import { HealthMetrics, DimensionScore } from './types';

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

/** Testing: 0-100 */
export function scoreTest(m: HealthMetrics): DimensionScore {
  const sourceCount = Math.max(m.sourceFiles, 1);
  const testRatio = m.testFiles / sourceCount;

  let score: number;
  if (m.testFiles === 0) {
    score = 0;
  } else {
    score = Math.min(testRatio * 200, 60);
    if (m.coverageConfigExists) score += 10;
    if (m.testsPass === true) score += 15;
    if (m.coveragePercent !== null && m.coveragePercent >= 60) score += 10;
    if (m.coveragePercent !== null && m.coveragePercent >= 80) score += 5;
  }

  // AST enhancement: detect commented-out code files
  if (m.commentedCodeRatio !== null && m.commentedCodeRatio > 0.5) {
    score -= 15;
  }

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      sourceFiles: m.sourceFiles,
      testFiles: m.testFiles,
      testRatio: Math.round(testRatio * 100) / 100,
      testsPass: m.testsPass,
      coveragePercent: m.coveragePercent,
      coverageConfigExists: m.coverageConfigExists,
      testFramework: m.testFramework,
      commentedCodeRatio: m.commentedCodeRatio,
    },
    details:
      m.testFiles === 0
        ? `No test files found across ${m.sourceFiles} source files. 0% test coverage.`
        : `${m.testFiles} test files for ${m.sourceFiles} source files (ratio: ${(testRatio * 100).toFixed(1)}%). ` +
          `Tests ${m.testsPass === true ? 'pass' : m.testsPass === false ? 'fail' : 'not run'}. ` +
          (m.coveragePercent !== null
            ? `Coverage: ${m.coveragePercent}%. `
            : 'No coverage data. ') +
          (m.testFramework ? `Framework: ${m.testFramework}.` : '') +
          (m.commentedCodeRatio !== null && m.commentedCodeRatio > 0.5
            ? ` Warning: ${(m.commentedCodeRatio * 100).toFixed(0)}% of source files appear to contain only comments.`
            : ''),
  };
}

/** Code Quality: 0-100 */
export function scoreQuality(m: HealthMetrics): DimensionScore {
  const sourceCount = Math.max(m.sourceFiles, 1);
  let score = 100;

  // Lint errors
  if (m.lintErrors > 0) {
    const errorRatio = m.lintErrors / sourceCount;
    score -= Math.min(errorRatio * 100, 40);
  }

  // Large files
  if (m.filesOver500Lines > 5) score -= 10;
  if (m.filesOver500Lines > 20) score -= 10;
  if (m.largestFileLines > 5000) score -= 10;
  if (m.largestFileLines > 10000) score -= 10;

  // Console/debug statements
  const consoleDensity = m.consoleLogCount / sourceCount;
  if (consoleDensity > 3) score -= 15;
  else if (consoleDensity > 1) score -= 10;
  else if (consoleDensity > 0.3) score -= 5;

  // Loose typing
  const anyDensity = m.anyTypeCount / sourceCount;
  if (anyDensity > 10) score -= 15;
  else if (anyDensity > 5) score -= 10;
  else if (anyDensity > 1) score -= 5;

  // Type errors
  if (m.typeErrors !== null && m.typeErrors > 0) {
    score -= Math.min((m.typeErrors / sourceCount) * 50, 15);
  }

  // AST enhancements
  if (m.maxFunctionsInFile !== null && m.maxFunctionsInFile > 50) score -= 10;
  if (m.deadImportCount !== null && m.deadImportCount > 20) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      lintErrors: m.lintErrors,
      lintWarnings: m.lintWarnings,
      lintTool: m.lintTool,
      filesOver500Lines: m.filesOver500Lines,
      largestFileLines: m.largestFileLines,
      largestFilePath: m.largestFilePath,
      consoleLogCount: m.consoleLogCount,
      anyTypeCount: m.anyTypeCount,
      typeErrors: m.typeErrors,
      maxFunctionsInFile: m.maxFunctionsInFile,
      deadImportCount: m.deadImportCount,
    },
    details:
      `${m.lintErrors} lint errors, ${m.lintWarnings} warnings` +
      (m.lintTool ? ` (${m.lintTool})` : '') +
      `. ${m.filesOver500Lines} files exceed 500 lines` +
      `. Largest file: ${m.largestFilePath} (${m.largestFileLines} lines)` +
      `. ${m.consoleLogCount} console/debug statements` +
      (m.anyTypeCount > 0 ? `. ${m.anyTypeCount} loose type annotations` : '') +
      (m.maxFunctionsInFile !== null ? `. Densest file: ${m.maxFunctionsInFile} functions` : '') +
      '.',
  };
}

/** Documentation: 0-100 */
export function scoreDocumentation(m: HealthMetrics): DimensionScore {
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
export function scoreSecurity(m: HealthMetrics): DimensionScore {
  let score = 100;

  // Hardcoded secrets (max -25)
  if (m.secretFindings > 10) score -= 25;
  else if (m.secretFindings > 5) score -= 20;
  else if (m.secretFindings > 0) score -= 15;

  // Private keys in repo (max -20)
  if (m.privateKeyFiles > 0) score -= 20;

  // eval/exec (max -10)
  if (m.evalCount > 3) score -= 10;
  else if (m.evalCount > 0) score -= 5;

  // .env in git (max -10)
  if (m.envFilesInGit > 0) score -= 10;

  // TLS disabled (max -10)
  if (m.tlsDisabledCount > 0) score -= 10;

  // Dependency vulnerabilities (max -25)
  if (m.depVulnCritical > 0) score -= 15;
  if (m.depVulnHigh > 5) score -= 10;
  else if (m.depVulnHigh > 0) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      secretFindings: m.secretFindings,
      privateKeyFiles: m.privateKeyFiles,
      evalCount: m.evalCount,
      envFilesInGit: m.envFilesInGit,
      tlsDisabledCount: m.tlsDisabledCount,
      depVulnCritical: m.depVulnCritical,
      depVulnHigh: m.depVulnHigh,
      depVulnMedium: m.depVulnMedium,
      depVulnLow: m.depVulnLow,
      depAuditTool: m.depAuditTool,
    },
    details:
      `${m.secretFindings} hardcoded secret patterns found` +
      `. ${m.privateKeyFiles} private key files in repo` +
      `. ${m.evalCount} eval/exec calls` +
      `. ${m.envFilesInGit} .env files tracked in git` +
      `. ${m.tlsDisabledCount} TLS verification disabled` +
      `. Dependency vulns: ${m.depVulnCritical} critical, ${m.depVulnHigh} high, ${m.depVulnMedium} medium, ${m.depVulnLow} low` +
      (m.depAuditTool ? ` (${m.depAuditTool})` : '') +
      '.',
  };
}

/** Maintainability: 0-100 */
export function scoreMaintainability(m: HealthMetrics): DimensionScore {
  let score = 70;

  // God files penalty
  if (m.largestFileLines > 10000) score -= 25;
  else if (m.largestFileLines > 5000) score -= 15;
  else if (m.largestFileLines > 2000) score -= 10;
  else if (m.largestFileLines > 1000) score -= 5;

  if (m.filesOver500Lines > 30) score -= 15;
  else if (m.filesOver500Lines > 15) score -= 10;
  else if (m.filesOver500Lines > 5) score -= 5;

  if (m.consoleLogCount > 500) score -= 10;
  else if (m.consoleLogCount > 100) score -= 5;

  // Outdated Node engine
  if (m.nodeEngineVersion) {
    const majorMatch = m.nodeEngineVersion.match(/(\d+)/);
    if (majorMatch) {
      const major = parseInt(majorMatch[1]);
      if (major < 16) score -= 10;
      else if (major < 18) score -= 5;
    }
  }

  // Small codebase bonus
  if (m.sourceFiles < 50) score += 10;
  if (m.sourceFiles < 20) score += 5;

  // AST enhancements (calibrated for real-world repos)
  if (m.godNodeCount !== null) {
    const godRatio = m.godNodeCount / Math.max(m.sourceFiles, 1);
    if (godRatio > 0.1) score -= 10;
    else if (godRatio > 0.05) score -= 5;
  }
  if (m.avgCohesion !== null && m.avgCohesion < 0.15) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    status: status(score),
    metrics: {
      sourceFiles: m.sourceFiles,
      controllers: m.controllers,
      models: m.models,
      directories: m.directories,
      largestFileLines: m.largestFileLines,
      filesOver500Lines: m.filesOver500Lines,
      nodeEngineVersion: m.nodeEngineVersion,
      godNodeCount: m.godNodeCount,
      communityCount: m.communityCount,
      avgCohesion: m.avgCohesion,
      orphanModuleCount: m.orphanModuleCount,
    },
    details:
      `${m.sourceFiles} source files across ${m.directories} directories` +
      `. ${m.controllers} controllers/handlers, ${m.models} models` +
      `. Largest file: ${m.largestFileLines} lines` +
      `. ${m.filesOver500Lines} files over 500 lines` +
      (m.nodeEngineVersion ? `. Node engine: ${m.nodeEngineVersion}` : '') +
      (m.communityCount !== null ? `. ${m.communityCount} architectural communities` : '') +
      (m.avgCohesion !== null ? `. Avg cohesion: ${m.avgCohesion.toFixed(2)}` : '') +
      '.',
  };
}

/** Developer Experience: 0-100 */
export function scoreDeveloperExperience(m: HealthMetrics): DimensionScore {
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
