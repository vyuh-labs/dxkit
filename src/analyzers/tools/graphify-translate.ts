/**
 * graphify 0.9.x wire format → dxkit GraphJson v1 translation.
 *
 * The 4.2 driver rewrite replaced the embedded Python script (which
 * imported graphify as a library and serialized our dialect in-process)
 * with graphify's own CLI (`extract --code-only`) plus this pure
 * translator. Everything the Python computed lives here now, in
 * unit-testable TypeScript:
 *
 *   - code-graph scoping: Rule 4 exclusions (`isExcludedPath`),
 *     pack-declared source-extension allowlist, minified-file filter,
 *     non-code node classes (docs / concepts / manifest-derived nodes)
 *     dropped;
 *   - node kinds derived from graphify's `method` edges (callable with
 *     an inbound method edge = method, else function; container with
 *     outbound method edges = class, else module);
 *   - `exported` via each pack's `exportDetection.lineCheck` (Rule 6 —
 *     the per-language branches the Python carried are pack-declared);
 *   - communities regrouped from graphify's per-node `community` field,
 *     with cohesion (intra-edge fraction), dominantSourceDir (≥40%),
 *     dominantPack (≥50%);
 *   - the aggregate metrics envelope (function/class counts, god nodes,
 *     orphan modules, dead imports, commented-code ratio);
 *   - the 50MB hard cap (method edges dropped first).
 *
 * Node ids are graphify's own — path-based and deterministic since
 * their 0.9.0 — so graph.json node identity is now stable across runs
 * (the R1 property the old per-run `n<idx>` ids lacked). Ids remain an
 * intra-artifact concern: nothing dxkit persists outside graph.json may
 * reference them (Vyuh-facing keys are minted by dxkit from
 * file + qualified name + kind, never copied from a producer).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LanguageId } from '../../types';
import type {
  Community,
  GraphEdge,
  GraphJson,
  GraphNode,
  GraphNodeKind,
} from '../../explore/types';
import { extensionToPackMap, getLanguage } from '../../languages';
import { isExcludedPath } from './exclusions';
import { isLikelyMinified } from './minified-detection';

/** Loose shape of a graphify 0.9.x node — only the fields we read. */
interface RawNode {
  id?: unknown;
  label?: unknown;
  file_type?: unknown;
  source_file?: unknown;
  source_location?: unknown;
  community?: unknown;
}

interface RawEdge {
  source?: unknown;
  target?: unknown;
  relation?: unknown;
}

export interface TranslateOutcome {
  graph: GraphJson;
  metrics: {
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
  };
}

const BYTES_HARD_CAP = 50 * 1024 * 1024;

/** Dependency manifests whose parsed entries graphify surfaces as nodes —
 *  metadata for its use cases, noise for a code graph. */
const MANIFEST_SOURCE_RE =
  /(^|\/)(package\.json|package-lock\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile|[^/]*\.csproj|apm\.yml)$/;

const FILE_LABEL_RE = /\.[a-z0-9]{1,5}$/i;

function extOf(sourceFile: string): string {
  const i = sourceFile.lastIndexOf('.');
  return i >= 0 ? sourceFile.slice(i).toLowerCase() : '';
}

function parseLineNo(loc: unknown): number {
  if (typeof loc === 'number' && Number.isFinite(loc)) return loc;
  const m = /^L?(\d+)/.exec(String(loc ?? ''));
  return m ? Number(m[1]) : 0;
}

/** `createUser()` → `createUser`; `UserRepository.findById()` → `findById`. */
function stripParenSuffix(label: string): string {
  if (!label) return '';
  let s = label.replace(/\($/, '').replace(/\(\)$/, '');
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  return s;
}

/** Relativize a graphify source path against the extraction target. Their
 *  0.9.x output is repo-relative already; tolerate absolute for safety. */
function relSource(sourceFile: string, cwd: string): string {
  const s = sourceFile.replace(/\\/g, '/');
  const t = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (s.startsWith(t + '/')) return s.slice(t.length + 1);
  if (s === t) return '';
  return s.replace(/^\.\//, '');
}

/**
 * Is this node one of graphify's FILE nodes (vs a symbol)? Their label
 * shapes: bare basename ("routes.py"), path-qualified disambiguated
 * basename ("main/routes.py"), and "<name> script" for extensionless
 * shebang executables.
 */
function isFileNode(label: string, rel: string): boolean {
  if (FILE_LABEL_RE.test(label) && rel) {
    if (path.posix.basename(rel) === label || rel.endsWith(label)) return true;
  }
  return label.endsWith(' script') && path.posix.basename(rel) === label.slice(0, -7);
}

/** Per-run source-line cache for export detection. */
function makeLineReader(cwd: string) {
  const cache = new Map<string, string[] | null>();
  return (rel: string, lineNo: number): string => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, fs.readFileSync(path.join(cwd, rel), 'utf-8').split('\n'));
      } catch {
        cache.set(rel, null);
      }
    }
    const lines = cache.get(rel);
    if (!lines || lineNo < 1 || lineNo > lines.length) return '';
    return lines[lineNo - 1].replace(/\r$/, '');
  };
}

/**
 * Translate a parsed graphify graph.json (0.9.x dialect) into the dxkit
 * GraphJson v1 payload + aggregate metrics. Pure aside from reading
 * source files under `cwd` for export detection and the minified check.
 */
export function translateGraphifyGraph(
  raw: unknown,
  cwd: string,
  opts: { graphifyVersion: string; dxkitVersion: string },
): TranslateOutcome {
  const rawObj = (raw ?? {}) as { nodes?: unknown; links?: unknown; edges?: unknown };
  const rawNodes = (Array.isArray(rawObj.nodes) ? rawObj.nodes : []) as RawNode[];
  const rawEdges = (
    Array.isArray(rawObj.links) ? rawObj.links : Array.isArray(rawObj.edges) ? rawObj.edges : []
  ) as RawEdge[];

  const extToPack = extensionToPackMap();
  const sourceExts = new Set([...extToPack.keys()]);
  const readLine = makeLineReader(cwd);
  const minifiedCache = new Map<string, boolean>();
  const isMinified = (rel: string): boolean => {
    if (!minifiedCache.has(rel)) {
      let v = false;
      try {
        v = isLikelyMinified(path.join(cwd, rel));
      } catch {
        v = false;
      }
      minifiedCache.set(rel, v);
    }
    return minifiedCache.get(rel)!;
  };

  // ── Pass 1: admit nodes into the code graph ──────────────────────────
  interface Admitted {
    id: string;
    label: string;
    rel: string;
    line: number;
    community: number | null;
    fileNode: boolean;
  }
  const admitted = new Map<string, Admitted>();
  const excludedFiles = new Set<string>();
  for (const n of rawNodes) {
    const id = typeof n.id === 'string' ? n.id : String(n.id ?? '');
    if (!id) continue;
    if ((n.file_type ?? 'code') !== 'code') continue;
    const srcRaw = typeof n.source_file === 'string' ? n.source_file : '';
    if (!srcRaw) continue; // external stubs / synthetic nodes
    const rel = relSource(srcRaw, cwd);
    if (!rel || MANIFEST_SOURCE_RE.test(rel)) continue;
    if (!sourceExts.has(extOf(rel))) continue;
    if (isExcludedPath(cwd, rel)) {
      excludedFiles.add(rel);
      continue;
    }
    if (isMinified(rel)) {
      excludedFiles.add(rel);
      continue;
    }
    const label = String(n.label ?? '');
    admitted.set(id, {
      id,
      label,
      rel,
      line: parseLineNo(n.source_location),
      community: typeof n.community === 'number' ? n.community : null,
      fileNode: isFileNode(label, rel),
    });
  }

  // ── Pass 2: relation-mapped edges between admitted nodes ─────────────
  const methodOwners = new Set<string>();
  const methodMembers = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const from = typeof e.source === 'string' ? e.source : String(e.source ?? '');
    const to = typeof e.target === 'string' ? e.target : String(e.target ?? '');
    if (!admitted.has(from) || !admitted.has(to) || from === to) continue;
    const rawRel = String(e.relation ?? '');
    let relation: GraphEdge['relation'];
    if (rawRel === 'calls') relation = 'calls';
    else if (rawRel === 'imports' || rawRel === 'imports_from') relation = 'imports_from';
    else if (rawRel === 'method') relation = 'method';
    else continue; // contains / references / inherits / indirect_call / …
    if (relation === 'method') {
      methodOwners.add(from);
      methodMembers.add(to);
    }
    edges.push({ from, to, relation });
  }

  // ── Pass 3: typed nodes with export detection ────────────────────────
  const nodes: GraphNode[] = [];
  const kindById = new Map<string, GraphNodeKind>();
  for (const a of admitted.values()) {
    const callable = a.label.includes('()');
    const kind: GraphNodeKind = callable
      ? methodMembers.has(a.id)
        ? 'method'
        : 'function'
      : !a.fileNode && methodOwners.has(a.id)
        ? 'class'
        : 'module';
    kindById.set(a.id, kind);
    const node: {
      id: string;
      kind: GraphNodeKind;
      label: string;
      sourceFile: string;
      line?: number;
      exported?: boolean;
    } = { id: a.id, kind, label: a.label, sourceFile: a.rel };
    if (a.line) node.line = a.line;
    if (kind !== 'module') {
      const packId = extToPack.get(extOf(a.rel));
      const detection = packId ? getLanguage(packId)?.exportDetection : undefined;
      if (detection && detection.reliability !== 'unreliable' && detection.lineCheck) {
        const line = a.line ? readLine(a.rel, a.line) : '';
        const exported = detection.lineCheck(line, stripParenSuffix(a.label));
        if (exported !== null) node.exported = exported;
      }
    }
    nodes.push(node);
  }

  // ── Communities (regrouped from graphify's per-node assignment) ──────
  const byCommunity = new Map<number, Admitted[]>();
  for (const a of admitted.values()) {
    if (a.community === null) continue;
    let list = byCommunity.get(a.community);
    if (!list) byCommunity.set(a.community, (list = []));
    list.push(a);
  }
  const communityOf = new Map<string, number>();
  for (const [cid, members] of byCommunity) for (const m of members) communityOf.set(m.id, cid);
  const intra = new Map<number, number>();
  const touching = new Map<number, number>();
  for (const e of edges) {
    const cf = communityOf.get(e.from);
    const ct = communityOf.get(e.to);
    for (const c of new Set([cf, ct])) {
      if (c === undefined) continue;
      touching.set(c, (touching.get(c) ?? 0) + 1);
    }
    if (cf !== undefined && cf === ct) intra.set(cf, (intra.get(cf) ?? 0) + 1);
  }
  const communities: Community[] = [];
  for (const [cid, members] of [...byCommunity.entries()].sort((a, b) => a[0] - b[0])) {
    const nodeIds = members.map((m) => m.id).sort();
    const files = members.map((m) => m.rel).filter(Boolean);
    const dirCounter = new Map<string, number>();
    for (const f of files) {
      if (!f.includes('/')) continue;
      const dir = f.slice(0, f.lastIndexOf('/') + 1);
      dirCounter.set(dir, (dirCounter.get(dir) ?? 0) + 1);
    }
    let dominantSourceDir = '';
    const topDir = [...dirCounter.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDir && files.length > 0 && topDir[1] / files.length >= 0.4)
      dominantSourceDir = topDir[0];
    const packCounter = new Map<LanguageId, number>();
    for (const f of files) {
      const pk = extToPack.get(extOf(f));
      if (pk) packCounter.set(pk, (packCounter.get(pk) ?? 0) + 1);
    }
    let dominantPack = '';
    const topPack = [...packCounter.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPack && topPack[1] / Math.max(1, files.length) >= 0.5) dominantPack = topPack[0];
    const t = touching.get(cid) ?? 0;
    const cohesion = t > 0 ? (intra.get(cid) ?? 0) / t : 0;
    communities.push({
      id: cid,
      nodeIds,
      cohesion: Math.round(cohesion * 1000) / 1000,
      dominantSourceDir,
      dominantPack,
    });
  }

  // ── Symbol index ─────────────────────────────────────────────────────
  // Built via Map, not a plain object literal: symbol names like
  // `constructor` / `toString` collide with Object.prototype properties,
  // where `??=` reads the inherited function and never assigns.
  const symbolIndexMap = new Map<string, string[]>();
  for (const node of nodes) {
    const key = stripParenSuffix(node.label).toLowerCase();
    if (!key) continue;
    let list = symbolIndexMap.get(key);
    if (!list) symbolIndexMap.set(key, (list = []));
    list.push(node.id);
  }
  const symbolIndex = Object.fromEntries(symbolIndexMap);

  // ── Aggregate metrics (ported formulas) ──────────────────────────────
  const callables = nodes.filter((n) => n.kind === 'function' || n.kind === 'method');
  const classes = nodes.filter((n) => n.kind === 'class');
  const moduleIds = new Set(nodes.filter((n) => n.kind === 'module').map((n) => n.id));
  const perFile = new Map<string, number>();
  for (const n of callables) {
    if (n.sourceFile) perFile.set(n.sourceFile, (perFile.get(n.sourceFile) ?? 0) + 1);
  }
  const maxEntry = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0];
  const degree = new Map<string, number>();
  const importTargets = new Set<string>();
  const callTargets = new Set<string>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (e.relation === 'imports_from') importTargets.add(e.to);
    if (e.relation === 'calls') callTargets.add(e.to);
  }
  const godNodeCount = Math.min(50, [...degree.values()].filter((d) => d > 15).length);
  const orphanModuleCount = [...moduleIds].filter((id) => !importTargets.has(id)).length;
  const deadImportCount = [...importTargets].filter(
    (id) => !callTargets.has(id) && !moduleIds.has(id),
  ).length;
  const allFiles = new Set(nodes.map((n) => n.sourceFile).filter(Boolean));
  const filesWithCallables = new Set(callables.map((n) => n.sourceFile).filter(Boolean));
  for (const n of nodes) {
    if (n.kind === 'class' && n.sourceFile) filesWithCallables.add(n.sourceFile);
  }
  const commentedRatio =
    allFiles.size > 0 ? (allFiles.size - filesWithCallables.size) / allFiles.size : 0;
  const avgCohesion =
    communities.length > 0
      ? communities.reduce((s, c) => s + c.cohesion, 0) / communities.length
      : 0;

  // ── Assemble + size cap ──────────────────────────────────────────────
  const meta = {
    tool: 'graphify' as const,
    graphifyVersion: opts.graphifyVersion,
    dxkitVersion: opts.dxkitVersion,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sourceFilesInGraph: allFiles.size,
    excludedFileCount: excludedFiles.size,
    packs: [
      ...new Set(
        [...allFiles].flatMap((f) => {
          const pk = extToPack.get(extOf(f));
          return pk ? [pk] : [];
        }),
      ),
    ].sort() as LanguageId[],
    truncated: false,
    truncatedReason: '',
  };
  let graph: GraphJson = {
    schemaVersion: 1,
    meta,
    nodes,
    edges,
    communities,
    symbolIndex,
    endpoints: [],
  };
  if (Buffer.byteLength(JSON.stringify(graph), 'utf-8') > BYTES_HARD_CAP) {
    const kept = edges.filter((e) => e.relation !== 'method');
    graph = {
      ...graph,
      edges: kept,
      meta: {
        ...meta,
        truncated: true,
        truncatedReason: `dropped ${edges.length - kept.length} method edges to fit under the 50MB hard cap`,
      },
    };
  }

  return {
    graph,
    metrics: {
      functionCount: callables.length,
      classCount: classes.length,
      maxFunctionsInFile: maxEntry ? maxEntry[1] : 0,
      maxFunctionsFilePath: maxEntry ? maxEntry[0] : '',
      godNodeCount,
      communityCount: communities.length,
      avgCohesion: Math.round(avgCohesion * 1000) / 1000,
      orphanModuleCount,
      deadImportCount,
      commentedCodeRatio: Math.round(commentedRatio * 1000) / 1000,
      sourceFilesInGraph: allFiles.size,
    },
  };
}
