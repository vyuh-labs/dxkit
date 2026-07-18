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
import { isExcludedPath } from '../tools/exclusions';
import { findTool, TOOL_DEFS } from '../tools/tool-registry';
import { gatherClocMetrics } from '../tools/cloc';
import { walkSourceFiles, countLineMatches } from '../tools/walk-source-files';
import { gatherDebugStatements } from '../tools/debug-statements';
import { defaultDispatcher } from '../dispatcher';
import { DUPLICATION, STRUCTURAL } from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
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
    // D079 closure: shared print-family helper. Identical results to
    // health's consoleLogCount top-N because they call the same function.
    topConsoleFiles: gatherDebugStatements(cwd, { topN: 10 }).topOffenders,
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
  // Stale files: vim swap, backup, temp files tracked in git. The glob
  // pathspecs match tracked files ANYWHERE in the tree — including a
  // committed/vendored node_modules — so the list is filtered through the
  // ONE exclusion predicate (Rule 4). The shipped bug: a repo with
  // node_modules in git got `node_modules/**/*.orig` flagged as net-new
  // stale files the developer never touched (the baseline's install tree
  // differed from CI's).
  const staleRaw = run(
    `git ls-files '*.swp' '*.swo' '*.bak' '*.orig' '*.tmp' '*.log' '*.pyc'`,
    cwd,
  );
  const staleFiles = staleRaw
    ? staleRaw
        .split('\n')
        .filter((l) => l.trim())
        .filter((rel) => !isExcludedPath(cwd, rel))
    : [];

  // Mixed languages: .js files alongside .ts in same source directories (not config files at root)
  const jsInSrc = run(
    "find . -path '*/src/*.js' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.min.js' | head -5",
    cwd,
  );
  const tsInSrc = run(
    "find . -path '*/src/*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' | head -1",
    cwd,
  );
  const mixedLanguages = !!(jsInSrc && tsInSrc);

  return {
    todoCount: hygieneCount(cwd, 'TODO', false),
    fixmeCount: hygieneCount(cwd, 'FIXME', false),
    hackCount: hygieneCount(cwd, 'HACK', false),
    // D079 closure: shared print-family helper aggregates TS/JS
    // console.* + Py print + Go fmt.Print across language-scoped walks.
    // Identical to health.consoleLogCount by construction.
    consoleLogCount: gatherDebugStatements(cwd).count,
    staleFiles,
    mixedLanguages,
  };
}

// Lint counts + the augmented "(not run: <packs>)" tool label come
// from the cached `cache.capabilities.lint` envelope. The cache
// builder calls `defaultDispatcher.gatherWithProvenance` for LINT
// and bakes the skipped-pack provenance into `envelope.tool`, so
// every consumer sees the same label.
