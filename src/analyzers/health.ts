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
import { CapabilityReport, HealthMetrics, HealthReport } from './types';
import { gatherGenericMetrics } from './tools/generic';
import { gatherLayer2Parallel } from './tools/parallel';
import { loadCoverage } from './tools/coverage';
import { gatherPackageJsonMetrics } from './tools/package-json';
import { detectActiveLanguages } from '../languages';
import { timed, timedAsync } from './tools/timing';
import { defaultDispatcher } from './dispatcher';
import {
  CODE_PATTERNS,
  COVERAGE,
  DEP_VULNS,
  DUPLICATION,
  IMPORTS,
  LINT,
  SECRETS,
  STRUCTURAL,
  TEST_FRAMEWORK,
} from '../languages/capabilities/descriptors';
import { providersFor } from '../languages/capabilities';
import type { CapabilityProvider } from '../languages/capabilities/provider';
import type { TestFrameworkResult } from '../languages/capabilities/types';
import { scoreTestsDimension } from './tests/shallow';
import { scoreQualityDimension } from './quality/shallow';
import { scoreDocsDimension } from './docs/shallow';
import { scoreSecurityDimension } from './security/shallow';
import { scoreMaintainabilityDimension } from './maintainability/shallow';
import { scoreDxDimension } from './dx/shallow';
import { computeOverall, ScoreInput } from './scoring';
import { run } from './tools/runner';

/** Default values for all HealthMetrics fields. */
export function defaultMetrics(): HealthMetrics {
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

/** Options for analyzeHealth. */
export interface AnalyzeHealthOptions {
  /** Print per-tool timing to stderr. */
  verbose?: boolean;
}

/**
 * Run a full health analysis on a repository, returning both the summary
 * report and the underlying metrics. Used by --detailed to feed the
 * remediation planner without re-running the tool gather.
 */
export async function analyzeHealthWithMetrics(
  repoPath: string,
  options: AnalyzeHealthOptions = {},
): Promise<{ report: HealthReport; metrics: HealthMetrics }> {
  return analyzeHealthInternal(repoPath, options);
}

/** Run a full health analysis on a repository. */
export async function analyzeHealth(
  repoPath: string,
  options: AnalyzeHealthOptions = {},
): Promise<HealthReport> {
  return (await analyzeHealthInternal(repoPath, options)).report;
}

async function analyzeHealthInternal(
  repoPath: string,
  options: AnalyzeHealthOptions = {},
): Promise<{ report: HealthReport; metrics: HealthMetrics }> {
  const verbose = !!options.verbose;

  // Step 1: Detect stack
  const stack = timed('detect', verbose, () => detect(repoPath));

  // Step 2: Gather metrics -- generic first, then language-specific, then optional
  const generic = timed('generic (Layer 0)', verbose, () => gatherGenericMetrics(repoPath));
  const metrics: HealthMetrics = { ...defaultMetrics(), ...generic };

  const activeLangs = detectActiveLanguages(repoPath);

  // testFramework legacy-field populator: capability dispatcher resolves
  // across active packs (last-wins aggregate) and we keep `metrics.testFramework`
  // in sync for the handful of pre-2.0 consumers. C.7 narrows
  // `HealthMetrics` and the capability envelope becomes the only source.
  const tfProviders: CapabilityProvider<TestFrameworkResult>[] = [];
  for (const lang of activeLangs) {
    const p = lang.capabilities?.testFramework;
    if (p) tfProviders.push(p);
  }
  const tfResult = await timedAsync('testFramework', verbose, () =>
    defaultDispatcher.gather(repoPath, TEST_FRAMEWORK, tfProviders),
  );
  if (tfResult) metrics.testFramework = tfResult.name;

  // `package.json` metrics: npm-script count + `engines.node` pin. These
  // don't fit any capability (Node-specific by nature) and used to live
  // in the typescript pack's `gatherMetrics` body; extracted in C.5 into
  // a direct helper so they survive the per-pack channel deletion.
  const pkg = timed('package.json', verbose, () => gatherPackageJsonMetrics(repoPath));
  metrics.npmScriptsCount = pkg.npmScriptsCount;
  metrics.nodeEngineVersion = pkg.nodeEngineVersion;

  // Layer 2: Optional enhanced tools (run in parallel for speed)
  mergeMetrics(
    metrics,
    timed('layer2 (parallel)', verbose, () => gatherLayer2Parallel(repoPath, verbose)),
  );

  // Import real coverage when the project's test runner has produced an
  // artifact. Lets the Testing dimension score against line-level truth
  // instead of the filename-only fallback. Dispatcher handles every
  // language pack's artifact formats — no per-language fallback needed.
  const coverage = await timedAsync('coverage', verbose, () => loadCoverage(repoPath));
  if (coverage) {
    metrics.coveragePercent = Math.round(coverage.linePercent);
    metrics.toolsUsed.push(`coverage:${coverage.source}`);
  }

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

  // Phase 10e.C.1: capability envelopes alongside legacy metrics. Dispatched
  // in parallel; providers the legacy path already ran are served from the
  // dispatcher cache (free). Scorers read capability-owned fields from this
  // bundle (C.2).
  const capabilities = await timedAsync('capabilities', verbose, () =>
    gatherCapabilityReport(repoPath),
  );

  // Synthesize per-pack tool names (eslint, npm-audit, ruff, pip-audit,
  // clippy, cargo-audit, golangci-lint, govulncheck, dotnet-format,
  // dotnet-vulnerable) into `metrics.toolsUsed` from the LINT + DEP_VULNS
  // envelopes. Pre-C.5 these came from each pack's `gatherMetrics`; now
  // they come from the dispatcher's already-computed `tool` field.
  for (const name of toolsFromCapabilities(capabilities)) {
    if (!metrics.toolsUsed.includes(name)) metrics.toolsUsed.push(name);
  }

  // Step 3: Score
  const scoreInput: ScoreInput = { metrics, capabilities };
  const dimensions = {
    testing: scoreTestsDimension(scoreInput),
    quality: scoreQualityDimension(scoreInput),
    documentation: scoreDocsDimension(scoreInput),
    security: scoreSecurityDimension(scoreInput),
    maintainability: scoreMaintainabilityDimension(scoreInput),
    developerExperience: scoreDxDimension(scoreInput),
  };
  const { overallScore, grade } = computeOverall(dimensions);

  // Step 4: Format report
  const commitSha = run('git rev-parse --short HEAD 2>/dev/null', repoPath);
  const branch = run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath);

  const report: HealthReport = {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha,
    branch,
    summary: { overallScore, grade },
    dimensions,
    languages: metrics.languages,
    toolsUsed: metrics.toolsUsed,
    toolsUnavailable: metrics.toolsUnavailable,
    capabilities,
  };
  return { report, metrics };
}

/**
 * Extract user-facing tool names from the LINT + DEP_VULNS envelopes so
 * `metrics.toolsUsed` can continue to list them after C.5 deletes the
 * per-pack `gatherMetrics` channel. Other capability envelopes (imports,
 * testFramework, secrets, codePatterns, duplication, structural) aren't
 * mirrored here — some carry pseudo-tools (`ts-imports`, `typescript`)
 * that were never in `toolsUsed`; the real external tools (gitleaks,
 * graphify, jscpd, semgrep) land through their own code paths.
 *
 * Splits comma-joined names the descriptor aggregate produces (e.g.
 * `"ruff, eslint, golangci-lint"`) back into individual entries. Also
 * includes `osv.dev` when depVulns enrichment used it — matches the
 * byte-identical pre-C.5 string the python/go/rust packs emitted.
 */
function toolsFromCapabilities(caps: CapabilityReport): string[] {
  const names: string[] = [];
  if (caps.lint) names.push(...splitToolNames(caps.lint.tool));
  if (caps.depVulns) {
    names.push(...splitToolNames(caps.depVulns.tool));
    if (caps.depVulns.enrichment === 'osv.dev') names.push('osv.dev');
  }
  return names;
}

function splitToolNames(tool: string): string[] {
  return tool
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Dispatch all 9 capabilities and bundle the non-null envelopes into a
 * `CapabilityReport`. Each capability resolves a different provider set
 * (per-pack capabilities union the active language packs; global
 * capabilities hit a single registered provider). Dispatches run in
 * parallel — the descriptor aggregates are pure, and the dispatcher
 * isolates provider failures.
 */
async function gatherCapabilityReport(cwd: string): Promise<CapabilityReport> {
  const [
    depVulns,
    lint,
    coverage,
    imports,
    testFramework,
    secrets,
    codePatterns,
    duplication,
    structural,
  ] = await Promise.all([
    defaultDispatcher.gather(cwd, DEP_VULNS, providersFor(DEP_VULNS)),
    defaultDispatcher.gather(cwd, LINT, providersFor(LINT)),
    defaultDispatcher.gather(cwd, COVERAGE, providersFor(COVERAGE)),
    defaultDispatcher.gather(cwd, IMPORTS, providersFor(IMPORTS)),
    defaultDispatcher.gather(cwd, TEST_FRAMEWORK, providersFor(TEST_FRAMEWORK)),
    defaultDispatcher.gather(cwd, SECRETS, providersFor(SECRETS)),
    defaultDispatcher.gather(cwd, CODE_PATTERNS, providersFor(CODE_PATTERNS)),
    defaultDispatcher.gather(cwd, DUPLICATION, providersFor(DUPLICATION)),
    defaultDispatcher.gather(cwd, STRUCTURAL, providersFor(STRUCTURAL)),
  ]);
  const report: CapabilityReport = {};
  if (depVulns) report.depVulns = depVulns;
  if (lint) report.lint = lint;
  if (coverage) report.coverage = coverage;
  if (imports) report.imports = imports;
  if (testFramework) report.testFramework = testFramework;
  if (secrets) report.secrets = secrets;
  if (codePatterns) report.codePatterns = codePatterns;
  if (duplication) report.duplication = duplication;
  if (structural) report.structural = structural;
  return report;
}

/**
 * Dependency-vulnerability counts accumulate across language packs so a mixed
 * repo (e.g. Node + Python) reports pip-audit + npm-audit + govulncheck results
 * together. Before this, the last-merged pack silently overwrote earlier ones.
 */
const AGGREGATED_VULN_FIELDS = [
  'depVulnCritical',
  'depVulnHigh',
  'depVulnMedium',
  'depVulnLow',
] as const;

/** Merge language-specific metrics into the base, preferring non-null values. */
export function mergeMetrics(base: HealthMetrics, overlay: Partial<HealthMetrics>): void {
  for (const key of Object.keys(overlay)) {
    const value = (overlay as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;

    if (key === 'toolsUsed' && Array.isArray(value)) {
      base.toolsUsed.push(...(value as string[]));
    } else if (key === 'toolsUnavailable' && Array.isArray(value)) {
      base.toolsUnavailable.push(...(value as string[]));
    } else if (
      AGGREGATED_VULN_FIELDS.includes(key as (typeof AGGREGATED_VULN_FIELDS)[number]) &&
      typeof value === 'number'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (base as any)[key] = ((base as any)[key] ?? 0) + value;
    } else if (key === 'depAuditTool' && typeof value === 'string') {
      // Multiple packs may contribute — join with commas for clarity.
      base.depAuditTool = base.depAuditTool ? `${base.depAuditTool}, ${value}` : value;
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
