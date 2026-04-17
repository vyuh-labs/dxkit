/**
 * Test gap analyzer — public API.
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed } from '../tools/timing';
import { loadCoverage } from '../tools/coverage';
import { buildReachable } from './import-graph';
import { gatherTestFiles, gatherSourceFiles, matchTestsToSource } from './gather';
import { TestGapsReport, SourceFile, CoverageSource } from './types';

export type { TestGapsReport, SourceFile, TestFile, CoverageSource } from './types';

export interface AnalyzeTestGapsOptions {
  verbose?: boolean;
}

export function analyzeTestGaps(
  repoPath: string,
  options: AnalyzeTestGapsOptions = {},
): TestGapsReport {
  const verbose = !!options.verbose;
  const stack = detect(repoPath);
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
  const coverage = timed('coverage', verbose, () => loadCoverage(repoPath));
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
  const reached = timed('import-graph', verbose, () => buildReachable(activeTestPaths, repoPath));
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
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    summary: {
      testFiles: testFiles.length,
      activeTestFiles: activeTests.length,
      commentedOutFiles: commentedOut.length,
      effectiveCoverage,
      coverageSource,
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
  L.push('---');
  L.push('');

  // Executive summary
  const s = report.summary;
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
