/**
 * Graphify integration -- deterministic AST extraction via tree-sitter.
 * Layer 2 (optional): requires `pip install graphifyy`.
 *
 * Runs graphify's Python API via subprocess, parses structured JSON output.
 * All metrics are derived from EXTRACTED confidence edges only (no LLM).
 */
import * as fs from 'fs';
import { HealthMetrics } from '../types';
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { getPythonExcludeSet } from './exclusions';

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

const GRAPHIFY_SCRIPT = `# Exclusion set derived from src/analyzers/tools/exclusions.ts
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
EXCLUDE_DIRS = ${getPythonExcludeSet()}
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

/** Gather AST-derived metrics via graphify. */
export function gatherGraphifyMetrics(cwd: string): Partial<HealthMetrics> {
  // findPython already verifies graphify is importable
  const pythonCmd = findPython(cwd);
  if (!pythonCmd) {
    return { toolsUnavailable: ['graphify (not installed)'] };
  }

  // Write script to temp file to avoid shell escaping issues
  const scriptPath = `/tmp/dxkit-graphify-${Date.now()}.py`;
  fs.writeFileSync(scriptPath, GRAPHIFY_SCRIPT);
  // Redirect stderr to suppress progress output, run from /tmp to avoid writing to target
  const output = run(`cd /tmp && ${pythonCmd} '${scriptPath}' '${cwd}' 2>/dev/null`, cwd, 120000);
  try {
    fs.unlinkSync(scriptPath);
  } catch {
    /* ignore */
  }

  if (!output) {
    return { toolsUnavailable: ['graphify (failed to run)'] };
  }

  // Graphify prints progress to stdout before the JSON — extract only the JSON line
  const jsonLine = output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!jsonLine) {
    return { toolsUnavailable: ['graphify (no JSON output)'] };
  }

  try {
    const data = JSON.parse(jsonLine) as GraphifyResult & { error?: string };
    if (data.error) {
      return { toolsUnavailable: [`graphify (${data.error})`] };
    }

    return {
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
      toolsUsed: ['graphify'],
    };
  } catch {
    return { toolsUnavailable: ['graphify (parse error)'] };
  }
}

/** Find a working python3 that has graphify installed. Delegates to tool-registry. */
function findPython(cwd: string): string | null {
  const status = findTool(TOOL_DEFS.graphify, cwd);
  return status.available ? status.path : null;
}
