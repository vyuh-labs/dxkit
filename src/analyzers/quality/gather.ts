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
import { getGrepExcludeDirFlags, isExcludedPath } from '../tools/exclusions';
import { gatherGraphifyMetrics } from '../tools/graphify';
import { gatherClocMetrics } from '../tools/cloc';
import { detectActiveLanguages } from '../../languages';
import { defaultDispatcher } from '../dispatcher';
import { LINT } from '../../languages/capabilities/descriptors';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { LintResult } from '../../languages/capabilities/types';
import { CloneGroup, DuplicationStats, FileOffender } from './types';

// ─── jscpd: duplicate code ──────────────────────────────────────────────────

interface JscpdDuplicate {
  lines?: number;
  tokens?: number;
  firstFile?: { name?: string; start?: number; end?: number };
  secondFile?: { name?: string; start?: number; end?: number };
}

interface JscpdReport {
  statistics: {
    total: {
      lines: number;
      duplicatedLines: number;
      percentage: number;
    };
  };
  duplicates: JscpdDuplicate[];
}

/** Extract top N clone pairs sorted by size descending. */
function topClonesFrom(duplicates: JscpdDuplicate[], limit = 15): CloneGroup[] {
  return duplicates
    .filter((d) => d.firstFile?.name && d.secondFile?.name && d.lines)
    .map((d) => ({
      lines: d.lines || 0,
      tokens: d.tokens || 0,
      a: {
        file: d.firstFile!.name!,
        startLine: d.firstFile!.start || 0,
        endLine: d.firstFile!.end || 0,
      },
      b: {
        file: d.secondFile!.name!,
        startLine: d.secondFile!.start || 0,
        endLine: d.secondFile!.end || 0,
      },
    }))
    .sort((x, y) => y.lines - x.lines)
    .slice(0, limit);
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

    const duplicates = data.duplicates || [];
    return {
      stats: {
        totalLines: t.lines,
        duplicatedLines: t.duplicatedLines,
        percentage: Math.round(t.percentage * 100) / 100,
        cloneCount: duplicates.length,
        topClones: topClonesFrom(duplicates),
      },
      toolUsed: 'jscpd',
    };
  } catch {
    return { stats: null, toolUsed: 'jscpd' };
  }
}

// ─── grep: per-file hygiene offender counts ─────────────────────────────────

/**
 * Count matches per file and return the top N offenders.
 * Uses `grep -rc` which emits `file:count` per matched file.
 */
function grepPerFile(cwd: string, pattern: string, limit = 10): FileOffender[] {
  const patternFile = `/tmp/dxkit-qgrep-${Date.now()}-${Math.random().toString(36).slice(2)}.pat`;
  fs.writeFileSync(patternFile, pattern);
  const excludeDirs = getGrepExcludeDirFlags(cwd);
  const raw = run(
    `grep -rcEf '${patternFile}' ${excludeDirs} --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.go' . 2>/dev/null`,
    cwd,
    60000,
  );
  try {
    fs.unlinkSync(patternFile);
  } catch {
    /* ignore */
  }
  if (!raw) return [];
  const offenders: FileOffender[] = [];
  for (const line of raw.split('\n')) {
    const idx = line.lastIndexOf(':');
    if (idx < 0) continue;
    const file = line.slice(0, idx);
    const count = parseInt(line.slice(idx + 1), 10);
    if (!count || !file) continue;
    // grep's --exclude-dir is basename-only; use centralized predicate to
    // drop multi-segment path exclusions (public/assets) + file patterns.
    if (isExcludedPath(cwd, file.replace(/^\.\//, ''))) continue;
    offenders.push({ file, count });
  }
  offenders.sort((a, b) => b.count - a.count);
  return offenders.slice(0, limit);
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

/** Collect per-file top offenders for detailed reports. Slow — only call when needed. */
export function gatherHygieneTopOffenders(cwd: string): {
  topConsoleFiles: FileOffender[];
  topTodoFiles: FileOffender[];
} {
  return {
    topConsoleFiles: grepPerFile(cwd, 'console\\.(log|error|warn)'),
    topTodoFiles: grepPerFile(cwd, '(TODO|FIXME|HACK)'),
  };
}

export function gatherHygieneMarkers(cwd: string): {
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  consoleLogCount: number;
  staleFiles: string[];
  mixedLanguages: boolean;
} {
  // Sum match counts across source files, excluding vendored paths.
  // grep --exclude-dir handles basename dirs (node_modules etc.) at traversal.
  // Path-based exclusions (public/assets, static/js) are post-filtered because
  // grep's --exclude-dir only matches basenames, not paths.
  function grepCountSimple(pattern: string): number {
    const patternFile = `/tmp/dxkit-qgrep-${Date.now()}-${Math.random().toString(36).slice(2)}.pat`;
    fs.writeFileSync(patternFile, pattern);
    const excludeDirs = getGrepExcludeDirFlags(cwd);
    const result = run(
      `grep -rcEf '${patternFile}' ${excludeDirs} --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.go' . 2>/dev/null`,
      cwd,
      60000,
    );
    try {
      fs.unlinkSync(patternFile);
    } catch {
      /* ignore */
    }
    if (!result) return 0;
    let total = 0;
    for (const line of result.split('\n')) {
      const idx = line.lastIndexOf(':');
      if (idx < 0) continue;
      const file = line.slice(0, idx);
      const count = parseInt(line.slice(idx + 1), 10);
      if (!count || !file) continue;
      // Centralized filter — same predicate used by security/quality/tests.
      if (isExcludedPath(cwd, file.replace(/^\.\//, ''))) continue;
      total += count;
    }
    return total;
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

// ─── lint errors (via capability dispatcher) ─────────────────────────────────

/**
 * Aggregates lint tier counts across every active language pack via the
 * capability dispatcher. Phase 10e.B.2 replaced an earlier loop that ran
 * each pack's full `gatherMetrics` (lint + deps + testFramework) and
 * returned the first pack's lint with a non-null `lintTool`. Two fixes:
 *
 *   1. First-wins → sum: a Python + Node repo now reports combined
 *      eslint + ruff counts, not just the first one detected.
 *   2. Only the lint provider runs per pack, not the full `gatherMetrics`,
 *      so the quality analyzer no longer incidentally triggers npm-audit
 *      and pip-audit when asking about lint.
 *
 * Collapse: critical + high → errors, medium + low → warnings, matching
 * the prior `lintErrors`/`lintWarnings` contract.
 */
export async function gatherLintMetrics(cwd: string): Promise<{
  errors: number;
  warnings: number;
  tool: string | null;
}> {
  const providers: CapabilityProvider<LintResult>[] = [];
  for (const lang of detectActiveLanguages(cwd)) {
    if (lang.capabilities?.lint) providers.push(lang.capabilities.lint);
  }
  if (providers.length === 0) return { errors: 0, warnings: 0, tool: null };

  const envelope = await defaultDispatcher.gather(cwd, LINT, providers);
  if (!envelope) return { errors: 0, warnings: 0, tool: null };

  const c = envelope.counts;
  return {
    errors: c.critical + c.high,
    warnings: c.medium + c.low,
    tool: envelope.tool,
  };
}
