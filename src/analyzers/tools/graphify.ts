/**
 * Graphify integration — deterministic AST extraction via tree-sitter.
 * Layer 2 (optional): requires `pip install graphifyy`.
 *
 * Exposes one gather helper — `gatherGraphifyResult(cwd)` — returning a
 * typed outcome with either a `StructuralResult` envelope or the reason
 * extraction was skipped. Consumed by the capability provider
 * (`graphifyProvider`) and by the Layer 2 legacy-field reshape path in
 * `tools/parallel.ts`. Memoized per-cwd so both callers share one
 * invocation per analyzer run.
 *
 * 4.2 driver rewrite (the 0.8.40 → 0.9.25 bump): the previous driver
 * embedded a ~650-line Python script that imported graphify as a library
 * and serialized our wire dialect in-process — written against 0.8.x
 * internals that the 0.9.11 `extractors/*` refactor moved. The driver now
 * shells graphify's own supported CLI (`extract --code-only`, headless
 * AST-only, no API key) into a throwaway `--out` dir (nothing is written
 * into the target repo), then translates the produced graph through the
 * pure `graphify-translate.ts` module. Exclusions, kinds, exported flags,
 * communities, metrics and the size cap all live there, unit-testable
 * without Python. Node ids are graphify's path-based deterministic ids
 * (stable across runs since their 0.9.0 — the property the old per-run
 * `n<idx>` ids lacked).
 *
 * D013 (10f.2) — `/tmp/graphify-venv` was prone to systemd-tmpfiles
 * cleanup and first-install races. The venv lives at
 * `~/.cache/dxkit/tools-venv` via `tool-registry.ts:TOOLS_VENV`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { runDetached } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { translateGraphifyGraph } from './graphify-translate';
import { toProjectRelative } from './paths';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { StructuralResult } from '../../languages/capabilities/types';
import { GRAPH_REPORT_PATH, type GraphJson } from '../../explore/types';

interface GraphifyResult {
  functionCount: number;
  classCount: number;
  maxFunctionsInFile: number;
  maxFunctionsFilePath: string;
  godNodeCount: number;
  communityCount: number;
  avgCohesion: number;
  orphanModuleCount: number;
  deadImportCount: number;
  commentedCodeRatio: number;
  sourceFilesInGraph: number;
}

/**
 * Outcome union mirrors the other global wrappers (gitleaks, semgrep,
 * jscpd). The capability provider collapses this to `StructuralResult
 * | null`; the Layer 2 reshape in `tools/parallel.ts` reads
 * `unavailable.reason` so `toolsUnavailable` surfaces the precise
 * failure mode (`graphify (not installed)`, `graphify (failed to run)`,
 * `graphify (parse error)`, …).
 */
export type StructuralGatherOutcome =
  | { kind: 'success'; envelope: StructuralResult }
  | { kind: 'unavailable'; reason: string };

/**
 * Graph-artifact outcome for the explore CLI / dashboard viz / future
 * graph consumers. Sibling to `StructuralGatherOutcome` but carries
 * the full `GraphJson` instead of the aggregate envelope. Both
 * outcomes are populated from a single graphify invocation; consumers
 * pick the slice they need.
 */
export type GraphGatherOutcome =
  | { kind: 'success'; graph: GraphJson }
  | { kind: 'unavailable'; reason: string };

/**
 * Per-cwd memoization. Graphify is the heaviest external tool dxkit
 * shells out to (~10-60s depending on repo size); the two outcomes
 * share one invocation, populated atomically via the run promise
 * cache below.
 *
 * Module-scoped, no automatic invalidation, safe for the one-shot
 * CLI shape (same constraints as the gitleaks cache).
 */
const aggregatesCache = new Map<string, StructuralGatherOutcome>();
const graphCache = new Map<string, GraphGatherOutcome>();

/**
 * Run-coalescing promise cache. Concurrent callers (e.g. the parallel
 * capability dispatcher AND a CLI subcommand both kicking off graphify
 * gather) share a single in-flight invocation instead of racing
 * to start their own. Without this, on first-access the cache check
 * returns empty for both callers, both fire the subprocess,
 * and the second one's result silently overwrites the first.
 */
const runPromises = new Map<string, Promise<void>>();

/**
 * Aggregate-metrics outcome — the existing API. Consumed by
 * `graphifyProvider` (capability dispatcher) + the Layer 2 legacy
 * reshape in `tools/parallel.ts`. Signature unchanged from pre-2.7.
 */
export async function gatherGraphifyResult(cwd: string): Promise<StructuralGatherOutcome> {
  await runGraphifyOnce(cwd);
  // runGraphifyOnce guarantees the cache is populated on completion;
  // the `!` is safe.
  return aggregatesCache.get(cwd)!;
}

/**
 * Graph-artifact outcome — new in 2.7. Consumed by the explore CLI's
 * `loadGraph` path (via the `.dxkit/reports/graph.json` write), by
 * direct in-memory consumers that want the graph without a disk
 * roundtrip, and by the context-CLI + reachability gathers.
 *
 * Shares one invocation with `gatherGraphifyResult` per the
 * runPromises cache — concurrent calls coalesce; sequential calls
 * read from memoized caches.
 *
 * Side effect: when the gather succeeds AND `opts.writeToDisk` is
 * truthy (default), the graph is written to
 * `.dxkit/reports/graph.json`. Set `writeToDisk: false` for one-shot
 * in-memory consumers (tests, ephemeral CLI flows) that don't want
 * the file-system side effect. The write is idempotent — repeated
 * calls overwrite atomically.
 */
export async function gatherGraphifyGraph(
  cwd: string,
  opts: { writeToDisk?: boolean } = {},
): Promise<GraphGatherOutcome> {
  await runGraphifyOnce(cwd);
  const outcome = graphCache.get(cwd)!;
  const shouldWrite = opts.writeToDisk !== false;
  if (shouldWrite && outcome.kind === 'success') {
    writeGraphArtifact(cwd, outcome.graph);
  }
  return outcome;
}

/**
 * Persist the graph JSON to its canonical disk location. Failures
 * are swallowed with a warning to stderr — graph.json is a
 * convenience artifact, not load-bearing for any analyzer flow that
 * could fail because of a missing report file.
 */
function writeGraphArtifact(cwd: string, graph: GraphJson): void {
  const absPath = path.join(cwd, GRAPH_REPORT_PATH);
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(graph));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dxkit: failed to write ${GRAPH_REPORT_PATH}: ${msg}\n`);
  }
}

async function runGraphifyOnce(cwd: string): Promise<void> {
  // Fast path: both caches already populated → nothing to do.
  if (aggregatesCache.has(cwd) && graphCache.has(cwd)) return;
  let p = runPromises.get(cwd);
  if (!p) {
    p = computeAndCache(cwd).finally(() => {
      // Drop the promise once it settles so a future cache-miss
      // (e.g. after manual cache eviction in tests) can re-run.
      // The aggregate + graph caches remain authoritative.
      runPromises.delete(cwd);
    });
    runPromises.set(cwd, p);
  }
  return p;
}

function setUnavailable(cwd: string, reason: string): void {
  aggregatesCache.set(cwd, { kind: 'unavailable', reason });
  graphCache.set(cwd, { kind: 'unavailable', reason });
}

async function computeAndCache(cwd: string): Promise<void> {
  const pythonCmd = findPython(cwd);
  if (!pythonCmd) {
    setUnavailable(cwd, 'not installed');
    return;
  }

  // Throwaway output dir via mkdtempSync — graphify's `--out` redirect
  // sends its entire `graphify-out/` (graph.json, graph.html, manifest,
  // AST cache) here, so nothing is ever written into the target repo.
  // Removed after the process (and its atexit handlers) fully exits.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-graphify-'));
  try {
    // `extract --code-only` is graphify's headless AST-only path: local
    // tree-sitter extraction + clustering, no LLM, no API key. Spawned
    // with its own process group (runDetached) so tree-sitter worker
    // subprocesses die atomically on timeout.
    const outcome = await runDetached(
      pythonCmd,
      ['-m', 'graphify', 'extract', cwd, '--code-only', '--out', outDir],
      {
        cwd: outDir,
        timeoutMs: 300000, // 5 min — multi-thousand-file frontend repos
      },
    );

    const graphPath = path.join(outDir, 'graphify-out', 'graph.json');
    if (!fs.existsSync(graphPath)) {
      if (outcome.timedOut) {
        setUnavailable(cwd, 'timed out at 300s (try narrowing scan scope via .dxkit-ignore)');
        return;
      }
      // Surface the first meaningful stderr line so the customer can
      // see what broke (tree-sitter parse error, Python ImportError,
      // OOM kill, etc.). Truncate aggressively — toolsUnavailable[]
      // entries shouldn't carry multi-line tracebacks.
      const firstStderrLine = outcome.stderr
        .trim()
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim();
      const reason = firstStderrLine
        ? `failed: ${firstStderrLine.length > 200 ? firstStderrLine.slice(0, 197) + '...' : firstStderrLine}`
        : outcome.code !== 0 && outcome.code !== null
          ? `failed with exit code ${outcome.code} (no stderr captured — likely killed by the OS, e.g. OOM)`
          : 'failed to run (no graph produced, no stderr captured)';
      setUnavailable(cwd, reason);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    } catch {
      setUnavailable(cwd, 'parse error');
      return;
    }

    const { graph, metrics } = translateGraphifyGraph(raw, cwd, {
      graphifyVersion: readGraphifyVersion(pythonCmd),
      dxkitVersion: readDxkitVersion(),
    });

    if (graph.nodes.length === 0) {
      setUnavailable(cwd, 'no files found');
      return;
    }

    aggregatesCache.set(cwd, { kind: 'success', envelope: buildGraphifyEnvelope(metrics, cwd) });

    const commitSha = readHeadShaSafe(cwd);
    const enrichedGraph: GraphJson = {
      ...graph,
      meta: {
        ...graph.meta,
        // Stamp the commit the graph reflects, so consumers can decide EXACT
        // staleness (graph SHA vs current HEAD) and a CI job can key a cached
        // graph on it. Omitted when HEAD can't be read (not a git repo).
        ...(commitSha ? { commitSha } : {}),
      },
    };
    graphCache.set(cwd, { kind: 'success', graph: enrichedGraph });

    copyViewerArtifact(cwd, outDir, enrichedGraph);
  } finally {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Copy graphify's interactive vis.js viewer next to graph.json so the
 * dashboard Graph tab can embed it, with the sidecar meta the renderer
 * reads to label the view. graphify skips graph.html generation above
 * its node ceiling; absence is tolerated — the dashboard surfaces a
 * clear empty-state when graph.html isn't on disk.
 */
function copyViewerArtifact(cwd: string, outDir: string, graph: GraphJson): void {
  try {
    const htmlSrc = path.join(outDir, 'graphify-out', 'graph.html');
    if (!fs.existsSync(htmlSrc)) return;
    const reportsDir = path.join(cwd, path.dirname(GRAPH_REPORT_PATH));
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.copyFileSync(htmlSrc, path.join(reportsDir, 'graph.html'));
    fs.writeFileSync(
      path.join(reportsDir, 'graph.html.meta.json'),
      JSON.stringify({
        mode: 'full',
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        communities: graph.communities.length,
        aggregatedNodeCount: null,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dxkit: graph.html not copied (${msg})\n`);
  }
}

/** The installed graphifyy package version, for the graph meta stamp.
 *  Best-effort — 'unknown' on any failure (consumers tolerate). */
function readGraphifyVersion(pythonCmd: string): string {
  try {
    return execSync(
      `"${pythonCmd}" -c "from importlib.metadata import version; print(version('graphifyy'))"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 },
    ).trim();
  } catch {
    return 'unknown';
  }
}

/** The current git HEAD sha, or undefined outside a git repo / on any error.
 *  Stamped into the graph meta so staleness can be judged exactly. */
function readHeadShaSafe(cwd: string): string | undefined {
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

/**
 * Read the dxkit version string from the package.json bundled into
 * the installed package. Resolved at runtime via a relative path from
 * this module's directory; works for both `npm install -g` and local
 * `npm link` flows. Returns 'unknown' on any failure (caller tolerates).
 */
function readDxkitVersion(): string {
  try {
    // dist/analyzers/tools/graphify.js → ../../../package.json
    const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pure metrics-to-envelope reshape so the normalization contract is
 * unit-testable without shelling out to Python.
 *
 * `maxFunctionsFilePath` is normalized defensively: the translator
 * already emits project-relative paths, but renderers downstream emit
 * this field verbatim into customer-facing markdown, so the gather
 * layer guarantees the invariant regardless of producer — mirrors the
 * gitleaks / semgrep / grep-secrets pattern where each tool wrapper
 * owns its own path normalization.
 */
export function buildGraphifyEnvelope(data: GraphifyResult, cwd: string): StructuralResult {
  return {
    schemaVersion: 1,
    tool: 'graphify',
    functionCount: data.functionCount,
    classCount: data.classCount,
    maxFunctionsInFile: data.maxFunctionsInFile,
    maxFunctionsFilePath: data.maxFunctionsFilePath
      ? toProjectRelative(cwd, data.maxFunctionsFilePath)
      : '',
    godNodeCount: data.godNodeCount,
    communityCount: data.communityCount,
    avgCohesion: data.avgCohesion,
    orphanModuleCount: data.orphanModuleCount,
    deadImportCount: data.deadImportCount,
    commentedCodeRatio: data.commentedCodeRatio,
  };
}

/**
 * Capability-shaped provider. Register in
 * `src/languages/capabilities/global.ts:GLOBAL_CAPABILITIES.structural`
 * so the dispatcher picks it up via `providersFor(STRUCTURAL)`.
 */
// Exposes the underlying outcome via `gatherOutcome` so the dispatcher
// captures graphify's actual failure reason (Python missing / graphify
// package missing / timeout / parse error / empty result) into
// `DispatchOutcome.skipReasons`. Without it, every failure mode
// collapses to the same generic prose at the renderer layer, hiding
// install-vs-runtime distinctions the user would act on differently.
export const graphifyProvider: CapabilityProvider<StructuralResult> & {
  gatherOutcome(cwd: string): Promise<StructuralGatherOutcome>;
} = {
  source: 'graphify',
  async gather(cwd) {
    const outcome = await gatherGraphifyResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherGraphifyResult(cwd);
  },
};

/** Find a working python3 that has graphify installed. Delegates to tool-registry. */
function findPython(cwd: string): string | null {
  const status = findTool(TOOL_DEFS.graphify, cwd);
  return status.available ? status.path : null;
}
