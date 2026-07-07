/**
 * Repo-explore graph types — the in-memory shape consumed by
 * `src/explore/queries.ts`, `src/dashboard/graph-adapter.ts`, and
 * future graph-consuming CLIs (2.8 context CLI, 2.8 reachability).
 *
 * The on-disk wire format at `.dxkit/reports/graph.json` is the
 * `GraphJson` shape (defined below).
 * The loader at `./load.ts:loadGraph` validates the wire format
 * + returns a `Graph` (the same shape plus convenience indices
 * that don't need to live on disk).
 *
 * Per CLAUDE.md Rule 12, every consumer reads via `loadGraph` —
 * never `JSON.parse` directly. Arch-check enforces.
 */

import type { LanguageId } from '../types';

/**
 * Current schema version. Bump on breaking change; loader handles migration.
 *
 * v2 (flow map): adds the `endpoints` overlay (`http-endpoint` nodes) and the
 * `calls-endpoint` edge relation — the cross-boundary UI→API join the graph
 * could not previously express. The overlay is purely additive: a v1 artifact
 * migrates forward to an empty endpoint set, and the structural node/edge kinds
 * are untouched, so every pre-flow query keeps working unchanged.
 */
export const GRAPH_SCHEMA_VERSION = 2;

/**
 * Canonical disk location for the graph artifact, relative to cwd.
 * Producer (`src/analyzers/tools/graphify.ts:gatherGraphifyGraph`) writes
 * here; consumer (`src/explore/load.ts:loadGraph`) reads here. Defined
 * once in this types module so both sides agree on the path without an
 * awkward `tools → explore/load` import direction.
 */
export const GRAPH_REPORT_PATH = '.dxkit/reports/graph.json';

export type GraphNodeKind = 'function' | 'class' | 'method' | 'module';

export type GraphEdgeRelation = 'calls' | 'imports_from' | 'method' | 'calls-endpoint';

export type ExportDetectionReliability = 'full' | 'partial' | 'unreliable';

/**
 * A single graph node — a function, class, method, or module
 * surfaced by graphify's tree-sitter extraction.
 *
 * `exported` is OPTIONAL per the schema's "absent = unknown"
 * convention: only populated when the language pack's
 * `exportDetection.reliability` is 'full' or 'partial' AND the
 * line-scan succeeded. Consumers handle absent / `true` / `false`
 * as three distinct states (absent ≠ false).
 */
export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly sourceFile: string;
  readonly line?: number;
  readonly exported?: boolean;
}

/**
 * A directed edge between two nodes. `occurrences` only populated
 * for `calls` edges; `importedSymbol` only populated for
 * `imports_from` edges when graphify surfaces the per-symbol info
 * (today: omitted; reserved for future graphify extension).
 *
 * `fromFile` / `fromLine` are populated ONLY on `calls-endpoint` edges
 * (the flow overlay): they carry the consuming call site's source
 * coordinates directly on the edge. When graphify is present the flow
 * writer resolves `from` to the enclosing structural node id (linking the
 * consumer into the real call graph for multi-hop blast radius); when it
 * is absent `from` is the empty string and these coordinates are the only
 * consumer anchor — which is what keeps the flow map graphify-independent.
 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: GraphEdgeRelation;
  readonly occurrences?: number;
  readonly importedSymbol?: string;
  readonly fromFile?: string;
  readonly fromLine?: number;
}

/**
 * An HTTP endpoint a service serves — one per distinct `(method, path)`
 * a backend exposes. The `to` end of every `calls-endpoint` edge. Lives
 * in the separate `GraphJson.endpoints` overlay rather than in `nodes`,
 * so the four structural node kinds (and every query that switches on
 * them) stay untouched by the flow layer.
 *
 * `method` / `path` are the NORMALIZED join key (`GET`, `/articles/{var}`)
 * — the same canonical form a client call reduces to, so the two sides
 * meet on `${method} ${path}`. `via` records discovery provenance
 * (source decorator, Express-style route call, or an ingested spec);
 * `handler` is the best-effort handler symbol when known.
 */
export interface HttpEndpointNode {
  readonly id: string;
  readonly kind: 'http-endpoint';
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly via: 'decorator' | 'router-call' | 'file-route' | 'spec';
  readonly handler: string | null;
  readonly sourceFile: string;
  readonly line?: number;
}

/**
 * A Louvain-clustered grouping of nodes. `cohesion` in [0, 1].
 * `dominantSourceDir` is the most common ancestor directory among
 * member nodes' source files; `dominantPack` is the most common
 * language pack. Both empty strings when no clear dominance.
 */
export interface Community {
  readonly id: number;
  readonly nodeIds: ReadonlyArray<string>;
  readonly cohesion: number;
  readonly dominantSourceDir: string;
  readonly dominantPack: string;
}

/**
 * Case-insensitive symbol-name lookup. Keys are lowercased labels
 * (with the trailing `()` stripped for function/method labels);
 * values are arrays of nodeIds matching the key. Used by the
 * explore CLI's `feature <keyword>` query and the dashboard viz
 * search box for O(1) lookup.
 */
export type SymbolIndex = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * Top-level metadata: tool versions, generation time, file counts,
 * active packs, truncation status. `truncated: true` means the
 * size-budget enforcer dropped data (see `truncatedReason` for what).
 * `truncatedReason` is non-empty iff `truncated: true`.
 *
 * Note: no `cwd` field — we don't write absolute paths to a file
 * that might get shared. Source files are project-relative
 * throughout.
 */
export interface GraphMeta {
  readonly tool: 'graphify';
  readonly graphifyVersion: string;
  readonly dxkitVersion: string;
  readonly generatedAt: string;
  /**
   * The git HEAD commit the graph was built at, stamped by dxkit at write time.
   * Lets a consumer decide EXACT staleness (graph SHA vs current HEAD) rather
   * than a timestamp proxy, and keys a CI-cached graph. Optional for
   * back-compat: a graph written before this field existed omits it, and
   * consumers treat an absent SHA as "freshness unknown".
   */
  readonly commitSha?: string;
  readonly sourceFilesInGraph: number;
  readonly excludedFileCount: number;
  readonly packs: ReadonlyArray<LanguageId>;
  readonly truncated: boolean;
  readonly truncatedReason: string;
}

/**
 * The on-disk wire format. `schemaVersion` at root level
 * matches the existing `StructuralResult` envelope pattern.
 *
 * `endpoints` is the v2 flow overlay: absent in a v1 artifact (the
 * loader migrates it to `[]`), present-but-possibly-empty in v2. The
 * `calls-endpoint` edges that reference these endpoints live in the
 * normal `edges` array (relation-filtered, so they never leak into a
 * structural `calls` / `imports_from` traversal).
 */
export interface GraphJson {
  readonly schemaVersion: number;
  readonly meta: GraphMeta;
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly communities: ReadonlyArray<Community>;
  readonly symbolIndex: SymbolIndex;
  readonly endpoints: ReadonlyArray<HttpEndpointNode>;
}

/**
 * In-memory graph representation. Extends `GraphJson` with
 * convenience indices the wire format doesn't carry — built once
 * by the loader; pure-function queries in `./queries.ts` read from
 * these maps for O(1) lookup instead of repeatedly scanning the
 * arrays.
 */
export interface Graph extends GraphJson {
  readonly nodeById: ReadonlyMap<string, GraphNode>;
  readonly edgesFromNode: ReadonlyMap<string, ReadonlyArray<GraphEdge>>;
  readonly edgesToNode: ReadonlyMap<string, ReadonlyArray<GraphEdge>>;
  readonly nodesByFile: ReadonlyMap<string, ReadonlyArray<GraphNode>>;
  readonly communityById: ReadonlyMap<number, Community>;
  readonly communityByNode: ReadonlyMap<string, Community>;
  /** The flow overlay, indexed by endpoint id. */
  readonly endpointById: ReadonlyMap<string, HttpEndpointNode>;
  /** The flow overlay, indexed by the `${method} ${path}` join key. */
  readonly endpointByKey: ReadonlyMap<string, HttpEndpointNode>;
}
