/**
 * Quality analyzer — public API.
 */
import * as path from 'path';
import { readOrBuildAnalysisResult } from '../cache';
import { gatherAnalysisResultBody } from '../health';
import { timed, timedAsync } from '../tools/timing';
import {
  gatherDuplication,
  gatherStructuralMetrics,
  gatherHygieneMarkers,
  gatherHygieneTopOffenders,
  gatherLintMetrics,
} from './gather';
import { scoreQualityFromInput, type QualityScoreInput } from './scoring';
import { QualityReport, QualityMetrics } from './types';

export type { QualityReport, QualityMetrics } from './types';

export interface AnalyzeQualityOptions {
  verbose?: boolean;
  /** Populate top-offender lists for detailed reports (slower). */
  detailed?: boolean;
}

/**
 * Adapter from the standalone Quality report's `QualityMetrics` into
 * the canonical `QualityScoreInput` partition. `m.sourceFiles` carries
 * the canonical repo source-file count from the cached health metrics
 * — the same denominator the health-side Code Quality dimension uses
 * — so both surfaces' density penalties land on identical values.
 */
export function qualityMetricsToScoreInput(m: QualityMetrics): QualityScoreInput {
  return {
    sourceFiles: m.sourceFiles,

    lintErrors: m.lintErrors,
    lintAvailable: m.lintTool !== null,

    consoleLogCount: m.consoleLogCount,
    todoCount: m.todoCount,
    fixmeCount: m.fixmeCount,
    hackCount: m.hackCount,
    staleFiles: m.staleFiles.length,
    mixedLanguages: m.mixedLanguages,

    filesOver500Lines: m.filesOver500Lines,
    largestFileLines: m.largestFileLines,

    anyTypeCount: m.anyTypeCount,
    typeErrors: m.typeErrors,

    duplicationPercentage: m.duplication?.percentage ?? null,
    duplicationAvailable: m.duplication !== null,

    maxFunctionsInFile: m.maxFunctionsInFile,
    deadImportCount: m.deadImportCount,
    orphanModuleCount: m.orphanModuleCount,
    structuralAvailable: m.maxFunctionsInFile !== null,

    commentRatio: m.commentRatio,
  };
}

export async function analyzeQuality(
  repoPath: string,
  options: AnalyzeQualityOptions = {},
): Promise<QualityReport> {
  const verbose = !!options.verbose;
  const toolsUsed: string[] = ['grep', 'find'];
  const toolsUnavailable: string[] = [];

  // Single canonical analysis envelope shared with `health` and the
  // other migrated consumers. Pulling provenance + sourceFiles count
  // from the cache means the density denominator the standalone Quality
  // score uses is the SAME denominator the health-side Code Quality
  // dimension uses — so the two surfaces converge on the same number.
  // Closes the dual-Quality-formula drift class structurally.
  const cacheResult = await readOrBuildAnalysisResult({
    cwd: repoPath,
    build: (cwd) => gatherAnalysisResultBody(cwd, { verbose }),
  });
  const { stack } = cacheResult;
  const cm = cacheResult.metrics;
  const sourceFiles = cm.sourceFiles;

  // 1. Duplication (jscpd) — dispatcher-driven via DUPLICATION capability.
  const dup = await timedAsync('jscpd', verbose, () => gatherDuplication(repoPath));
  if (dup.toolUsed) toolsUsed.push(dup.toolUsed);
  else toolsUnavailable.push('jscpd');

  // 2. Structural complexity (graphify) — dispatcher-driven via STRUCTURAL.
  const structure = await timedAsync('graphify', verbose, () => gatherStructuralMetrics(repoPath));
  if (structure.toolUsed) toolsUsed.push(structure.toolUsed);
  else toolsUnavailable.push('graphify');

  // Hygiene markers + comment ratio + counts come from the cached
  // HealthMetrics — the cache builder runs those gathers once per
  // (cwd, SHA) so the values match the health-side Code Quality
  // dimension exactly. The local gather is still called here, but
  // ONLY for the staleFiles file list (rendered into the standalone
  // Quality markdown). The score uses the cached count; the
  // markdown uses this list. They come from the same git ls-files
  // probe so they're consistent by construction.
  const hygiene = timed('hygiene (grep, list-only)', verbose, () => gatherHygieneMarkers(repoPath));

  // Top hygiene offenders — only when --detailed (extra grep pass).
  // Lives standalone-side because the offender lists aren't part of
  // the cached envelope yet; cheap grep on hit, only run on demand.
  const topOffenders = options.detailed
    ? timed('hygiene top offenders', verbose, () => gatherHygieneTopOffenders(repoPath))
    : { topConsoleFiles: undefined, topTodoFiles: undefined };

  // Lint (eslint/ruff). The cache's `capabilities.lint` carries the
  // same envelope shape and is populated on cache hit, but the
  // standalone Quality report needs the rendered tool label
  // including `(not run: <packs>)` provenance — which lives in the
  // gather's outcome accumulator, not the dispatcher envelope. Keep
  // the standalone gather call until that label gets surfaced
  // through the cached envelope too.
  const lint = await timedAsync('lint', verbose, () => gatherLintMetrics(repoPath));
  if (lint.tool) toolsUsed.push(lint.tool);
  if (cm.commentRatio !== null) toolsUsed.push('cloc');

  const metrics: QualityMetrics = {
    sourceFiles,
    // File-size + type signals from the cached health metrics so the
    // standalone slop score sees the same penalties the health-side
    // dimension sees.
    filesOver500Lines: cm.filesOver500Lines,
    largestFileLines: cm.largestFileLines,
    anyTypeCount: cm.anyTypeCount,
    typeErrors: cm.typeErrors,
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
    // Hygiene + mixed + comment ratio + console-density signals
    // sourced from the canonical health metrics so both surfaces
    // score from identical inputs. staleFiles list comes from the
    // local gather (markdown render needs the file names); its
    // length matches cm.staleFiles by construction since both
    // gathers run the same git ls-files probe.
    todoCount: cm.todoCount,
    fixmeCount: cm.fixmeCount,
    hackCount: cm.hackCount,
    staleFiles: hygiene.staleFiles,
    mixedLanguages: cm.mixedLanguages,
    consoleLogCount: cm.consoleLogCount,
    commentRatio: cm.commentRatio,
    slopScore: 0, // computed below
    topConsoleFiles: topOffenders.topConsoleFiles,
    topTodoFiles: topOffenders.topTodoFiles,
  };

  metrics.slopScore = scoreQualityFromInput(qualityMetricsToScoreInput(metrics)).score;

  return {
    repo: stack.projectName || path.basename(cacheResult.cwd),
    analyzedAt: cacheResult.builtAt,
    commitSha: cacheResult.commitSha,
    branch: cacheResult.branch,
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
  // Always render every row — silent omission on tool-unavailable reads
  // as "this signal is fine" when reality is "we couldn't measure it."
  // The unavailable-row text names the underlying tool so the customer
  // knows exactly what to install to populate the metric.
  L.push(
    `| Duplication | ${
      m.duplication
        ? `${m.duplication.percentage}% (${m.duplication.cloneCount} clones, ${m.duplication.duplicatedLines} lines)`
        : 'unavailable — install `jscpd`'
    } |`,
  );
  L.push(
    `| Comment Ratio | ${
      m.commentRatio !== null
        ? `${(m.commentRatio * 100).toFixed(1)}%`
        : 'unavailable — install `cloc`'
    } |`,
  );
  // Split the lint label into "Lint Errors" (counts + tool that ran) and
  // "Lint Coverage" (which packs WERE attempted but didn't produce
  // findings). Pre-split, multi-pack repos where one provider returned
  // null silently rendered the parenthetical "(ruff (not run: typescript))"
  // — accurate but easy for customers to miss. Promoting the not-run
  // packs to their own visible row makes the coverage gap legible.
  const notRunMatch = m.lintTool ? /\(not run: ([^)]+)\)/.exec(m.lintTool) : null;
  const lintToolLabel = m.lintTool
    ? notRunMatch
      ? m.lintTool.replace(/\s*\(not run: [^)]+\)/, '').trim()
      : m.lintTool
    : null;
  L.push(
    `| Lint Errors | ${m.lintErrors} errors, ${m.lintWarnings} warnings${lintToolLabel ? ' (' + lintToolLabel + ')' : ''} |`,
  );
  if (notRunMatch) {
    L.push(
      `| ⚠ Lint coverage gap | not run on: ${notRunMatch[1]} — configure the linter (e.g. add \`eslint.config.js\`) to enable |`,
    );
  }
  L.push(`| TODO/FIXME/HACK | ${m.todoCount} / ${m.fixmeCount} / ${m.hackCount} |`);
  L.push(`| Console Statements | ${m.consoleLogCount} |`);
  L.push(
    `| Functions | ${
      m.functionCount !== null
        ? `${m.functionCount} total, max ${m.maxFunctionsInFile} in one file`
        : 'unavailable — install `graphify`'
    } |`,
  );
  L.push(
    `| Dead Imports | ${m.deadImportCount !== null ? m.deadImportCount : 'unavailable — install `graphify`'} |`,
  );
  L.push(
    `| Orphan Modules | ${m.orphanModuleCount !== null ? m.orphanModuleCount : 'unavailable — install `graphify`'} |`,
  );
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

  // Duplication details — always render the section so the customer
  // sees an explicit "unavailable" message rather than a missing H2
  // (which reads as "no duplication" when the real state is "we
  // couldn't measure").
  L.push('## Duplication');
  L.push('');
  if (m.duplication) {
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
  } else {
    L.push(
      '> ⚠ **Duplication unavailable.** The duplicate-code detector (`jscpd`) did not run on this repository — its output is needed to populate this section. Install jscpd (`npm i -g jscpd`) and re-run to enable.',
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Structural complexity — same always-render discipline as Duplication.
  // Graphify produces functionCount / densest file / cohesion / orphan
  // modules / dead imports; its absence is signaled by null fields.
  L.push('## Structural Complexity');
  L.push('');
  if (m.functionCount !== null) {
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
  } else {
    L.push(
      '> ⚠ **Structural complexity unavailable.** The AST-graph builder (`graphify`) did not run on this repository — its output drives function counts, densest-file detection, architectural cohesion, dead imports, and orphan modules. Install graphify (`pip install graphifyy`) and re-run to enable.',
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Hygiene
  L.push('## Code Hygiene');
  L.push('');
  L.push(`- **TODO:** ${m.todoCount}`);
  L.push(`- **FIXME:** ${m.fixmeCount}`);
  L.push(`- **HACK:** ${m.hackCount}`);
  L.push(`- **Console statements:** ${m.consoleLogCount}`);
  L.push(
    `- **Comment ratio:** ${
      m.commentRatio !== null
        ? `${(m.commentRatio * 100).toFixed(1)}%`
        : 'unavailable (`cloc` did not run)'
    }`,
  );
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
