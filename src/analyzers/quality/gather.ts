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
import { run } from '../tools/runner';
import { findTool, TOOL_DEFS } from '../tools/tool-registry';
import { gatherClocMetrics } from '../tools/cloc';
import { walkSourceFiles, countLineMatches } from '../tools/walk-source-files';
import { detectActiveLanguages } from '../../languages';
import { defaultDispatcher } from '../dispatcher';
import { DUPLICATION, LINT, STRUCTURAL } from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { LintResult } from '../../languages/capabilities/types';
import { DuplicationStats, FileOffender } from './types';

// ─── dispatcher-driven duplication gather ───────────────────────────────────

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
  const result = await defaultDispatcher.gather(cwd, DUPLICATION, providersFor(DUPLICATION, cwd));
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

// ─── canonical hygiene counters (G_v4_7 / D079 / D074) ──────────────────────

/**
 * Routes every quality-side hygiene count through `walkSourceFiles` +
 * `countLineMatches`. Replaces the legacy `grep -rcEf` shell pipeline
 * + `grepPerFile` + `grepCountSimple` duplicates.
 *
 * D079 closure: identical line-counter implementation to `generic.ts`,
 * so health and quality reports cannot drift on the same metric.
 *
 * D074 closure for the JS print-family count only: commented-out
 * matches do NOT count toward that metric on either report.
 * TODO/FIXME/HACK counters explicitly KEEP comments (they ARE
 * comments by definition; skipping them would zero those counters
 * out).
 *
 * `includeTests: true` preserves pre-migration semantics — the legacy
 * grep pipeline matched in test files too.
 */
function hygieneFiles(cwd: string): string[] {
  return walkSourceFiles(cwd, { includeTests: true });
}

function topOffenders(
  cwd: string,
  pattern: string,
  skipComments: boolean,
  limit = 10,
): FileOffender[] {
  const result = countLineMatches(cwd, hygieneFiles(cwd), [pattern], {
    perFileTopN: limit,
    skipComments,
  });
  return result.perFile.map((p) => ({ file: p.file, count: p.count }));
}

// ─── dispatcher-driven structural gather ────────────────────────────────────

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
  const result = await defaultDispatcher.gather(cwd, STRUCTURAL, providersFor(STRUCTURAL, cwd));
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

/** Collect per-file top offenders for detailed reports. */
export function gatherHygieneTopOffenders(cwd: string): {
  topConsoleFiles: FileOffender[];
  topTodoFiles: FileOffender[];
} {
  return {
    // D074: print-family skipComments=true → same convention as health. slop-ok
    topConsoleFiles: topOffenders(cwd, 'console\\.(log|error|warn)', true),
    // TODO/FIXME/HACK are inherently in comments; skipComments would zero them.
    topTodoFiles: topOffenders(cwd, '(TODO|FIXME|HACK)', false),
  };
}

function hygieneCount(cwd: string, pattern: string, skipComments: boolean): number {
  return countLineMatches(cwd, hygieneFiles(cwd), [pattern], { skipComments }).lines;
}

export function gatherHygieneMarkers(cwd: string): {
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  consoleLogCount: number;
  staleFiles: string[];
  mixedLanguages: boolean;
} {
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
    todoCount: hygieneCount(cwd, 'TODO', false),
    fixmeCount: hygieneCount(cwd, 'FIXME', false),
    hackCount: hygieneCount(cwd, 'HACK', false),
    // D079 closure: same implementation as health.consoleLogCount, so the
    // two reports cannot drift. D074: skipComments=true matches health.
    consoleLogCount: hygieneCount(cwd, 'console\\.(log|error|warn)', true),
    staleFiles,
    mixedLanguages,
  };
}

// ─── lint errors (via capability dispatcher) ─────────────────────────────────

/**
 * Aggregates lint tier counts across every active language pack via the
 * capability dispatcher. Mixed-stack repos sum contributions (Python +
 * Node reports combined eslint + ruff counts).
 *
 * Collapse: critical + high → errors, medium + low → warnings, matching
 * the `lintErrors`/`lintWarnings` contract in the quality report shape.
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
