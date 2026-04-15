/**
 * Test gap analyzer — public API.
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed } from '../tools/timing';
import { loadCoverage } from '../tools/coverage';
import { gatherTestFiles, gatherSourceFiles, matchTestsToSource } from './gather';
import { TestGapsReport, SourceFile, TestFile, CoverageSource } from './types';

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

  // Prefer real coverage from the project's test runner over filename matching.
  // Any covered line for a source file implies `hasMatchingTest`, which
  // rescues well-tested files whose test filenames don't match the source.
  const coverage = timed('coverage', verbose, () => loadCoverage(repoPath));
  if (coverage) {
    toolsUsed.push(`coverage:${coverage.source}`);
    for (const s of sourceFiles) {
      const fc = coverage.files.get(s.path);
      if (fc && fc.covered > 0) s.hasMatchingTest = true;
    }
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
    // Fallback: % of source files that have an active name-matched test.
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
    case 'istanbul-summary':
    case 'istanbul-final':
      return `from ${file ?? 'istanbul artifact'}`;
    case 'coverage-py':
      return `from ${file ?? 'coverage.py'}`;
    case 'go':
      return `from ${file ?? 'go coverprofile'}`;
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
