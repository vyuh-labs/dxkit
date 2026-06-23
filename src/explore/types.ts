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

/** Current schema version. Bump on breaking change; loader handles migration. */
export const GRAPH_SCHEMA_VERSION = 1;

/**
 * Canonical disk location for the graph artifact, relative to cwd.
 * Producer (`src/analyzers/tools/graphify.ts:gatherGraphifyGraph`) writes
 * here; consumer (`src/explore/load.ts:loadGraph`) reads here. Defined
 * once in this types module so both sides agree on the path without an
 * awkward `tools → explore/load` import direction.
 */
export const GRAPH_REPORT_PATH = '.dxkit/reports/graph.json';

export type GraphNodeKind = 'function' | 'class' | 'method' | 'module';

export type GraphEdgeRelation = 'calls' | 'imports_from' | 'method';

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
 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: GraphEdgeRelation;
  readonly occurrences?: number;
  readonly importedSymbol?: string;
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
  readonly sourceFilesInGraph: number;
  readonly excludedFileCount: number;
  readonly packs: ReadonlyArray<LanguageId>;
  readonly truncated: boolean;
  readonly truncatedReason: string;
}

/**
 * The on-disk wire format. `schemaVersion` at root level
 * matches the existing `StructuralResult` envelope pattern.
 */
export interface GraphJson {
  readonly schemaVersion: number;
  readonly meta: GraphMeta;
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly communities: ReadonlyArray<Community>;
  readonly symbolIndex: SymbolIndex;
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
}
