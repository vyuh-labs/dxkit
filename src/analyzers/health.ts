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
    coverageConfigExists: false,
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
    evalCount: 0,
    privateKeyFiles: 0,
    envFilesInGit: 0,
    tlsDisabledCount: 0,
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

  // `package.json` metrics: npm-script count + `engines.node` pin. These
  // don't fit any capability (Node-specific by nature) and used to live
  // in the typescript pack's `gatherMetrics` body; extracted in C.5 into
  // a direct helper so they survive the per-pack channel deletion.
  const pkg = timed('package.json', verbose, () => gatherPackageJsonMetrics(repoPath));
  metrics.npmScriptsCount = pkg.npmScriptsCount;
  metrics.nodeEngineVersion = pkg.nodeEngineVersion;

  // Layer 2: Optional enhanced tools — cloc line counts, gitleaks secret
  // counts, graphify AST stats. Reshaped from the dispatcher's cached
  // envelopes (`tools/parallel.ts`), so each tool shells out at most once
  // per analyzer run.
  const layer2 = timed('layer2 (parallel)', verbose, () => gatherLayer2Parallel(repoPath, verbose));
  mergeLayer2(metrics, layer2);

  // Surface the coverage tool name in `toolsUsed` even though its data
  // lives under `capabilities.coverage`. `loadCoverage` and the COVERAGE
  // dispatcher share the same underlying providers — the call here is
  // served from the dispatcher cache when `gatherCapabilityReport` runs.
  const coverage = await timedAsync('coverage', verbose, () => loadCoverage(repoPath));
  if (coverage) {
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
 * Extract user-facing tool names from every capability envelope that
 * represents a real external scanner. `metrics.toolsUsed` ends up as a
 * complete mirror of what actually ran for the `health` report —
 * external tools (lint, depVulns, secrets, codePatterns, duplication,
 * structural) all contribute. Pseudo-tool envelopes (`imports.tool =
 * 'ts-imports'`, `testFramework.tool = 'typescript'`) intentionally
 * stay out — those are language-pack identifiers, not external tools
 * that could appear in `vyuh-dxkit tools`.
 *
 * Splits comma-joined names the descriptor aggregate produces (e.g.
 * `"ruff, eslint, golangci-lint"`) back into individual entries. Also
 * includes `osv.dev` when depVulns enrichment used it. The caller
 * dedupes against entries already pushed by Layer 2 (`tools/parallel.ts`
 * contributes `gitleaks` / `graphify` on the success path + reason
 * strings on failure to `toolsUnavailable`).
 */
function toolsFromCapabilities(caps: CapabilityReport): string[] {
  const names: string[] = [];
  if (caps.lint) names.push(...splitToolNames(caps.lint.tool));
  if (caps.depVulns) {
    names.push(...splitToolNames(caps.depVulns.tool));
    if (caps.depVulns.enrichment === 'osv.dev') names.push('osv.dev');
  }
  if (caps.secrets) names.push(...splitToolNames(caps.secrets.tool));
  if (caps.codePatterns) names.push(...splitToolNames(caps.codePatterns.tool));
  if (caps.duplication) names.push(...splitToolNames(caps.duplication.tool));
  if (caps.structural) names.push(...splitToolNames(caps.structural.tool));
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
    defaultDispatcher.gather(cwd, DEP_VULNS, providersFor(DEP_VULNS, cwd)),
    defaultDispatcher.gather(cwd, LINT, providersFor(LINT, cwd)),
    defaultDispatcher.gather(cwd, COVERAGE, providersFor(COVERAGE, cwd)),
    defaultDispatcher.gather(cwd, IMPORTS, providersFor(IMPORTS, cwd)),
    defaultDispatcher.gather(cwd, TEST_FRAMEWORK, providersFor(TEST_FRAMEWORK, cwd)),
    defaultDispatcher.gather(cwd, SECRETS, providersFor(SECRETS, cwd)),
    defaultDispatcher.gather(cwd, CODE_PATTERNS, providersFor(CODE_PATTERNS, cwd)),
    defaultDispatcher.gather(cwd, DUPLICATION, providersFor(DUPLICATION, cwd)),
    defaultDispatcher.gather(cwd, STRUCTURAL, providersFor(STRUCTURAL, cwd)),
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
 * Merge `gatherLayer2Parallel` output (cloc + gitleaks + graphify reshape)
 * into the accumulator. Layer 2 only writes non-capability fields and
 * array-valued `toolsUsed` / `toolsUnavailable`; no depVuln* or depAuditTool
 * aggregation is needed here since those live under `capabilities.depVulns`.
 * Null / undefined values pass through unchanged so Layer 2 can signal
 * "no data" per field.
 */
function mergeLayer2(base: HealthMetrics, overlay: Partial<HealthMetrics>): void {
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
