/**
 * Health analyzer orchestrator.
 *
 * 1. detect() -> what stack is this?
 * 2. Run tools -> gather metrics (deterministic)
 * 3. Score metrics -> formulas (deterministic)
 * 4. Format report -> structured JSON
 */
import * as path from 'path';
import { detect } from '../detect';
import { DetectedStack } from '../types';
import { HealthMetrics, HealthReport } from './types';
import { gatherGenericMetrics } from './tools/generic';
import { gatherNodeMetrics } from './tools/node';
import { gatherClocMetrics } from './tools/cloc';
import { gatherGitleaksMetrics } from './tools/gitleaks';
import { gatherGraphifyMetrics } from './tools/graphify';
import {
  scoreTest,
  scoreQuality,
  scoreDocumentation,
  scoreSecurity,
  scoreMaintainability,
  scoreDeveloperExperience,
  computeOverall,
} from './scoring';
import { run } from './tools/runner';

/** Default values for all HealthMetrics fields. */
function defaultMetrics(): HealthMetrics {
  return {
    sourceFiles: 0,
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
    // Layer 2 -- null until tools provide data
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

/** Run a full health analysis on a repository. */
export function analyzeHealth(repoPath: string): HealthReport {
  // Step 1: Detect stack
  const stack = detect(repoPath);

  // Step 2: Gather metrics -- generic first, then language-specific, then optional
  const generic = gatherGenericMetrics(repoPath);
  const metrics: HealthMetrics = { ...defaultMetrics(), ...generic };

  // Layer 1: Language-specific tools
  if (stack.languages.node || stack.languages.nextjs) {
    mergeMetrics(metrics, gatherNodeMetrics(repoPath));
  }
  // TODO: Python, Go, Rust runners
  // if (stack.languages.python) mergeMetrics(metrics, gatherPythonMetrics(repoPath));
  // if (stack.languages.go) mergeMetrics(metrics, gatherGoMetrics(repoPath));

  // Layer 2: Optional enhanced tools
  mergeMetrics(metrics, gatherClocMetrics(repoPath));
  mergeMetrics(metrics, gatherGitleaksMetrics(repoPath));
  mergeMetrics(metrics, gatherGraphifyMetrics(repoPath));

  // Language breakdown -- prefer cloc data, fall back to detection
  metrics.languages = metrics.clocLanguages
    ? metrics.clocLanguages.map((l) => ({
        name: l.language,
        files: l.files,
        lines: l.code,
        percentage: 0, // computed below
      }))
    : buildLanguageBreakdown(stack);

  // Compute percentages from line counts
  const totalCodeLines = metrics.languages.reduce((sum, l) => sum + l.lines, 0);
  if (totalCodeLines > 0) {
    for (const lang of metrics.languages) {
      lang.percentage = Math.round((lang.lines / totalCodeLines) * 100);
    }
  }

  // Step 3: Score
  const dimensions = {
    testing: scoreTest(metrics),
    quality: scoreQuality(metrics),
    documentation: scoreDocumentation(metrics),
    security: scoreSecurity(metrics),
    maintainability: scoreMaintainability(metrics),
    developerExperience: scoreDeveloperExperience(metrics),
  };
  const { overallScore, grade } = computeOverall(dimensions);

  // Step 4: Format report
  const commitSha = run('git rev-parse --short HEAD 2>/dev/null', repoPath);
  const branch = run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath);

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha,
    branch,
    summary: { overallScore, grade },
    dimensions,
    languages: metrics.languages,
    toolsUsed: metrics.toolsUsed,
    toolsUnavailable: metrics.toolsUnavailable,
  };
}

/** Merge language-specific metrics into the base, preferring non-null values. */
function mergeMetrics(base: HealthMetrics, overlay: Partial<HealthMetrics>): void {
  for (const key of Object.keys(overlay)) {
    const value = (overlay as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;

    if (key === 'toolsUsed' && Array.isArray(value)) {
      base.toolsUsed.push(...(value as string[]));
    } else if (key === 'toolsUnavailable' && Array.isArray(value)) {
      base.toolsUnavailable.push(...(value as string[]));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (base as any)[key] = value;
    }
  }
}

/** Build language breakdown from detection results (fallback when cloc unavailable). */
function buildLanguageBreakdown(
  stack: DetectedStack,
): Array<{ name: string; files: number; lines: number; percentage: number }> {
  const langs: Array<{ name: string; files: number; lines: number; percentage: number }> = [];
  const detected = Object.entries(stack.languages).filter(([, v]) => v);

  for (const [name] of detected) {
    langs.push({ name, files: 0, lines: 0, percentage: 0 });
  }

  if (langs.length === 1) {
    langs[0].percentage = 100;
  } else if (langs.length > 1) {
    const pct = Math.round(100 / langs.length);
    for (const lang of langs) {
      lang.percentage = pct;
    }
  }

  return langs;
}
