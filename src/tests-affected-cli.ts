/**
 * `vyuh-dxkit tests affected [--diff <ref>] [--json] [--refresh]` — graph-derived
 * incremental test selection (#32).
 *
 * The tests a diff REACHES, computed from graphify's symbol-level call graph. The
 * point is to beat module-graph selection (`vitest --changed`, jest `--onlyChanged`,
 * pytest-testmon's import view): those walk the IMPORT graph, which selects the whole
 * suite in composition-root architectures where every spec imports one config root.
 * The call graph distinguishes "this test actually exercises the change" from "this
 * test's module transitively imports it," so it selects the real subset. Run the
 * affected set inline during development; run the full suite at the gate.
 *
 * SAFETY — an incremental selector that UNDER-selects gives false green, so this
 * fails safe to the full suite whenever the graph can't be trusted. Three gates,
 * any of which forces `complete: false` / `fallback: "all"`:
 *   1. No graph on disk (graphify never ran).
 *   2. A changed file is in a language whose call graph graphify can't resolve
 *      (`callGraphReliability: 'unreliable'`, e.g. C#) — reverse reachability would
 *      silently miss callers.
 *   3. A changed file the graph can't account for — a non-test file with zero
 *      symbols (a graphify gap, or a brand-new file whose tests can't be traced).
 *
 * Graph STALENESS (a changed file newer than the graph's `generatedAt`) is a SOFT
 * `stale` disclosure, NOT a fallback: it can't cause under-selection here. A
 * brand-new symbol is only ever exercised by a NEW test (→ a new file, caught by
 * the untraceable gate) or a CHANGED test (→ included directly, below); an
 * unchanged test cannot call a symbol that did not exist when it was written. So
 * in-place edits still get a precise, fast selection off a slightly-old graph —
 * the whole point of running affected inline — with `--refresh` offered for a
 * fully-current graph and the full suite at the gate as the ultimate backstop.
 *
 * The consumer (a skill, a CI step, the loop) reads `--json`: run `testFiles` when
 * `complete`, else run everything. `tests affected` never sets a failing exit code
 * — it selects; it does not gate.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as logger from './logger';
import { computeChangedFiles } from './baseline/changed-files';
import { tryLoadGraph } from './explore/load';
import { affectedTestsQuery, type AffectedTestsResult } from './explore/queries';
import { languageForFile } from './languages';
import { refreshGraph } from './explore/refresh';

export interface TestsAffectedOptions {
  /** Base ref to diff against; default `HEAD` (uncommitted working changes). */
  readonly diff?: string;
  readonly json?: boolean;
  /** Rebuild the graph (via `health`) before selecting — for the "give me the
   *  fast path, freshen it first" case. */
  readonly refresh?: boolean;
}

interface Selection {
  readonly complete: boolean;
  readonly fallback: 'all' | null;
  readonly reason?: string;
  readonly base: string;
  readonly changedFiles: number;
  readonly testFiles: readonly string[];
  /** Soft signal: the graph predates ≥1 changed file. The selection is still
   *  trustworthy (see the module header) but a `--refresh` would make it exact. */
  readonly stale?: boolean;
}

export async function runTestsAffected(
  cwd: string,
  opts: TestsAffectedOptions = {},
): Promise<void> {
  const base = opts.diff?.trim() || 'HEAD';

  if (opts.refresh) {
    try {
      await refreshGraph(cwd);
    } catch {
      // A failed refresh just means we may hit the staleness/no-graph gate below.
    }
  }

  const selection = selectAffected(cwd, base);
  emit(selection, opts.json);
}

/** Pure-ish decision: compute the selection + which fail-safe (if any) fired. */
function selectAffected(cwd: string, base: string): Selection {
  const changed = computeChangedFiles(cwd, base);
  if (changed === null) {
    return fallback(
      base,
      0,
      `could not resolve the diff base \`${base}\` (not a git repo, or the ref is unreachable)`,
    );
  }
  if (changed.length === 0) {
    // Nothing changed → nothing to run. This is a COMPLETE answer, not a fallback.
    return { complete: true, fallback: null, base, changedFiles: 0, testFiles: [] };
  }

  const graph = tryLoadGraph(cwd);
  if (!graph) {
    return fallback(
      base,
      changed.length,
      'no code graph on disk — run `vyuh-dxkit health` (or pass --refresh) to build it',
    );
  }

  // Gate 2 flags any changed file in an unreliable-call-graph language.
  const unreliable = new Set<string>();
  for (const f of changed) {
    const lang = languageForFile(f);
    if (lang?.callGraphReliability === 'unreliable') unreliable.add(lang.displayName);
  }
  if (unreliable.size > 0) {
    return fallback(
      base,
      changed.length,
      `changed files in ${[...unreliable].sort().join(', ')} have a call graph graphify can't fully resolve — selection would under-run`,
    );
  }

  const result: AffectedTestsResult = affectedTestsQuery(graph, changed);

  // Gate 3: a changed file the graph can't account for → impact unknown (a
  // graphify gap, or a brand-new file whose reaching tests can't be traced).
  if (result.untraceable.length > 0) {
    return fallback(
      base,
      changed.length,
      `the graph can't account for ${result.untraceable.length} changed file(s) (no symbols captured — a new file, or a graphify gap): ${result.untraceable.slice(0, 5).join(', ')}${result.untraceable.length > 5 ? ', …' : ''}`,
    );
  }

  // Soft staleness disclosure (NOT a fallback — see the module header). EXACT
  // when the graph carries a build SHA: the graph is behind if it was built at a
  // different commit than HEAD. That is the honest, non-noisy signal — an
  // in-place uncommitted edit (graph still at HEAD) is NOT flagged, only a graph
  // that genuinely predates the current commit. Falls back to an mtime proxy for
  // a pre-stamp graph.
  const headSha = readHeadSha(cwd);
  let stale: boolean;
  if (graph.meta.commitSha && headSha) {
    stale = graph.meta.commitSha !== headSha;
  } else {
    const graphTime = Date.parse(graph.meta.generatedAt);
    stale = changed.some((f) => {
      try {
        return !Number.isFinite(graphTime) || fs.statSync(path.join(cwd, f)).mtimeMs > graphTime;
      } catch {
        return false; // deleted file — can't be newer
      }
    });
  }

  return {
    complete: true,
    fallback: null,
    base,
    changedFiles: changed.length,
    testFiles: result.testFiles,
    stale,
  };
}

function fallback(base: string, changedFiles: number, reason: string): Selection {
  return { complete: false, fallback: 'all', reason, base, changedFiles, testFiles: [] };
}

/** Current HEAD sha, or undefined outside a git repo — for the exact staleness
 *  compare against the graph's stamped build SHA. */
function readHeadSha(cwd: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function emit(sel: Selection, json?: boolean): void {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'tests-affected.v1',
          complete: sel.complete,
          fallback: sel.fallback,
          reason: sel.reason ?? null,
          base: sel.base,
          changedFiles: sel.changedFiles,
          stale: !!sel.stale,
          testFiles: sel.testFiles,
          testCount: sel.testFiles.length,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (!sel.complete) {
    logger.warn(`Selection incomplete — run the FULL test suite.`);
    logger.dim(`  ${sel.reason}`);
    return;
  }
  if (sel.testFiles.length === 0) {
    logger.info(
      `No tests affected by the change vs \`${sel.base}\` (${sel.changedFiles} file(s) changed).`,
    );
    if (sel.stale)
      logger.dim('  (graph predates a changed file — pass --refresh for an exact map.)');
    return;
  }
  logger.info(`${sel.testFiles.length} test file(s) reach the change vs \`${sel.base}\`:`);
  for (const f of sel.testFiles) logger.dim(`  ${f}`);
  if (sel.stale) {
    logger.dim(
      'Note: graph predates a changed file — selection is safe but pass --refresh for an exact map.',
    );
  }
  logger.dim(`Run just these inline; run the full suite at the gate. \`--json\` for a runner.`);
}
