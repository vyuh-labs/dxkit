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
 * D013 (10f.2) — `/tmp/graphify-venv` was prone to systemd-tmpfiles
 * cleanup and first-install races. The venv now lives at
 * `~/.cache/dxkit/tools-venv` via `tool-registry.ts:TOOLS_VENV`;
 * this file's per-run tempfile also migrated to `fs.mkdtempSync` so
 * two concurrent dxkit processes never collide on a script name.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDetached } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { getPythonExcludeFilter } from './exclusions';
import { allSourceExtensions } from '../../languages';
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
  graph?: GraphJson;
}

/**
 * Build the graphify Python script with cwd-specific exclusions baked in.
 *
 * Exported so the structural contract of the generated script — the
 * `if __name__ == '__main__'` guard that keeps ProcessPoolExecutor workers
 * from re-running extraction under spawn/forkserver (Python 3.14's Linux
 * default), and the public `extract(cache_root=...)` cache redirect that
 * replaced the fragile `cache_dir` monkeypatch — is unit-testable without a
 * Python interpreter or graphify installed (mirrors `buildGraphifyEnvelope`).
 */
export function buildGraphifyScript(cwd: string): string {
  const { dirsSet, pathsList, fileGlobsList } = getPythonExcludeFilter(cwd);
  // Source-extension allowlist for the CODE graph. graphify's collect_files
  // enumerates everything its _DISPATCH table can parse — including .md / .mdx
  // (markdown headings → "module" nodes) and .json (config + lockfile keys →
  // nodes). On NodeGoat that produced a graph that was ~92% non-code:
  // package-lock.json alone contributed 137 nodes, .claude/**/*.md (dxkit's
  // own scaffolding) 205, .vyuh-dxkit.json 53 — versus 51 nodes of real app
  // code. Doc/config nodes pollute every graph-derived surface (communities,
  // hot-files, api-surface, god-node ranking) and the context-hook's file
  // summaries. Restrict the walk to the pack-declared source extensions
  // (Rule 3/6: "what counts as source" is a language fact). graphify's TS
  // import resolution reads tsconfig.json / package.json by direct path, not
  // from the collected set, so dropping config files from the walk does not
  // affect import-edge resolution.
  const includeExtsSet = `set([${allSourceExtensions()
    .map((e) => `'${e.toLowerCase()}'`)
    .join(', ')}])`;
  return `# Exclusion set derived from src/analyzers/tools/exclusions.ts
import json, sys, os
from pathlib import Path
from collections import Counter

try:
    from graphify.extract import extract, collect_files
    from graphify.build import build
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes
except ImportError:
    print(json.dumps({"error": "graphify not installed"}))
    sys.exit(0)

# Three-axis exclusion. EXCLUDE_DIRS is basename-only (any path
# segment matching skips the file). EXCLUDE_PATHS holds multi-segment
# relative paths from .dxkit-ignore (e.g. 'app/modules/plugins/VendorPlugin')
# and matches via substring on the file's relpath. EXCLUDE_FILE_GLOBS
# carries basename-glob patterns from bundled defaults + .gitignore
# ('*.min.js', '*.bundle.js', '*.chunk.js', '*.generated.ts', '*.d.ts')
# so graphify's enumeration matches what dxkit's canonical walker
# already excludes everywhere else.
import fnmatch
EXCLUDE_DIRS = ${dirsSet}
EXCLUDE_PATHS = ${pathsList}
EXCLUDE_FILE_GLOBS = ${fileGlobsList}

# Source-extension allowlist (pack-declared via allSourceExtensions()).
# Keeps the CODE graph to actual source files — graphify also parses .md /
# .json into nodes, which is noise for code navigation. Empty set would be a
# bug (no files pass); the TS builder always emits a non-empty literal.
INCLUDE_EXTS = ${includeExtsSet}

# Bytes-per-line floor above which a file is almost certainly minified
# / bundled output. Mirrors the heuristic in
# src/analyzers/tools/minified-detection.ts so graphify's enumeration
# applies the same filter dxkit's source-file walker does. Web-client's
# webpack-hash bundle index-j54KQSsm.js carried ~4,606 detected
# "functions" before this guard — pre-fix the densest-file metric
# pointed at minified output instead of human-authored code.
_MINIFIED_BYTES_PER_LINE = 500
_MINIFIED_SAMPLE_BYTES = 4096
_MINIFIABLE_EXTS = {'.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.less'}

def _is_likely_minified(f):
    if f.suffix.lower() not in _MINIFIABLE_EXTS:
        return False
    try:
        with open(f, 'rb') as fh:
            buf = fh.read(_MINIFIED_SAMPLE_BYTES)
        if not buf:
            return False
        newlines = buf.count(b'\\n')
        lines_in_sample = max(1, newlines)
        return (len(buf) / lines_in_sample) >= _MINIFIED_BYTES_PER_LINE
    except OSError:
        return False

def _is_excluded(f):
    # Source-extension allowlist first: anything that isn't a pack-declared
    # source file (markdown, JSON config, lockfiles, plain text) is not part
    # of the code graph.
    if f.suffix.lower() not in INCLUDE_EXTS:
        return True
    if any(seg in EXCLUDE_DIRS for seg in f.parts):
        return True
    name = f.name
    for glob in EXCLUDE_FILE_GLOBS:
        if fnmatch.fnmatchcase(name, glob):
            return True
    if EXCLUDE_PATHS:
        try:
            rel = str(f.relative_to(target)).replace(os.sep, '/')
        except ValueError:
            rel = str(f).replace(os.sep, '/')
        for p in EXCLUDE_PATHS:
            if rel == p or rel.startswith(p + '/') or ('/' + p + '/') in ('/' + rel + '/'):
                return True
    if _is_likely_minified(f):
        return True
    return False


# ── Per-language symbol-level enrichment ─────────────────────────────────────
# 2.7 Sprint 1: extract per-node line numbers + exported flags so the
# graph JSON downstream consumers (explore CLI api-surface query, dashboard
# viz "exported only" filter, future 2.8 reachability) can answer "is this
# symbol part of the public API?" The reliability tier is per-pack (see
# LanguageSupport.exportDetection in src/languages/types.ts) — packs
# declared 'unreliable' (today: ruby) get \`exported: absent\` per the
# schema's "absent = unknown" convention. Tiers 'full' and 'partial' are
# checked here via line-scan against per-extension patterns.

import re as _re

# Maps file extension → (pack-id, reliability-tier). Mirrors
# LanguageSupport.exportDetection declarations across the 8 packs. Ruby
# (.rb) is intentionally absent because the pack declares
# 'unreliable' — nodes from .rb files inherit \`exported: absent\`.
_EXT_TO_PACK = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript',
    '.jsx': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.java': 'java',
    '.rb': 'ruby',
}

# Reliability tier per pack (mirrors LanguageSupport declarations).
# Used to skip line-scan for unreliable packs entirely.
_PACK_RELIABILITY = {
    'typescript': 'full', 'python': 'partial', 'go': 'full',
    'rust': 'full', 'csharp': 'full', 'kotlin': 'full',
    'java': 'full', 'ruby': 'unreliable',
}

# File-line cache so each source file is read at most once during
# the per-node enrichment pass. ~5MB for a 600-file repo; acceptable
# for a one-shot CLI invocation.
_FILE_LINES = {}

def _get_source_line(file_path, line_no):
    if file_path not in _FILE_LINES:
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as fh:
                _FILE_LINES[file_path] = fh.readlines()
        except OSError:
            _FILE_LINES[file_path] = []
    lines = _FILE_LINES[file_path]
    if 1 <= line_no <= len(lines):
        return lines[line_no - 1].rstrip('\\n').rstrip('\\r')
    return ''

def _ext_of(source_file):
    if not source_file:
        return ''
    i = source_file.rfind('.')
    return source_file[i:].lower() if i >= 0 else ''

def _detect_exported(source_file, line_no, name):
    """Return True / False / None per the GraphNode.exported semantics.
    None = absent (we don't know; pack is 'unreliable' or detection failed).
    """
    ext = _ext_of(source_file)
    pack = _EXT_TO_PACK.get(ext)
    if not pack:
        return None
    if _PACK_RELIABILITY.get(pack) == 'unreliable':
        return None
    line = _get_source_line(source_file, line_no) if line_no else ''
    if pack == 'typescript':
        # TypeScript / JavaScript: line starts with \`export\` keyword
        # (covers \`export function\`, \`export class\`, \`export default\`,
        # \`export const\`, \`export { foo }\`, \`export * from ...\`).
        return bool(_re.match(r'^\\s*export\\b', line))
    if pack == 'python':
        # Public-name heuristic. \`__all__\` lookup would be stricter
        # but requires module-level state; v1 ships the simpler form.
        # Names starting with \`_\` are conventionally private.
        return bool(name) and not name.startswith('_')
    if pack == 'go':
        # Identifier starts with uppercase = exported (idiomatic Go).
        return bool(name) and name[0:1].isupper()
    if pack == 'rust':
        # \`pub fn\`, \`pub struct\`, \`pub(crate) fn\`, \`pub(super) fn\`
        return bool(_re.match(r'^\\s*pub(\\s|\\()', line))
    if pack == 'csharp':
        # \`public\` modifier somewhere in the declaration line
        return bool(_re.search(r'\\bpublic\\b', line))
    if pack == 'kotlin':
        # Kotlin: public-by-default unless an explicit narrower modifier
        return not bool(_re.search(r'\\b(private|internal|protected)\\b', line))
    if pack == 'java':
        # \`public\` modifier somewhere in the declaration line
        return bool(_re.search(r'\\bpublic\\b', line))
    return None

def _parse_line_no(node_attrs):
    """Graphify stores source_location as \`L<line>\` (string) or sometimes the
    raw number. Return int line or 0 when absent/malformed."""
    loc = node_attrs.get('source_location')
    if loc is None:
        return 0
    if isinstance(loc, int):
        return loc
    s = str(loc)
    if s.startswith('L'):
        s = s[1:]
    try:
        return int(s)
    except (ValueError, TypeError):
        return 0

def _strip_paren_suffix(label):
    """\`createUser()\` → \`createUser\`, \`UserRepository.findById()\` → \`findById\`."""
    if not label:
        return ''
    s = label.rstrip(')').rstrip('(')
    # Method labels are \`Class.method\` — keep only the right-hand side.
    if '.' in s:
        s = s.rsplit('.', 1)[1]
    return s

if __name__ == '__main__':
    # ProcessPoolExecutor workers re-import this module under spawn/
    # forkserver (the Python 3.14 default on Linux); the __main__ guard
    # keeps extraction from re-running per worker. graphify's own
    # _extract_parallel requires this guard (it warns BrokenProcessPool
    # and dies without it). See graphify/extract.py:_extract_parallel.
    target = Path(sys.argv[1])
    # graphify's on-disk cache is redirected here (the public cache_root
    # param passed to extract() below) so it never lands in the target
    # repo. The TS caller owns this dir's lifecycle — it lives under the
    # ephemeral scriptDir and is removed after this process fully exits,
    # which is the only point that survives graphify's atexit stat-index
    # flush (graphify/cache.py registers _flush_stat_index at exit, so a
    # Python-side rmtree here would be undone by that post-exit write).
    _cache_dir = Path(sys.argv[2])
    all_files = collect_files(target)
    files = [f for f in all_files if not _is_excluded(f)]
    if not files:
        print(json.dumps({"error": "no files found"}))
        sys.exit(0)

    # Suppress progress output by redirecting stdout during extraction
    import io
    _real_stdout = sys.stdout
    sys.stdout = io.StringIO()
    result = extract(files, cache_root=_cache_dir)
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

    # God nodes: graphifyy@0.5.0 renamed the result key "edges" → "degree".
    gods = god_nodes(G, top_n=50)
    god_count = sum(1 for g in gods if g["degree"] > 15)

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


    # ── Build the full graph artifact ────────────────────────────────────────────
    # 2.7 Sprint 1: emit nodes / edges / communities / symbolIndex alongside
    # the aggregate metrics. Consumers (explore CLI, dashboard viz, future
    # 2.8 context CLI + reachability) read this via src/explore/load.ts.
    # Schema contract documented in tmp/2.7-graph-json-schema.md.

    # Determine class membership: a module-shaped node is a CLASS if it has
    # outbound 'method' edges to other nodes (it's the owner). A function-
    # shaped node ("()" in label) is a METHOD if it has inbound 'method'
    # edges from a class node; otherwise it's a free FUNCTION.
    _class_owners = set()
    _method_members = set()
    for u, v, data in G.edges(data=True):
        if data.get("relation") == "method":
            _class_owners.add(u)
            _method_members.add(v)

    def _node_kind(nid, attrs):
        label = attrs.get('label', '')
        is_callable = '()' in label
        if is_callable:
            return 'method' if nid in _method_members else 'function'
        return 'class' if nid in _class_owners else 'module'

    # Make node sourceFile paths project-relative (graphify emits absolute
    # paths derived from \`target = sys.argv[1]\`). Mirrors the existing
    # maxFunctionsFilePath path-normalization at the TS layer.
    def _rel(p):
        if not p:
            return ''
        s = str(p).replace(os.sep, '/')
        t = str(target).replace(os.sep, '/').rstrip('/')
        if s.startswith(t + '/'):
            return s[len(t) + 1:]
        if s == t:
            return ''
        return s

    # Assign stable in-run ids: n0, n1, n2, ... in extraction order. The
    # graphify-internal id strings (long underscored slugs) work but bloat
    # the JSON by ~20 bytes per node; the n<idx> shortening saves ~50KB on
    # a 13k-node repo. IDs are NOT stable across runs (per schema doc).
    _id_remap = {}
    graph_nodes = []
    for idx, (nid, attrs) in enumerate(nodes):
        short_id = f'n{idx}'
        _id_remap[nid] = short_id
        line_no = _parse_line_no(attrs)
        rel_source = _rel(attrs.get('source_file', ''))
        label = attrs.get('label', '')
        name = _strip_paren_suffix(label)
        kind = _node_kind(nid, attrs)
        node_obj = {
            'id': short_id,
            'kind': kind,
            'label': label,
            'sourceFile': rel_source,
        }
        if line_no:
            node_obj['line'] = line_no
        # Export detection only meaningful for symbol-bearing kinds
        # (functions, classes, methods). Module-level "is this file
        # exported?" isn't a useful question — exclude.
        if kind in ('function', 'class', 'method'):
            # Resolve to absolute path for the file-line cache (we read
            # the raw source content; the cache key is the actual path
            # on disk, not the project-relative form).
            abs_source = attrs.get('source_file', '')
            exported = _detect_exported(abs_source, line_no, name)
            if exported is not None:
                node_obj['exported'] = exported
        graph_nodes.append(node_obj)

    # Edges remapped to short ids. Drop self-loops and edges where either
    # endpoint was filtered out (defensive — graphify shouldn't produce them
    # but be tolerant). Graphify emits both 'imports' (broad form: \`import X\`)
    # and 'imports_from' (\`from X import Y\` / \`import {Y} from X\`); both
    # carry the same semantic for our schema ("A imports from B"). Merge
    # both into the canonical 'imports_from' edge relation. The 'contains'
    # and 'inherits' relations graphify also produces are intentionally
    # dropped — 'contains' duplicates the file/symbol-membership info
    # already encoded in nodes' sourceFile field, and 'inherits' is
    # class-inheritance which isn't yet a first-class schema relation.
    graph_edges = []
    for u, v, data in G.edges(data=True):
        if u not in _id_remap or v not in _id_remap:
            continue
        graphify_relation = data.get('relation', '')
        if graphify_relation == 'calls':
            relation = 'calls'
        elif graphify_relation in ('imports', 'imports_from'):
            relation = 'imports_from'
        elif graphify_relation == 'method':
            relation = 'method'
        else:
            continue
        edge_obj = {
            'from': _id_remap[u],
            'to': _id_remap[v],
            'relation': relation,
        }
        graph_edges.append(edge_obj)

    # Communities: for each cluster compute dominantSourceDir + dominantPack.
    # dominantSourceDir = most common ancestor directory (the longest
    # leading-segment path that >= 40% of members share); empty string when
    # no clear dominant. dominantPack = most common pack id among member
    # files' extensions; empty when no dominant pack.
    def _ancestor_dir(rel_path):
        if not rel_path or '/' not in rel_path:
            return ''
        return rel_path.rsplit('/', 1)[0] + '/'

    graph_communities = []
    # Graphify's cluster() returns dict[community_id: list[node_id]].
    # Iterate via .items(); the community_id is the actual cluster
    # identifier (used to look up cohesion in scores), members is the
    # node-id list.
    _node_attrs_by_id = dict(nodes)
    for cidx, member_list in communities.items():
        member_ids = sorted(_id_remap.get(n, '') for n in member_list if n in _id_remap)
        member_ids = [m for m in member_ids if m]
        if not member_ids:
            continue
        # Per-member source files (project-relative)
        member_files = []
        for nid in member_list:
            if nid in _id_remap:
                sf = _rel(_node_attrs_by_id.get(nid, {}).get('source_file', ''))
                if sf:
                    member_files.append(sf)
        # Dominant directory: longest common ancestor that >= 40% of
        # members share (or empty if no clear winner).
        dir_counter = Counter(_ancestor_dir(f) for f in member_files)
        dir_counter.pop('', None)
        dominant_dir = ''
        if dir_counter:
            top_dir, top_count = dir_counter.most_common(1)[0]
            if top_count / len(member_files) >= 0.4:
                dominant_dir = top_dir
        # Dominant pack
        pack_counter = Counter()
        for f in member_files:
            pk = _EXT_TO_PACK.get(_ext_of(f))
            if pk:
                pack_counter[pk] += 1
        dominant_pack = ''
        if pack_counter:
            top_pack, top_pack_count = pack_counter.most_common(1)[0]
            if top_pack_count / max(1, len(member_files)) >= 0.5:
                dominant_pack = top_pack
        cohesion = float(scores.get(cidx, 0.0)) if scores else 0.0
        graph_communities.append({
            'id': cidx,
            'nodeIds': member_ids,
            'cohesion': round(cohesion, 3),
            'dominantSourceDir': dominant_dir,
            'dominantPack': dominant_pack,
        })

    # Symbol index: lowercased label (without trailing ()) → list of nodeIds.
    _symbol_index = {}
    for node_obj in graph_nodes:
        key = _strip_paren_suffix(node_obj['label']).lower()
        if not key:
            continue
        _symbol_index.setdefault(key, []).append(node_obj['id'])

    # Active-pack detection: derive from extensions seen in source files.
    _packs_seen = sorted({_EXT_TO_PACK[e] for e in (_ext_of(_rel(d.get('source_file', '')))
                                                      for _, d in nodes)
                           if e in _EXT_TO_PACK})

    # Size-budget enforcement. Hard cap 50MB serialized. If we exceed,
    # drop method edges first (densest class — structural noise, doesn't
    # affect call-graph queries).
    import datetime as _dt
    _meta = {
        'tool': 'graphify',
        'graphifyVersion': '',  # filled by TS-side post-parse (read from graphifyy package version)
        'dxkitVersion': '',     # filled by TS-side post-parse (read from package.json)
        'generatedAt': _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sourceFilesInGraph': total_src,
        'excludedFileCount': len(all_files) - len(files),
        'packs': _packs_seen,
        'truncated': False,
        'truncatedReason': '',
    }

    _graph_payload = {
        'schemaVersion': 1,
        'meta': _meta,
        'nodes': graph_nodes,
        'edges': graph_edges,
        'communities': graph_communities,
        'symbolIndex': _symbol_index,
    }

    # Cheap pre-check on size: serialize once, measure, drop method edges
    # if over the cap, re-serialize. The 50MB cap matches the schema
    # contract; 10MB soft target is informational only (no enforcement).
    _BYTES_HARD_CAP = 50 * 1024 * 1024

    def _serialize(payload):
        return json.dumps(payload, separators=(',', ':'))

    _graph_json = _serialize(_graph_payload)
    if len(_graph_json.encode('utf-8')) > _BYTES_HARD_CAP:
        # Drop method edges first; they're structural (class-owns-method),
        # not behavioral. Call + import edges carry the actionable info.
        pre_count = len(_graph_payload['edges'])
        _graph_payload['edges'] = [e for e in _graph_payload['edges']
                                   if e['relation'] != 'method']
        post_count = len(_graph_payload['edges'])
        _meta['truncated'] = True
        _meta['truncatedReason'] = (
            f"dropped {pre_count - post_count} method edges to fit under "
            f"the 50MB hard cap"
        )

    # Render the interactive viewer alongside graph.json so the dashboard
    # Graph tab can embed it. graphify ships its own vis.js-based renderer
    # (graphify.export.to_html). Two emission paths:
    #
    #   - Full graph (G.number_of_nodes() <= MAX_NODES_FOR_VIZ = 5000):
    #     pass the original G + communities. The viewer renders every
    #     symbol; the user can zoom + drill.
    #
    #   - Aggregated community view (G > MAX_NODES_FOR_VIZ): build a
    #     networkx super-graph whose nodes ARE the communities. Sized by
    #     member count via graphify member_counts parameter. Inter-
    #     community edges aggregated to weighted edges. This lets a
    #     customer-scale repo still get a meaningful "what does this
    #     codebase look like" viz instead of a dead empty-state.
    #
    # Either way failures are non-fatal: the dashboard surfaces a clear
    # empty-state when graph.html isn't on disk.
    try:
        from graphify.export import to_html as _to_html, MAX_NODES_FOR_VIZ as _MAX_VIZ
        import networkx as _nx
        _html_dir = target / '.dxkit' / 'reports'
        _html_dir.mkdir(parents=True, exist_ok=True)
        _html_path = _html_dir / 'graph.html'

        if G.number_of_nodes() <= _MAX_VIZ:
            _labels = {
                c['id']: (c.get('dominantSourceDir') or f"community-{c['id']}")
                for c in graph_communities
            }
            _to_html(G, communities, str(_html_path), community_labels=_labels)
            _viz_mode = 'full'
        else:
            # Aggregated community super-graph.
            _node_to_comm = {}
            for _cid, _members in communities.items():
                for _nid in _members:
                    _node_to_comm[_nid] = _cid

            _G_agg = _nx.DiGraph()
            _member_counts = {}
            _labels = {}
            for _c in graph_communities:
                _cid = _c['id']
                _label = _c.get('dominantSourceDir') or f"community-{_cid}"
                # vis.js node attrs: label drives display; file_type is
                # surfaced in graphify's sidebar so we set a sentinel
                # value the dashboard can grep on.
                _G_agg.add_node(_cid, label=_label, source_file='', file_type='community')
                _member_counts[_cid] = len(_c['nodeIds'])
                _labels[_cid] = _label

            # Cross-community edge aggregation. Counter keyed on
            # (smaller_id, larger_id) for undirected aggregation; we then
            # add a directed edge in one canonical direction so vis.js
            # has a definite source/target. The viewer doesn't show
            # arrows on these (they're community connections, not calls).
            from collections import Counter as _CommCounter
            _edge_w = _CommCounter()
            for _u, _v, _ in G.edges(data=True):
                _cu = _node_to_comm.get(_u)
                _cv = _node_to_comm.get(_v)
                if _cu is None or _cv is None or _cu == _cv:
                    continue
                _key = (_cu, _cv) if _cu < _cv else (_cv, _cu)
                _edge_w[_key] += 1
            for (_a, _b), _w in _edge_w.items():
                _G_agg.add_edge(_a, _b, relation='inter_community', occurrences=_w)

            # to_html requires a communities dict; one-element groups
            # treat each aggregated node as its own community so each
            # community keeps a distinct color in graphify's palette.
            _agg_groups = {_cid: [_cid] for _cid in communities}

            _to_html(
                _G_agg, _agg_groups, str(_html_path),
                community_labels=_labels, member_counts=_member_counts,
            )
            _viz_mode = 'aggregated'

        # Sidecar so the dashboard renderer can label the view honestly.
        # JSON is tiny (~120B); avoids parsing graph.json twice from TS.
        _meta_path = _html_dir / 'graph.html.meta.json'
        _meta_path.write_text(json.dumps({
            'mode': _viz_mode,
            'totalNodes': G.number_of_nodes(),
            'totalEdges': G.number_of_edges(),
            'communities': len(communities),
            'aggregatedNodeCount': len(communities) if _viz_mode == 'aggregated' else None,
        }))
    except Exception as _html_err:
        sys.stderr.write(f"dxkit: graph.html not generated ({_html_err})\\n")

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
        "graph": _graph_payload,
    }))
`;
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
 * outcomes are populated from a single Python invocation; consumers
 * pick the slice they need.
 */
export type GraphGatherOutcome =
  | { kind: 'success'; graph: GraphJson }
  | { kind: 'unavailable'; reason: string };

/**
 * Per-cwd memoization. Graphify is the heaviest external tool dxkit
 * shells out to (~10-60s depending on repo size); the two outcomes
 * share one Python invocation, populated atomically via the run
 * promise cache below.
 *
 * Module-scoped, no automatic invalidation, safe for the one-shot
 * CLI shape (same constraints as the gitleaks cache).
 */
const aggregatesCache = new Map<string, StructuralGatherOutcome>();
const graphCache = new Map<string, GraphGatherOutcome>();

/**
 * Run-coalescing promise cache. Concurrent callers (e.g. the parallel
 * capability dispatcher AND a CLI subcommand both kicking off graphify
 * gather) share a single in-flight Python invocation instead of racing
 * to start their own. Without this, on first-access the cache check
 * returns empty for both callers, both fire the Python subprocess,
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
 * roundtrip, and by future 2.8 context-CLI + reachability gathers.
 *
 * Shares one Python invocation with `gatherGraphifyResult` per the
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

async function computeAndCache(cwd: string): Promise<void> {
  const pythonCmd = findPython(cwd);
  if (!pythonCmd) {
    const reason = 'not installed';
    aggregatesCache.set(cwd, { kind: 'unavailable', reason });
    graphCache.set(cwd, { kind: 'unavailable', reason });
    return;
  }

  // Per-run tempdir via mkdtempSync — unique random suffix eliminates
  // the `Date.now()` collision risk when two dxkit processes fire
  // within the same millisecond. The whole dir is rm'd on exit so we
  // don't litter /tmp across runs.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-graphify-'));
  const scriptPath = path.join(scriptDir, 'run.py');
  // graphify's on-disk AST cache is redirected here (passed to the script
  // as argv[2] → extract(cache_root=...)), keeping it out of the target
  // repo. It lives under scriptDir so the single `fs.rmSync(scriptDir)`
  // below reclaims it — crucially AFTER the Python process and its atexit
  // handlers exit. graphify flushes a stat-index via atexit
  // (graphify/cache.py), so cleaning the cache from inside the script
  // would be undone by that post-exit write; owning the lifecycle here is
  // the only leak-free point.
  const cacheDir = path.join(scriptDir, 'graphify-cache');
  fs.writeFileSync(scriptPath, buildGraphifyScript(cwd));
  // Spawn-with-process-group so the Python interpreter + any
  // tree-sitter worker subprocesses it starts are all killed
  // atomically on timeout. Pre-fix execSync sent SIGTERM only to
  // the immediate Python child; tree-sitter workers spawned by
  // the script could be orphaned mid-write, which on a large
  // codebase (thousands of .cs files) sometimes left the run
  // looking "no stderr captured" because the process group went
  // away before flushing to the stderr tempfile.
  //
  // runDetached captures stderr natively so the tempfile redirect
  // pattern is no longer needed — same effect, fewer moving parts.
  const outcome = await runDetached(pythonCmd, [scriptPath, cwd, cacheDir], {
    cwd: scriptDir,
    timeoutMs: 300000, // 5 min — bumped from 120000 in 2.4.7 for multi-thousand-file frontend repos
  });
  try {
    fs.rmSync(scriptDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const output = outcome.stdout;
  const stderrCapture = outcome.stderr.trim();

  if (!output) {
    let reason: string;
    if (outcome.timedOut) {
      reason = 'timed out at 300s (try narrowing scan scope via .dxkit-ignore)';
    } else {
      // Surface the first meaningful stderr line so the customer can
      // see what broke (tree-sitter parse error, Python ImportError,
      // OOM kill, etc.). Truncate aggressively — toolsUnavailable[]
      // entries shouldn't carry multi-line tracebacks.
      const firstStderrLine = stderrCapture
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim();
      reason = firstStderrLine
        ? `failed: ${firstStderrLine.length > 200 ? firstStderrLine.slice(0, 197) + '...' : firstStderrLine}`
        : outcome.code !== 0 && outcome.code !== null
          ? `failed with exit code ${outcome.code} (no stderr captured — likely killed by the OS, e.g. OOM)`
          : 'failed to run (no stderr captured)';
    }
    aggregatesCache.set(cwd, { kind: 'unavailable', reason });
    graphCache.set(cwd, { kind: 'unavailable', reason });
    return;
  }

  // Graphify prints progress to stdout before the JSON — extract only the JSON line.
  const jsonLine = output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!jsonLine) {
    const reason = 'no JSON output';
    aggregatesCache.set(cwd, { kind: 'unavailable', reason });
    graphCache.set(cwd, { kind: 'unavailable', reason });
    return;
  }

  let data: GraphifyResult & { error?: string };
  try {
    data = JSON.parse(jsonLine) as GraphifyResult & { error?: string };
  } catch {
    const reason = 'parse error';
    aggregatesCache.set(cwd, { kind: 'unavailable', reason });
    graphCache.set(cwd, { kind: 'unavailable', reason });
    return;
  }
  if (data.error) {
    const reason = data.error;
    aggregatesCache.set(cwd, { kind: 'unavailable', reason });
    graphCache.set(cwd, { kind: 'unavailable', reason });
    return;
  }

  // Populate the aggregates cache (existing behavior).
  aggregatesCache.set(cwd, { kind: 'success', envelope: buildGraphifyEnvelope(data, cwd) });

  // Populate the graph cache. Backfill the dxkitVersion in meta;
  // graphifyVersion left empty in v1 (Python-side version probe
  // declined to keep the script self-contained). Consumers tolerate
  // empty version strings.
  if (data.graph) {
    const dxkitVersion = readDxkitVersion();
    const enrichedGraph: GraphJson = {
      ...data.graph,
      meta: {
        ...data.graph.meta,
        dxkitVersion,
      },
    };
    graphCache.set(cwd, { kind: 'success', graph: enrichedGraph });
  } else {
    // Aggregates parsed but graph field missing — old script output
    // or a malformed JSON. Surface as graph-unavailable so the
    // existing aggregates path keeps working.
    graphCache.set(cwd, {
      kind: 'unavailable',
      reason: 'graph field missing from script output (older script?)',
    });
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
 * Pure JSON-to-envelope reshape so the normalization contract is
 * unit-testable without shelling out to Python.
 *
 * The Python helper emits `maxFunctionsFilePath` as an absolute path
 * (`str(Path(...))` on a value derived from `target = sys.argv[1]`).
 * Renderers downstream emit this field verbatim into customer-facing
 * markdown, so it has to be project-relative before it leaves the
 * gather layer — mirrors the gitleaks / semgrep / grep-secrets pattern
 * where each tool wrapper owns its own path normalization.
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
