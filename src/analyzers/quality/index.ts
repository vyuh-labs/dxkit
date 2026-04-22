/**
 * Quality analyzer — public API.
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed, timedAsync } from '../tools/timing';
import {
  gatherDuplication,
  gatherStructuralMetrics,
  gatherCommentRatio,
  gatherHygieneMarkers,
  gatherHygieneTopOffenders,
  gatherLintMetrics,
} from './gather';
import { QualityReport, QualityMetrics } from './types';

export type { QualityReport, QualityMetrics } from './types';

export interface AnalyzeQualityOptions {
  verbose?: boolean;
  /** Populate top-offender lists for detailed reports (slower). */
  detailed?: boolean;
}

/** Compute slop score (0-100, higher = cleaner). */
export function computeSlopScore(m: QualityMetrics): number {
  let score = 100;

  // Duplication
  if (m.duplication) {
    if (m.duplication.percentage > 15) score -= 20;
    else if (m.duplication.percentage > 5) score -= 10;
  }

  // Comment ratio (from cloc)
  if (m.commentRatio !== null) {
    if (m.commentRatio > 0.5) score -= 15;
    else if (m.commentRatio > 0.4) score -= 10;
  }

  // TODO/FIXME/HACK density
  const hygieneTotal = m.todoCount + m.fixmeCount + m.hackCount;
  if (hygieneTotal > 50) score -= 10;
  else if (hygieneTotal > 20) score -= 5;

  // God files (function density)
  if (m.maxFunctionsInFile !== null && m.maxFunctionsInFile > 50) score -= 10;

  // Dead code
  if (m.deadImportCount !== null && m.deadImportCount > 20) score -= 10;
  if (m.orphanModuleCount !== null && m.orphanModuleCount > 30) score -= 5;

  // Console.log density
  if (m.consoleLogCount > 500) score -= 15;
  else if (m.consoleLogCount > 100) score -= 10;
  else if (m.consoleLogCount > 20) score -= 5;

  // Lint errors
  if (m.lintErrors > 50) score -= 10;
  else if (m.lintErrors > 10) score -= 5;

  // Stale files committed to git
  if (m.staleFiles.length > 3) score -= 5;
  else if (m.staleFiles.length > 0) score -= 2;

  // Mixed JS/TS in source directories
  if (m.mixedLanguages) score -= 5;

  return Math.max(0, Math.min(100, score));
}

export async function analyzeQuality(
  repoPath: string,
  options: AnalyzeQualityOptions = {},
): Promise<QualityReport> {
  const verbose = !!options.verbose;
  const stack = detect(repoPath);
  const toolsUsed: string[] = ['grep', 'find'];
  const toolsUnavailable: string[] = [];

  // 1. Duplication (jscpd) — dispatcher-driven via DUPLICATION capability.
  const dup = await timedAsync('jscpd', verbose, () => gatherDuplication(repoPath));
  if (dup.toolUsed) toolsUsed.push(dup.toolUsed);
  else toolsUnavailable.push('jscpd');

  // 2. Structural complexity (graphify) — dispatcher-driven via STRUCTURAL.
  const structure = await timedAsync('graphify', verbose, () => gatherStructuralMetrics(repoPath));
  if (structure.toolUsed) toolsUsed.push(structure.toolUsed);
  else toolsUnavailable.push('graphify');

  // 3. Comment ratio (cloc)
  const comments = timed('cloc', verbose, () => gatherCommentRatio(repoPath));
  if (comments.toolUsed) toolsUsed.push(comments.toolUsed);
  else toolsUnavailable.push('cloc');

  // 4. Hygiene markers (grep)
  const hygiene = timed('hygiene (grep)', verbose, () => gatherHygieneMarkers(repoPath));

  // 4b. Top hygiene offenders — only when --detailed (extra grep pass)
  const topOffenders = options.detailed
    ? timed('hygiene top offenders', verbose, () => gatherHygieneTopOffenders(repoPath))
    : { topConsoleFiles: undefined, topTodoFiles: undefined };

  // 5. Lint (eslint/ruff)
  const lint = await timedAsync('lint', verbose, () => gatherLintMetrics(repoPath));
  if (lint.tool) toolsUsed.push(lint.tool);

  const metrics: QualityMetrics = {
    lintErrors: lint.errors,
    lintWarnings: lint.warnings,
    lintTool: lint.tool,
    duplication: dup.stats,
    maxFunctionsInFile: structure.maxFunctionsInFile,
    maxFunctionsFilePath: structure.maxFunctionsFilePath,
    avgCohesion: structure.avgCohesion,
    communityCount: structure.communityCount,
    functionCount: structure.functionCount,
    deadImportCount: structure.deadImportCount,
    orphanModuleCount: structure.orphanModuleCount,
    todoCount: hygiene.todoCount,
    fixmeCount: hygiene.fixmeCount,
    hackCount: hygiene.hackCount,
    consoleLogCount: hygiene.consoleLogCount,
    commentRatio: comments.ratio,
    staleFiles: hygiene.staleFiles,
    mixedLanguages: hygiene.mixedLanguages,
    slopScore: 0, // computed below
    topConsoleFiles: topOffenders.topConsoleFiles,
    topTodoFiles: topOffenders.topTodoFiles,
  };

  metrics.slopScore = computeSlopScore(metrics);

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    metrics,
    slopScore: metrics.slopScore,
    toolsUsed,
    toolsUnavailable,
  };
}

export function formatQualityReport(report: QualityReport, elapsed: string): string {
  const L: string[] = [];
  const m = report.metrics;

  L.push('# Code Quality Review');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push(
    `**Slop Score:** ${report.slopScore}/100 (${report.slopScore >= 80 ? 'clean' : report.slopScore >= 60 ? 'fair' : report.slopScore >= 40 ? 'messy' : 'sloppy'})`,
  );
  L.push('');
  L.push('---');
  L.push('');

  // Summary table
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|--------|-------|');
  L.push(`| Slop Score | **${report.slopScore}/100** |`);
  if (m.duplication) {
    L.push(
      `| Duplication | ${m.duplication.percentage}% (${m.duplication.cloneCount} clones, ${m.duplication.duplicatedLines} lines) |`,
    );
  }
  if (m.commentRatio !== null) {
    L.push(`| Comment Ratio | ${(m.commentRatio * 100).toFixed(1)}% |`);
  }
  L.push(
    `| Lint Errors | ${m.lintErrors} errors, ${m.lintWarnings} warnings${m.lintTool ? ' (' + m.lintTool + ')' : ''} |`,
  );
  L.push(`| TODO/FIXME/HACK | ${m.todoCount} / ${m.fixmeCount} / ${m.hackCount} |`);
  L.push(`| Console Statements | ${m.consoleLogCount} |`);
  if (m.functionCount !== null) {
    L.push(`| Functions | ${m.functionCount} total, max ${m.maxFunctionsInFile} in one file |`);
  }
  if (m.deadImportCount !== null) {
    L.push(`| Dead Imports | ${m.deadImportCount} |`);
  }
  if (m.orphanModuleCount !== null) {
    L.push(`| Orphan Modules | ${m.orphanModuleCount} |`);
  }
  if (m.avgCohesion !== null) {
    L.push(`| Avg Cohesion | ${m.avgCohesion.toFixed(2)} |`);
  }
  if (m.staleFiles.length > 0) {
    L.push(
      `| Stale Files | ${m.staleFiles.length} (${m.staleFiles.slice(0, 3).join(', ')}${m.staleFiles.length > 3 ? '...' : ''}) |`,
    );
  }
  if (m.mixedLanguages) {
    L.push('| Mixed JS/TS | Yes — .js alongside .ts in src/ |');
  }
  L.push('');
  L.push('---');
  L.push('');

  // Duplication details
  if (m.duplication) {
    L.push('## Duplication');
    L.push('');
    L.push(
      `**${m.duplication.percentage}%** of code is duplicated across ${m.duplication.cloneCount} clones (${m.duplication.duplicatedLines} lines out of ${m.duplication.totalLines}).`,
    );
    L.push('');
    if (m.duplication.percentage > 15) {
      L.push(
        '> **High duplication.** Consider extracting shared code into utility functions or shared modules.',
      );
    } else if (m.duplication.percentage > 5) {
      L.push(
        '> **Moderate duplication.** Some copy-paste detected. Review the largest clones for extraction opportunities.',
      );
    } else {
      L.push('> Duplication is within acceptable range.');
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Structural complexity
  if (m.functionCount !== null) {
    L.push('## Structural Complexity');
    L.push('');
    L.push(
      `- **${m.functionCount}** functions across ${m.communityCount ?? '?'} architectural communities`,
    );
    L.push(
      `- **Densest file:** ${m.maxFunctionsFilePath ?? 'unknown'} (${m.maxFunctionsInFile} functions)`,
    );
    L.push(`- **Avg cohesion:** ${m.avgCohesion?.toFixed(2) ?? 'unknown'}`);
    if (m.deadImportCount !== null && m.deadImportCount > 0) {
      L.push(`- **Dead imports:** ${m.deadImportCount}`);
    }
    if (m.orphanModuleCount !== null && m.orphanModuleCount > 0) {
      L.push(`- **Orphan modules:** ${m.orphanModuleCount} (no inbound imports)`);
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Hygiene
  L.push('## Code Hygiene');
  L.push('');
  L.push(`- **TODO:** ${m.todoCount}`);
  L.push(`- **FIXME:** ${m.fixmeCount}`);
  L.push(`- **HACK:** ${m.hackCount}`);
  L.push(`- **Console statements:** ${m.consoleLogCount}`);
  if (m.commentRatio !== null) {
    L.push(`- **Comment ratio:** ${(m.commentRatio * 100).toFixed(1)}%`);
  }
  if (m.staleFiles.length > 0) {
    L.push(`- **Stale files in git:** ${m.staleFiles.map((f) => '`' + f + '`').join(', ')}`);
  }
  if (m.mixedLanguages) {
    L.push(
      '- **Mixed JS/TS:** `.js` files found alongside `.ts` in source directories — consider converting to TypeScript',
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  if (report.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');
  return L.join('\n');
}
