/**
 * Graphify integration -- deterministic AST extraction via tree-sitter.
 * Layer 2 (optional): requires `pip install graphifyy`.
 *
 * Two call shapes:
 *
 *   1. `gatherGraphifyResult(cwd)` — the canonical capability-shaped
 *      gather. Returns a `StructuralResult` envelope or a typed outcome
 *      describing why it was skipped/failed. Consumed by the
 *      `graphifyProvider` capability wrapper and by the quality
 *      analyzer's dispatcher call.
 *
 *   2. `gatherGraphifyMetrics(cwd)` — thin bridge retained for
 *      `src/analyzers/tools/parallel.ts`, which loads gatherers by
 *      module name + function name in a child process. Decomposes the
 *      envelope into the legacy `HealthMetrics` subset and goes away
 *      in Phase C.
 *
 * Known flake (Phase 10f.2): `/tmp/graphify-venv` race + `/tmp`
 * cleanup kills graphify ~50% of runs. Separate behavioral fix; this
 * file's structure is unaffected.
 */
import * as fs from 'fs';
import { HealthMetrics } from '../types';
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { getPythonExcludeSet } from './exclusions';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { StructuralResult } from '../../languages/capabilities/types';

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

/** Build the graphify Python script with cwd-specific exclusions baked in. */
function buildGraphifyScript(cwd: string): string {
  return `# Exclusion set derived from src/analyzers/tools/exclusions.ts
import json, sys, os, tempfile
from pathlib import Path
from collections import Counter

# Redirect graphify cache to /tmp so we don't pollute the target repo
_cache_dir = Path(tempfile.mkdtemp(prefix='dxkit-graphify-'))

try:
    from graphify.extract import extract, collect_files
    from graphify.build import build
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes
except ImportError:
    print(json.dumps({"error": "graphify not installed"}))
    sys.exit(0)

target = Path(sys.argv[1])

# collect_files doesn't exclude node_modules etc, so filter manually
EXCLUDE_DIRS = ${getPythonExcludeSet(cwd)}
all_files = collect_files(target)
files = [f for f in all_files if not any(ex in f.parts for ex in EXCLUDE_DIRS)]
if not files:
    print(json.dumps({"error": "no files found"}))
    sys.exit(0)

# Monkey-patch cache to use /tmp instead of target repo
import graphify.cache as _gc
_gc.cache_dir = lambda root=None: _cache_dir / "cache"
(_cache_dir / "cache").mkdir(parents=True, exist_ok=True)

# Suppress progress output by redirecting stdout during extraction
import io
_real_stdout = sys.stdout
sys.stdout = io.StringIO()
result = extract(files)
sys.stdout = _real_stdout
G = build([result], directed=True)
communities = cluster(G)

# Functions vs modules
nodes = list(G.nodes(data=True))
functions = [(n, d) for n, d in nodes if "()" in d.get("label", "")]
modules = [(n, d) for n, d in nodes if "()" not in d.get("label", "")]

# Functions per file
file_funcs = Counter()
for n, d in functions:
    sf = d.get("source_file", "")
    file_funcs[sf] += 1

max_file = file_funcs.most_common(1)[0] if file_funcs else ("", 0)

# God nodes (degree > 15)
gods = god_nodes(G, top_n=50)
god_count = sum(1 for g in gods if g["edges"] > 15)

# Cohesion
scores = score_all(G, communities) if communities else {}
avg_cohesion = sum(scores.values()) / len(scores) if scores else 0.0

# Orphan modules (no inbound imports)
import_targets = set()
for u, v, data in G.edges(data=True):
    if data.get("relation") == "imports_from":
        import_targets.add(v)
module_ids = set(n for n, d in modules)
orphans = module_ids - import_targets

# Dead imports (imported but never called)
call_targets = set()
for u, v, data in G.edges(data=True):
    if data.get("relation") == "calls":
        call_targets.add(v)
dead = import_targets - call_targets - module_ids

# Commented code ratio: source files with 0 function/class AST nodes
source_files_set = set()
files_with_nodes = set()
for n, d in nodes:
    sf = d.get("source_file", "")
    if sf:
        source_files_set.add(sf)
        if "()" in d.get("label", "") or any(
            data.get("relation") == "method"
            for _, _, data in G.edges(n, data=True)
        ):
            files_with_nodes.add(sf)

total_src = len(source_files_set)
empty_files = total_src - len(files_with_nodes)
commented_ratio = empty_files / total_src if total_src > 0 else 0.0

# Clean up temp cache
import shutil
shutil.rmtree(str(_cache_dir), ignore_errors=True)

print(json.dumps({
    "functionCount": len(functions),
    "classCount": len([n for n, d in modules if any(
        data.get("relation") == "method" for _, _, data in G.edges(n, data=True)
    )]),
    "maxFunctionsInFile": max_file[1] if max_file else 0,
    "maxFunctionsFilePath": str(max_file[0]) if max_file else "",
    "godNodeCount": god_count,
    "communityCount": len(communities),
    "avgCohesion": round(avg_cohesion, 3),
    "orphanModuleCount": len(orphans),
    "deadImportCount": len(dead),
    "commentedCodeRatio": round(commented_ratio, 3),
    "sourceFilesInGraph": total_src,
}))
`;
}

/**
 * Outcome union mirrors the other global wrappers (gitleaks, semgrep,
 * jscpd). The capability provider collapses this to `StructuralResult
 * | null`; the legacy bridge reads `unavailable.reason` so the
 * `toolsUnavailable` strings stay byte-identical across the migration.
 */
export type StructuralGatherOutcome =
  | { kind: 'success'; envelope: StructuralResult }
  | { kind: 'unavailable'; reason: string };

/**
 * Per-cwd memoization of the graphify outcome. Graphify is the heaviest
 * external tool dxkit shells out to (~10-60s depending on repo size);
 * memoizing ensures the Layer 2 reshape path + the capability
 * dispatcher's `graphifyProvider` share one invocation per analyzer run.
 * Tests reset via `clearGraphifyCache`.
 *
 * Same constraints as the gitleaks cache: module-scoped, no automatic
 * invalidation, safe for the one-shot CLI shape.
 */
const graphifyOutcomeCache = new Map<string, StructuralGatherOutcome>();

/** Reset memoized graphify outcomes. Test seam; no production callers. */
export function clearGraphifyCache(cwd?: string): void {
  if (cwd === undefined) graphifyOutcomeCache.clear();
  else graphifyOutcomeCache.delete(cwd);
}

/**
 * Single source of truth for the graphify subprocess invocation.
 * `graphifyProvider` (new capability path) and `gatherGraphifyMetrics`
 * (legacy Layer 2 parallel path) both consume the envelope via this
 * helper — byte-identical output across both paths. Memoized per-cwd.
 */
export function gatherGraphifyResult(cwd: string): StructuralGatherOutcome {
  const cached = graphifyOutcomeCache.get(cwd);
  if (cached) return cached;
  const outcome = computeGraphifyOutcome(cwd);
  graphifyOutcomeCache.set(cwd, outcome);
  return outcome;
}

function computeGraphifyOutcome(cwd: string): StructuralGatherOutcome {
  const pythonCmd = findPython(cwd);
  if (!pythonCmd) return { kind: 'unavailable', reason: 'not installed' };

  const scriptPath = `/tmp/dxkit-graphify-${Date.now()}.py`;
  fs.writeFileSync(scriptPath, buildGraphifyScript(cwd));
  // Redirect stderr to suppress progress output, run from /tmp to avoid writing to target
  const output = run(`cd /tmp && ${pythonCmd} '${scriptPath}' '${cwd}' 2>/dev/null`, cwd, 120000);
  try {
    fs.unlinkSync(scriptPath);
  } catch {
    /* ignore */
  }

  if (!output) return { kind: 'unavailable', reason: 'failed to run' };

  // Graphify prints progress to stdout before the JSON — extract only the JSON line.
  const jsonLine = output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!jsonLine) return { kind: 'unavailable', reason: 'no JSON output' };

  let data: GraphifyResult & { error?: string };
  try {
    data = JSON.parse(jsonLine) as GraphifyResult & { error?: string };
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }
  if (data.error) return { kind: 'unavailable', reason: data.error };

  const envelope: StructuralResult = {
    schemaVersion: 1,
    tool: 'graphify',
    functionCount: data.functionCount,
    classCount: data.classCount,
    maxFunctionsInFile: data.maxFunctionsInFile,
    maxFunctionsFilePath: data.maxFunctionsFilePath,
    godNodeCount: data.godNodeCount,
    communityCount: data.communityCount,
    avgCohesion: data.avgCohesion,
    orphanModuleCount: data.orphanModuleCount,
    deadImportCount: data.deadImportCount,
    commentedCodeRatio: data.commentedCodeRatio,
  };
  return { kind: 'success', envelope };
}

/**
 * Capability-shaped provider. Register in
 * `src/languages/capabilities/global.ts:GLOBAL_CAPABILITIES.structural`
 * so the dispatcher picks it up via `providersFor(STRUCTURAL)`.
 */
export const graphifyProvider: CapabilityProvider<StructuralResult> = {
  source: 'graphify',
  async gather(cwd) {
    const outcome = gatherGraphifyResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * LEGACY bridge: returns `Partial<HealthMetrics>`. Consumed by
 * `src/analyzers/tools/parallel.ts`'s dynamic-require loader. Removed
 * in Phase 10e.C when Layer 2 parallel moves onto the dispatcher.
 * Byte-identical strings to the pre-B.9.2 behavior, including the
 * exact `toolsUnavailable` phrasings: `graphify (not installed)`,
 * `graphify (failed to run)`, `graphify (no JSON output)`,
 * `graphify (parse error)`, `graphify (<inner error>)`.
 */
export function gatherGraphifyMetrics(cwd: string): Partial<HealthMetrics> {
  const outcome = gatherGraphifyResult(cwd);
  if (outcome.kind === 'unavailable') {
    return { toolsUnavailable: [`graphify (${outcome.reason})`] };
  }
  const e = outcome.envelope;
  return {
    functionCount: e.functionCount,
    classCount: e.classCount,
    maxFunctionsInFile: e.maxFunctionsInFile,
    maxFunctionsFilePath: e.maxFunctionsFilePath,
    godNodeCount: e.godNodeCount,
    communityCount: e.communityCount,
    avgCohesion: e.avgCohesion,
    orphanModuleCount: e.orphanModuleCount,
    deadImportCount: e.deadImportCount,
    commentedCodeRatio: e.commentedCodeRatio,
    toolsUsed: ['graphify'],
  };
}

/** Find a working python3 that has graphify installed. Delegates to tool-registry. */
function findPython(cwd: string): string | null {
  const status = findTool(TOOL_DEFS.graphify, cwd);
  return status.available ? status.path : null;
}
