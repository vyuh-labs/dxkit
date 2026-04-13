/**
 * Quality gathering — one function per tool, all accessed via registry.
 *
 * PRINCIPLE: Every external tool is accessed via findTool(TOOL_DEFS.xxx).
 * No direct binary paths. No ad-hoc execSync calls for tools.
 * If a tool isn't in tool-registry.ts, it can't be used here.
 *
 * Tool boundaries:
 *   jscpd     → duplicate code detection
 *   graphify  → structural complexity (god files, dead code, cohesion)
 *   cloc      → comment-to-code ratio
 *   eslint    → lint errors/warnings (when available)
 *   grep      → hygiene markers (TODO, FIXME, HACK, console.log)
 */
import * as fs from 'fs';
import { run } from '../tools/runner';
import { findTool, TOOL_DEFS } from '../tools/tool-registry';
import { getGrepExcludeDirFlags } from '../tools/exclusions';
import { gatherGraphifyMetrics } from '../tools/graphify';
import { gatherClocMetrics } from '../tools/cloc';
import { gatherNodeMetrics } from '../tools/node';
import { DuplicationStats } from './types';

// ─── jscpd: duplicate code ──────────────────────────────────────────────────

interface JscpdReport {
  statistics: {
    total: {
      lines: number;
      duplicatedLines: number;
      percentage: number;
    };
  };
  duplicates: Array<unknown>;
}

export function gatherDuplication(cwd: string): {
  stats: DuplicationStats | null;
  toolUsed: string | null;
} {
  const status = findTool(TOOL_DEFS.jscpd, cwd);
  if (!status.available || !status.path) return { stats: null, toolUsed: null };

  const reportDir = `/tmp/dxkit-jscpd-${Date.now()}`;

  // Key flags:
  // --gitignore: respect .gitignore (skips node_modules/dist/build if listed)
  // --pattern: only scan source files (not configs, markdown, etc.)
  // Without --gitignore, jscpd crawls into node_modules and OOMs on large repos.
  run(
    `${status.path} --reporters json --output '${reportDir}' --gitignore --pattern '**/*.{ts,tsx,js,jsx,py,go,rs,cs}' --min-lines 5 --min-tokens 50 '${cwd}' > /dev/null 2>&1`,
    cwd,
    300000,
  );

  const reportRaw = run(`cat '${reportDir}/jscpd-report.json' 2>/dev/null`, cwd);
  run(`rm -rf '${reportDir}'`, cwd);

  if (!reportRaw) return { stats: null, toolUsed: 'jscpd' };

  try {
    const data = JSON.parse(reportRaw) as JscpdReport;
    const t = data.statistics?.total;
    if (!t) return { stats: null, toolUsed: 'jscpd' };

    return {
      stats: {
        totalLines: t.lines,
        duplicatedLines: t.duplicatedLines,
        percentage: Math.round(t.percentage * 100) / 100,
        cloneCount: (data.duplicates || []).length,
      },
      toolUsed: 'jscpd',
    };
  } catch {
    return { stats: null, toolUsed: 'jscpd' };
  }
}

// ─── graphify: structural complexity ────────────────────────────────────────

export function gatherStructuralMetrics(cwd: string): {
  maxFunctionsInFile: number | null;
  maxFunctionsFilePath: string | null;
  avgCohesion: number | null;
  communityCount: number | null;
  functionCount: number | null;
  deadImportCount: number | null;
  orphanModuleCount: number | null;
  toolUsed: string | null;
} {
  // Reuse graphify data from health metrics if already gathered,
  // otherwise just report null. Graphify runs during health orchestration,
  // not re-run per deep analyzer (too slow to run twice).
  // The quality report inherits these from the health pipeline.
  // For standalone `vyuh-dxkit quality`, we gather them fresh.
  const result = gatherGraphifyMetrics(cwd);

  if (result.functionCount !== undefined && result.functionCount !== null) {
    return {
      maxFunctionsInFile: result.maxFunctionsInFile ?? null,
      maxFunctionsFilePath: result.maxFunctionsFilePath ?? null,
      avgCohesion: result.avgCohesion ?? null,
      communityCount: result.communityCount ?? null,
      functionCount: result.functionCount ?? null,
      deadImportCount: result.deadImportCount ?? null,
      orphanModuleCount: result.orphanModuleCount ?? null,
      toolUsed: 'graphify',
    };
  }

  return {
    maxFunctionsInFile: null,
    maxFunctionsFilePath: null,
    avgCohesion: null,
    communityCount: null,
    functionCount: null,
    deadImportCount: null,
    orphanModuleCount: null,
    toolUsed: result.toolsUnavailable ? null : 'graphify',
  };
}

// ─── cloc: comment ratio ────────────────────────────────────────────────────

export function gatherCommentRatio(cwd: string): {
  ratio: number | null;
  toolUsed: string | null;
} {
  const status = findTool(TOOL_DEFS.cloc, cwd);
  if (!status.available) return { ratio: null, toolUsed: null };

  const result = gatherClocMetrics(cwd);

  if (result.clocLanguages && Array.isArray(result.clocLanguages)) {
    let totalCode = 0;
    let totalComment = 0;
    for (const lang of result.clocLanguages) {
      totalCode += lang.code;
      totalComment += lang.comment;
    }
    const ratio = totalCode + totalComment > 0 ? totalComment / (totalCode + totalComment) : 0;
    return { ratio: Math.round(ratio * 1000) / 1000, toolUsed: 'cloc' };
  }

  return { ratio: null, toolUsed: null };
}

// ─── grep: hygiene markers ──────────────────────────────────────────────────

export function gatherHygieneMarkers(cwd: string): {
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  consoleLogCount: number;
  staleFiles: string[];
  mixedLanguages: boolean;
} {
  // Use the grepCount pattern from generic.ts approach — write pattern to file
  function grepCountSimple(pattern: string): number {
    const patternFile = `/tmp/dxkit-qgrep-${Date.now()}-${Math.random().toString(36).slice(2)}.pat`;
    fs.writeFileSync(patternFile, pattern);
    // grep --exclude-dir prevents traversing node_modules etc. at search time (fast)
    const excludeDirs = getGrepExcludeDirFlags();
    const result = run(
      `grep -rEf '${patternFile}' ${excludeDirs} --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.go' . 2>/dev/null | wc -l`,
      cwd,
      60000,
    );
    try {
      fs.unlinkSync(patternFile);
    } catch {
      /* ignore */
    }
    return parseInt(result) || 0;
  }

  // Stale files: vim swap, backup, temp files tracked in git
  const staleRaw = run(
    `git ls-files '*.swp' '*.swo' '*.bak' '*.orig' '*.tmp' '*.log' '*.pyc' 2>/dev/null`,
    cwd,
  );
  const staleFiles = staleRaw ? staleRaw.split('\n').filter((l) => l.trim()) : [];

  // Mixed languages: .js files alongside .ts in same source directories (not config files at root)
  const jsInSrc = run(
    "find . -path '*/src/*.js' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.min.js' 2>/dev/null | head -5",
    cwd,
  );
  const tsInSrc = run(
    "find . -path '*/src/*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null | head -1",
    cwd,
  );
  const mixedLanguages = !!(jsInSrc && tsInSrc);

  return {
    todoCount: grepCountSimple('TODO'),
    fixmeCount: grepCountSimple('FIXME'),
    hackCount: grepCountSimple('HACK'),
    consoleLogCount: grepCountSimple('console\\.(log|error|warn)'),
    staleFiles,
    mixedLanguages,
  };
}

// ─── eslint: lint errors (via node.ts) ──────────────────────────────────────

export function gatherLintMetrics(cwd: string): {
  errors: number;
  warnings: number;
  tool: string | null;
} {
  // Reuse node.ts gatherNodeMetrics which already handles eslint/lb-eslint
  const result = gatherNodeMetrics(cwd);
  return {
    errors: result.lintErrors ?? 0,
    warnings: result.lintWarnings ?? 0,
    tool: result.lintTool ?? null,
  };
}
