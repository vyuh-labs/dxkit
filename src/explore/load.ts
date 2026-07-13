/**
 * Canonical graph loader. Per CLAUDE.md Rule 12, every consumer of
 * `.dxkit/reports/graph.json` reads via `loadGraph(cwd)` — never
 * `JSON.parse` directly. Arch-check enforces; this is the only file
 * that may parse the artifact.
 *
 * Throws typed errors so callers can react precisely:
 *   - GraphNotFoundError      → file doesn't exist (suggest --refresh)
 *   - GraphSchemaVersionError → wire-format newer than the loader knows
 *   - GraphCorruptError       → missing/malformed required field
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { gatherGraphifyGraph } from '../analyzers/tools/graphify';
import {
  GRAPH_REPORT_PATH,
  GRAPH_SCHEMA_VERSION,
  type Community,
  type Graph,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
  type HttpEndpointNode,
} from './types';

// Re-export for backwards-compat with consumers that import the path
// constant from the loader module.
export { GRAPH_REPORT_PATH };

export class GraphNotFoundError extends Error {
  constructor(public readonly absPath: string) {
    super(
      `No graph.json at ${absPath}. Run \`vyuh-dxkit health\` or pass \`--refresh\` to regenerate.`,
    );
    this.name = 'GraphNotFoundError';
  }
}

export class GraphSchemaVersionError extends Error {
  constructor(
    public readonly absPath: string,
    public readonly found: unknown,
    public readonly expected: number,
  ) {
    super(
      `graph.json at ${absPath} declares schemaVersion=${String(found)}; this dxkit reads schemaVersion=${expected}. Upgrade dxkit (\`npm install -g @vyuhlabs/dxkit@latest\`) to read newer artifacts.`,
    );
    this.name = 'GraphSchemaVersionError';
  }
}

export class GraphCorruptError extends Error {
  constructor(
    public readonly absPath: string,
    public readonly detail: string,
  ) {
    super(`graph.json at ${absPath} is malformed: ${detail}. Regenerate with \`--refresh\`.`);
    this.name = 'GraphCorruptError';
  }
}

/**
 * Read + validate + index the graph artifact. The returned `Graph`
 * carries convenience indices (`nodeById`, `edgesFromNode`, ...)
 * built once at load time; queries in `./queries.ts` read from these
 * maps for O(1) traversal rather than repeatedly scanning the arrays.
 *
 * Validation is intentionally lightweight — top-level shape + required
 * fields per node/edge. Deep schema validation (every optional field's
 * types, referential integrity of every edge endpoint) would catch
 * more but cost more on every load; instead we trust the producer and
 * surface unexpected shapes as runtime errors at the query layer.
 */
export function loadGraph(cwd: string): Graph {
  const absPath = path.join(cwd, GRAPH_REPORT_PATH);
  if (!fs.existsSync(absPath)) {
    throw new GraphNotFoundError(absPath);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err) {
    throw new GraphCorruptError(absPath, err instanceof Error ? err.message : 'JSON parse failed');
  }
  const json = validateAndUpgrade(absPath, raw);
  return indexGraph(json);
}

/**
 * Fail-open variant of {@link loadGraph}: returns undefined on ANY
 * error (missing file, parse failure, schema mismatch) instead of
 * throwing. For additive, never-block consumers — the PreToolUse
 * context hook and the finding-enrichment pass — where a missing or
 * stale graph must degrade to "no context", never an error.
 */
export function tryLoadGraph(cwd: string): Graph | undefined {
  try {
    return loadGraph(cwd);
  } catch {
    return undefined;
  }
}

function validateAndUpgrade(absPath: string, raw: unknown): GraphJson {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GraphCorruptError(absPath, 'top-level value is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.schemaVersion;
  if (typeof v !== 'number') {
    throw new GraphCorruptError(absPath, 'schemaVersion is missing or not a number');
  }
  if (v > GRAPH_SCHEMA_VERSION) {
    throw new GraphSchemaVersionError(absPath, v, GRAPH_SCHEMA_VERSION);
  }

  for (const key of ['meta', 'nodes', 'edges', 'communities', 'symbolIndex']) {
    if (!(key in obj)) {
      throw new GraphCorruptError(absPath, `missing required top-level field "${key}"`);
    }
  }
  if (!Array.isArray(obj.nodes)) {
    throw new GraphCorruptError(absPath, '"nodes" is not an array');
  }
  if (!Array.isArray(obj.edges)) {
    throw new GraphCorruptError(absPath, '"edges" is not an array');
  }
  if (!Array.isArray(obj.communities)) {
    throw new GraphCorruptError(absPath, '"communities" is not an array');
  }

  // v1 → v2 migration: the flow overlay is purely additive, so a v1
  // artifact (no `endpoints` field) migrates forward to an empty
  // endpoint set. A v2 artifact must carry an array when present.
  if ('endpoints' in obj && !Array.isArray(obj.endpoints)) {
    throw new GraphCorruptError(absPath, '"endpoints" is not an array');
  }
  const endpoints = Array.isArray(obj.endpoints) ? obj.endpoints : [];

  // Trust the rest; runtime errors in queries surface deeper issues.
  return { ...(raw as GraphJson), endpoints: endpoints as HttpEndpointNode[] };
}

/**
 * Build the in-memory `Graph` (convenience indices) from an ALREADY-VALIDATED
 * `GraphJson`. The pure, in-memory sibling of {@link loadGraph}: `loadGraph`
 * reads + JSON-parses + validates the disk artifact and then calls this;
 * consumers that already hold a `GraphJson` from the PRODUCER
 * (`gatherGraphifyGraph`, in-memory, never touching disk) index it here without
 * a disk round-trip — so a zero-write gate can query the graph without writing
 * `graph.json`. JSON.parse + validation stay in `loadGraph` (Rule 12); this only
 * builds maps, so it is safe to expose and use from within `src/explore/`.
 */
export function indexGraph(json: GraphJson): Graph {
  const nodeById = new Map<string, GraphNode>();
  for (const n of json.nodes) nodeById.set(n.id, n);

  const edgesFromNode = new Map<string, GraphEdge[]>();
  const edgesToNode = new Map<string, GraphEdge[]>();
  for (const e of json.edges) {
    const fromList = edgesFromNode.get(e.from) ?? [];
    fromList.push(e);
    edgesFromNode.set(e.from, fromList);
    const toList = edgesToNode.get(e.to) ?? [];
    toList.push(e);
    edgesToNode.set(e.to, toList);
  }

  const nodesByFile = new Map<string, GraphNode[]>();
  for (const n of json.nodes) {
    const list = nodesByFile.get(n.sourceFile) ?? [];
    list.push(n);
    nodesByFile.set(n.sourceFile, list);
  }

  const communityById = new Map<number, Community>();
  const communityByNode = new Map<string, Community>();
  for (const c of json.communities) {
    communityById.set(c.id, c);
    for (const nid of c.nodeIds) communityByNode.set(nid, c);
  }

  const endpointById = new Map<string, HttpEndpointNode>();
  const endpointByKey = new Map<string, HttpEndpointNode>();
  // The disk loader guarantees `endpoints` (validateAndUpgrade defaults it to
  // []), but the RAW producer graph from `gatherGraphifyGraph` — indexed
  // in-memory by the zero-write seam gate — carries only the structural
  // node/edge layers; the flow overlay is added at disk-write. Default to [] so
  // indexing a producer graph never throws (the flow overlay is not needed for
  // structural queries like duplicate detection).
  const endpoints = json.endpoints ?? [];
  for (const ep of endpoints) {
    endpointById.set(ep.id, ep);
    endpointByKey.set(`${ep.method} ${ep.path}`, ep);
  }

  return {
    ...json,
    endpoints,
    nodeById,
    edgesFromNode,
    edgesToNode,
    nodesByFile,
    communityById,
    communityByNode,
    endpointById,
    endpointByKey,
  };
}

/**
 * Obtain an indexed graph for `root` — reusing a FRESH on-disk `graph.json`
 * (its `meta.commitSha` matches HEAD) to skip a rebuild, else building it in
 * memory with `writeToDisk: false` (zero-write). Returns `undefined` when
 * graphify is unavailable or found no files. The one canonical "get me a graph
 * without writing to the repo" entry point (Rule 2 + Rule 12) — every consumer
 * that wants a query-ready graph for a possibly-unbuilt repo routes through it
 * (the seam inventory, the holistic contract map, …) rather than re-deriving
 * the reuse-vs-build dance.
 */
export async function obtainGraph(root: string): Promise<Graph | undefined> {
  const disk = tryLoadGraph(root);
  if (disk && isFreshGraph(disk, root)) return disk;
  const built = await gatherGraphifyGraph(root, { writeToDisk: false });
  return built.kind === 'success' ? indexGraph(built.graph) : undefined;
}

/** Whether an on-disk graph was built at the current HEAD (so it reflects the
 *  committed tree). Fail-safe: an unresolvable HEAD or an absent `commitSha`
 *  reads as NOT fresh, so callers rebuild rather than trust a stale artifact. */
function isFreshGraph(graph: Graph, root: string): boolean {
  const stamped = graph.meta.commitSha;
  if (!stamped) return false;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return head.length > 0 && head === stamped;
  } catch {
    return false;
  }
}
