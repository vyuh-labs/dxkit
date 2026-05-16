/**
 * Test gap analyzer — public API.
 */
import * as path from 'path';
import { readOrBuildAnalysisResult } from '../cache';
import { gatherAnalysisResultBody } from '../health';
import { timed, timedAsync } from '../tools/timing';
import { loadCoverage } from '../tools/coverage';
import { buildReachable } from './import-graph';
import { gatherTestFiles, gatherSourceFiles, matchTestsToSource } from './gather';
import { TestGapsReport, SourceFile, CoverageSource, CoverageFidelity } from './types';

export type {
  TestGapsReport,
  SourceFile,
  TestFile,
  CoverageSource,
  CoverageFidelity,
} from './types';

/**
 * D021 (2.4.7): classify `coverageSource` into a fidelity tier. Returns
 * `line-coverage` for any real artifact (everything in
 * `tools/coverage.ts:CoverageSource`), `import-graph` for the
 * derived call-edge signal, `filename-match` for the heuristic
 * fallback. Pure function — exported for unit tests + reuse from
 * the report orchestrator.
 */
export function tierFromCoverageSource(source: CoverageSource): CoverageFidelity {
  if (source === 'filename-match') return 'filename-match';
  if (source === 'import-graph') return 'import-graph';
  return 'line-coverage';
}

export interface AnalyzeTestGapsOptions {
  verbose?: boolean;
}

export async function analyzeTestGaps(
  repoPath: string,
  options: AnalyzeTestGapsOptions = {},
): Promise<TestGapsReport> {
  const verbose = !!options.verbose;
  // Single canonical analysis envelope shared across consumers.
  // analyzeTestGaps reads provenance + stack from the cache so two
  // subcommands on the same SHA stamp identical timestamps and
  // surface the same project name / branch. Per-file source/test
  // gather + import-graph reachability still run locally (those
  // signals aren't part of the cached envelope today).
  const cacheResult = await readOrBuildAnalysisResult({
    cwd: repoPath,
    build: (cwd) => gatherAnalysisResultBody(cwd, { verbose }),
  });
  const { stack } = cacheResult;
  const toolsUsed: string[] = ['find', 'grep', 'git'];
  const toolsUnavailable: string[] = [];

  const testFiles = timed('test-files', verbose, () => gatherTestFiles(repoPath));
  const sourceFiles = timed('source-files', verbose, () => gatherSourceFiles(repoPath));
  timed('match', verbose, () => matchTestsToSource(testFiles, sourceFiles));

  // Signal precedence for test coverage (strongest wins for files it covers):
  //
  //   1. Coverage artifact — authoritative for files it has data for. If V8
  //      says a file has 0 covered lines, the file is untested, even if the
  //      filename heuristic or an import edge would suggest otherwise.
  //   2. Import-graph reachability — credits files V8 didn't see (configs,
  //      modules outside the coverage `include` glob).
  //   3. Filename match (`matchTestsToSource` above) — last-resort heuristic
  //      for files neither V8 nor the import graph has an opinion on.
  //
  // The coverage step OVERRIDES the prior filename-match decision rather
  // than ORing with it; otherwise files like `cli.ts` get falsely credited
  // by basename similarity to `cli-init.test.ts`, even though V8 measured
  // them at 0%.
  const coverage = await timedAsync('coverage', verbose, () => loadCoverage(repoPath));
  if (coverage) {
    toolsUsed.push(`coverage:${coverage.source}`);
    for (const s of sourceFiles) {
      const fc = coverage.files.get(s.path);
      if (fc !== undefined) {
        s.hasMatchingTest = fc.covered > 0;
      }
      // Files not in the artifact fall through to import-graph below.
    }
  }

  // Import-graph: a source file reachable from any active test file via
  // direct or transitive imports counts as tested. Skips files V8 already
  // measured (their decision is authoritative); credits the rest.
  const activeTestPaths = testFiles.filter((t) => t.status === 'active').map((t) => t.path);
  const reached = await timedAsync('import-graph', verbose, () =>
    buildReachable(activeTestPaths, repoPath),
  );
  const importGraphUsable = reached.size > 0;
  if (importGraphUsable) {
    for (const s of sourceFiles) {
      const measuredByCoverage = coverage?.files.has(s.path) ?? false;
      if (!measuredByCoverage && reached.has(s.path)) {
        s.hasMatchingTest = true;
      }
    }
    toolsUsed.push('import-graph');
  }

  const activeTests = testFiles.filter((t) => t.status === 'active');
  const commentedOut = testFiles.filter((t) => t.status === 'commented-out');
  const untested = sourceFiles.filter((s) => !s.hasMatchingTest);

  const untestedByRisk = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of untested) untestedByRisk[s.risk]++;

  let coverageSource: CoverageSource = 'filename-match';
  let effectiveCoverage: number;
  if (coverage) {
    coverageSource = coverage.source;
    effectiveCoverage = Math.round(coverage.linePercent);
  } else {
    // No artifact — count the share of source files with any test signal.
    // Label as 'import-graph' whenever we had usable import data, since it's
    // the stronger signal (filename-match is a heuristic fallback).
    if (importGraphUsable) coverageSource = 'import-graph';
    effectiveCoverage =
      sourceFiles.length > 0
        ? Math.round(
            (sourceFiles.filter((s) => s.hasMatchingTest).length / sourceFiles.length) * 100,
          )
        : 0;
  }

  return {
    repo: stack.projectName || path.basename(cacheResult.cwd),
    analyzedAt: cacheResult.builtAt,
    commitSha: cacheResult.commitSha,
    branch: cacheResult.branch,
    summary: {
      testFiles: testFiles.length,
      activeTestFiles: activeTests.length,
      commentedOutFiles: commentedOut.length,
      effectiveCoverage,
      coverageSource,
      coverageFidelity: tierFromCoverageSource(coverageSource),
      coverageSourceFile: coverage?.sourceFile,
      sourceFiles: sourceFiles.length,
      untestedCritical: untestedByRisk.critical,
      untestedHigh: untestedByRisk.high,
      untestedMedium: untestedByRisk.medium,
      untestedLow: untestedByRisk.low,
    },
    testFiles,
    gaps: untested.sort((a, b) => {
      const R = { critical: 0, high: 1, medium: 2, low: 3 };
      if (R[a.risk] !== R[b.risk]) return R[a.risk] - R[b.risk];
      return b.lines - a.lines; // largest first within same risk
    }),
    toolsUsed,
    toolsUnavailable,
  };
}

function coverageSourceLabel(source: CoverageSource, file?: string): string {
  switch (source) {
    case 'filename-match':
      return 'filename match — install coverage pipeline for line-level truth';
    case 'import-graph':
      return 'import-graph reachability — install coverage pipeline for line-level truth';
    case 'istanbul-summary':
    case 'istanbul-final':
      return `from ${file ?? 'istanbul artifact'}`;
    case 'coverage-py':
      return `from ${file ?? 'coverage.py'}`;
    case 'go':
      return `from ${file ?? 'go coverprofile'}`;
    case 'cobertura':
      return `from ${file ?? 'cobertura.xml'}`;
    case 'lcov':
      return `from ${file ?? 'lcov.info'}`;
    case 'jacoco':
      return `from ${file ?? 'jacocoTestReport.xml'}`;
    case 'simplecov':
      return `from ${file ?? 'coverage/.resultset.json'}`;
  }
}

export function formatTestGapsReport(report: TestGapsReport, elapsed: string): string {
  const L: string[] = [];
  L.push('# Test Gap Analysis');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');

  // D021 (2.4.7): coverage-fidelity banner. Surface the trust level of
  // the headline percentage up-front so customers don't read a 0% from
  // filename-match the same way they'd read a 0% from a real coverage
  // run. The `coverage-pipeline` install hint points at the per-pack
  // `runTests` capability — `vyuh-dxkit health --with-coverage` (D021
  // sub-piece 2) materializes the artifact before analysis.
  const s = report.summary;
  if (s.coverageFidelity === 'filename-match') {
    L.push(
      `> ⚠️ **Heuristic coverage**: the ${s.effectiveCoverage}% headline is a ` +
        `filename-match estimate — it counts source files with a name-matched ` +
        `test, not lines actually exercised. A 200-line file with a 5-line test ` +
        `passes. Run \`vyuh-dxkit coverage\` (or \`vyuh-dxkit health --with-coverage\`) ` +
        `to materialize a real coverage artifact for line-level truth.`,
    );
    L.push('');
  } else if (s.coverageFidelity === 'import-graph') {
    L.push(
      `> ℹ️ **Import-graph coverage**: the ${s.effectiveCoverage}% headline is ` +
        `derived from test files' import edges (up to N hops) — stronger than ` +
        `filename-match because it follows real call paths, but it doesn't know ` +
        `what executed at runtime. Run a coverage pipeline for line-level truth.`,
    );
    L.push('');
  }

  L.push('---');
  L.push('');

  // Executive summary
  L.push('## Executive Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|--------|-------|');
  L.push(`| Test files found | ${s.testFiles} |`);
  L.push(`| Active test files | ${s.activeTestFiles} |`);
  L.push(`| Commented-out test files | ${s.commentedOutFiles} |`);
  L.push(
    `| Effective coverage | **${s.effectiveCoverage}%** (${coverageSourceLabel(s.coverageSource, s.coverageSourceFile)}) |`,
  );
  L.push(`| Source files | ${s.sourceFiles} |`);
  L.push(`| Untested (CRITICAL) | ${s.untestedCritical} |`);
  L.push(`| Untested (HIGH) | ${s.untestedHigh} |`);
  L.push(`| Untested (MEDIUM) | ${s.untestedMedium} |`);
  L.push(`| Untested (LOW) | ${s.untestedLow} |`);
  L.push('');
  L.push('---');
  L.push('');

  // Test inventory
  L.push('## Test Inventory');
  L.push('');
  if (report.testFiles.length === 0) {
    L.push('No test files found.');
  } else {
    L.push('| File | Status | Framework |');
    L.push('|------|--------|-----------|');
    for (const t of report.testFiles) {
      L.push(`| \`${t.path}\` | ${t.status.toUpperCase()} | ${t.framework || '-'} |`);
    }
  }
  L.push('');
  L.push('---');
  L.push('');

  // Gaps by risk tier
  const tiers: Array<{ risk: SourceFile['risk']; title: string }> = [
    { risk: 'critical', title: 'CRITICAL (Security/auth risk)' },
    { risk: 'high', title: 'HIGH (Business logic/large files)' },
    { risk: 'medium', title: 'MEDIUM (Standard controllers/services)' },
    { risk: 'low', title: 'LOW (Models/utilities)' },
  ];

  L.push('## Critical Gaps');
  L.push('');

  for (const tier of tiers) {
    const items = report.gaps.filter((g) => g.risk === tier.risk);
    if (items.length === 0) continue;
    L.push(`### Priority: ${tier.title}`);
    L.push('');
    L.push('| File | Type | Lines | Risk |');
    L.push('|------|------|-------|------|');
    for (const g of items.slice(0, 30)) {
      L.push(`| \`${g.path}\` | ${g.type} | ${g.lines} | ${g.risk.toUpperCase()} |`);
    }
    if (items.length > 30) {
      L.push(`| ... | ... | ... | ${items.length - 30} more |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  if (report.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');
  return L.join('\n');
}
