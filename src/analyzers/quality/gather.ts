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
import { gatherClocMetrics } from '../tools/cloc';
import { detectActiveLanguages } from '../../languages';
import { defaultDispatcher } from '../dispatcher';
import { DUPLICATION, LINT, STRUCTURAL } from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { LintResult } from '../../languages/capabilities/types';
import { DuplicationStats, FileOffender } from './types';

// ─── dispatcher-driven duplication gather (Phase 10e.B.8.3) ─────────────────

/**
 * Duplication is a global capability: the DUPLICATION dispatcher routes
 * to `jscpdProvider` (tools/jscpd.ts). This layer only reshapes the
 * envelope into the legacy `DuplicationStats` shape for the quality
 * report. Field names are 1:1 (topClones is already
 * `DuplicationClone[]` which is structurally identical to the
 * analyzer's `CloneGroup[]`).
 */
export async function gatherDuplication(cwd: string): Promise<{
  stats: DuplicationStats | null;
  toolUsed: string | null;
}> {
  const result = await defaultDispatcher.gather(cwd, DUPLICATION, providersFor(DUPLICATION));
  if (!result) return { stats: null, toolUsed: null };

  return {
    stats: {
      totalLines: result.totalLines,
      duplicatedLines: result.duplicatedLines,
      percentage: result.percentage,
      cloneCount: result.cloneCount,
      topClones: [...result.topClones],
    },
    toolUsed: result.tool,
  };
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

// ─── dispatcher-driven structural gather (Phase 10e.B.9.3) ──────────────────

/**
 * Structural metrics are a global capability: the STRUCTURAL dispatcher
 * routes to `graphifyProvider` (tools/graphify.ts). Like COVERAGE, the
 * dispatcher caches per-(cwd, capability) so two analyzers in the same
 * run don't re-shell graphify (it takes ~60s on a medium repo); the
 * gatherGraphifyResult helper memoizes per-cwd below that, so the Layer
 * 2 reshape path in `tools/parallel.ts` shares the same outcome.
 *
 * This layer reshapes the envelope into the analyzer's 7-field report
 * shape. The full envelope carries three additional fields
 * (classCount, godNodeCount, commentedCodeRatio) that the health
 * report's `capabilities.structural` exposes directly.
 */
export async function gatherStructuralMetrics(cwd: string): Promise<{
  maxFunctionsInFile: number | null;
  maxFunctionsFilePath: string | null;
  avgCohesion: number | null;
  communityCount: number | null;
  functionCount: number | null;
  deadImportCount: number | null;
  orphanModuleCount: number | null;
  toolUsed: string | null;
}> {
  const result = await defaultDispatcher.gather(cwd, STRUCTURAL, providersFor(STRUCTURAL));
  if (!result) {
    return {
      maxFunctionsInFile: null,
      maxFunctionsFilePath: null,
      avgCohesion: null,
      communityCount: null,
      functionCount: null,
      deadImportCount: null,
      orphanModuleCount: null,
      toolUsed: null,
    };
  }
  return {
    maxFunctionsInFile: result.maxFunctionsInFile,
    maxFunctionsFilePath: result.maxFunctionsFilePath,
    avgCohesion: result.avgCohesion,
    communityCount: result.communityCount,
    functionCount: result.functionCount,
    deadImportCount: result.deadImportCount,
    orphanModuleCount: result.orphanModuleCount,
    toolUsed: result.tool,
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
