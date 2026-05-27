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
import {
  GRAPH_REPORT_PATH,
  GRAPH_SCHEMA_VERSION,
  type Community,
  type Graph,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
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
  // Future migrations: switch on v here when v2+ lands. Today v === 1
  // is the only supported version; no migration needed.

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
  // Trust the rest; runtime errors in queries surface deeper issues.
  return raw as GraphJson;
}

function indexGraph(json: GraphJson): Graph {
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

  return {
    ...json,
    nodeById,
    edgesFromNode,
    edgesToNode,
    nodesByFile,
    communityById,
    communityByNode,
  };
}
