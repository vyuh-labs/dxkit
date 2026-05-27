/**
 * Canonical graph query module. Per CLAUDE.md Rule 12, every consumer
 * (explore CLI subcommands, dashboard viz adapter, future 2.8 context
 * CLI, future 2.8 reachability) imports from here — never reimplements
 * graph traversal. Arch-check enforces.
 *
 * Sprint 1 ships the SKELETON: type signatures + empty implementations
 * so the canonical entry points exist for the arch rule to lock onto.
 * Sprint 2 fills the bodies as the explore CLI subcommands land.
 *
 * Every query is a pure function: takes a `Graph` (and optionally
 * other args), returns a typed result. No side effects, no I/O,
 * no caching — caching belongs at the loader level, not the query
 * level.
 */

import type { DetectedStack } from '../types';
import type { Community, Graph, GraphNode } from './types';

// ─── Low-level primitives ────────────────────────────────────────────────────

/** Nodes that call into the given nodeId (predecessors via `calls` edges). */
export function callersOf(graph: Graph, nodeId: string): GraphNode[] {
  const incoming = graph.edgesToNode.get(nodeId) ?? [];
  const out: GraphNode[] = [];
  for (const e of incoming) {
    if (e.relation !== 'calls') continue;
    const n = graph.nodeById.get(e.from);
    if (n) out.push(n);
  }
  return out;
}

/** Nodes that the given nodeId calls into (successors via `calls` edges). */
export function calleesOf(graph: Graph, nodeId: string): GraphNode[] {
  const outgoing = graph.edgesFromNode.get(nodeId) ?? [];
  const out: GraphNode[] = [];
  for (const e of outgoing) {
    if (e.relation !== 'calls') continue;
    const n = graph.nodeById.get(e.to);
    if (n) out.push(n);
  }
  return out;
}

/** All nodes declared in the given source file. */
export function nodesInFile(graph: Graph, sourceFile: string): GraphNode[] {
  return [...(graph.nodesByFile.get(sourceFile) ?? [])];
}

// ─── High-level queries ──────────────────────────────────────────────────────

/**
 * One row of `vyuh-dxkit explore hot-files` output. A "hot" file is
 * one many other files depend on (high total in-degree across all the
 * symbols it declares + inbound imports to the file's module node).
 *
 * - `callsIn`: count of `calls` edges terminating at any symbol in
 *   the file (summed across the file's function / class / method
 *   nodes)
 * - `importsIn`: count of `imports_from` edges terminating at the
 *   file's module node
 * - `callsOut`: count of `calls` edges originating from any symbol
 *   in the file
 * - `communityId` / `communityLabel`: the community the file's
 *   module node belongs to, when one exists; label is the
 *   community's dominantSourceDir for a quick visual anchor
 */
export interface HotFileResult {
  sourceFile: string;
  callsIn: number;
  importsIn: number;
  callsOut: number;
  communityId?: number;
  communityLabel?: string;
}

/**
 * Top-N files by total in-degree (callers + importers). The
 * "centrality" proxy — files many other files depend on. Useful as
 * a "what's the foundational layer of this repo?" answer.
 *
 * Files are derived from the union of `sourceFile` across all nodes;
 * the per-file aggregation traverses each node's inbound/outbound
 * edges. Limit defaults to 20 per the Sprint 0 spec.
 */
export function hotFilesQuery(graph: Graph, limit = 20): HotFileResult[] {
  const perFile = new Map<string, { callsIn: number; callsOut: number; nodes: GraphNode[] }>();

  for (const node of graph.nodes) {
    if (!node.sourceFile) continue;
    let agg = perFile.get(node.sourceFile);
    if (!agg) {
      agg = { callsIn: 0, callsOut: 0, nodes: [] };
      perFile.set(node.sourceFile, agg);
    }
    agg.nodes.push(node);
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'calls') agg.callsIn++;
    }
    for (const e of graph.edgesFromNode.get(node.id) ?? []) {
      if (e.relation === 'calls') agg.callsOut++;
    }
  }

  // Imports-in: count edges into the FILE's module node. Module
  // nodes have `kind === 'module'` and their `sourceFile` IS the
  // file path. Aggregate to the file by matching on that.
  const importsInByFile = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== 'module' || !node.sourceFile) continue;
    let count = 0;
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'imports_from') count++;
    }
    importsInByFile.set(node.sourceFile, (importsInByFile.get(node.sourceFile) ?? 0) + count);
  }

  const results: HotFileResult[] = [];
  for (const [sourceFile, agg] of perFile) {
    const importsIn = importsInByFile.get(sourceFile) ?? 0;
    // Pick a community via any of the file's nodes — module node
    // first if present, else any symbol's community.
    const moduleNode = agg.nodes.find((n) => n.kind === 'module');
    const sampleNode = moduleNode ?? agg.nodes[0];
    const community = sampleNode ? graph.communityByNode.get(sampleNode.id) : undefined;
    results.push({
      sourceFile,
      callsIn: agg.callsIn,
      importsIn,
      callsOut: agg.callsOut,
      communityId: community?.id,
      communityLabel: community?.dominantSourceDir || undefined,
    });
  }

  // Rank by total in-degree (calls + imports). Ties broken by
  // alphabetical source file path for stable output.
  results.sort((a, b) => {
    const ai = a.callsIn + a.importsIn;
    const bi = b.callsIn + b.importsIn;
    if (bi !== ai) return bi - ai;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  return results.slice(0, limit);
}

/**
 * One row of `vyuh-dxkit explore communities` output. A community is
 * a Louvain-clustered grouping of nodes; the dominant source dir +
 * pack give the reader a visual anchor ("this is the auth stuff" /
 * "this is the bom layer").
 */
export interface CommunityResult {
  id: number;
  nodeCount: number;
  dominantSourceDir: string;
  dominantPack: string;
  cohesion: number;
  topHotFiles: string[];
}

/**
 * Top-N communities by node count, with each community's top-3 hot
 * files (by in-degree within the community). Gives a "what are the
 * natural modules in this repo?" answer that complements `hot-files`
 * (which is global).
 */
export function communitiesQuery(graph: Graph, limit = 8): CommunityResult[] {
  const callsInByNode = computeCallsInByNode(graph);
  const sortedCommunities = [...graph.communities].sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length,
  );

  return sortedCommunities.slice(0, limit).map((c) => {
    // Per-file in-degree within this community only.
    const inDegByFile = new Map<string, number>();
    for (const nid of c.nodeIds) {
      const node = graph.nodeById.get(nid);
      if (!node?.sourceFile) continue;
      const d = callsInByNode.get(nid) ?? 0;
      inDegByFile.set(node.sourceFile, (inDegByFile.get(node.sourceFile) ?? 0) + d);
    }
    const topHotFiles = [...inDegByFile.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([f]) => f);

    return {
      id: c.id,
      nodeCount: c.nodeIds.length,
      dominantSourceDir: c.dominantSourceDir,
      dominantPack: c.dominantPack,
      cohesion: c.cohesion,
      topHotFiles,
    };
  });
}

/**
 * Internal helper: precompute per-node call in-degree. Shared between
 * `hotFilesQuery` (file-level aggregation) and `communitiesQuery`
 * (community-bounded ranking). Per CLAUDE.md Rule 2 — one source of
 * truth for the calls-in-degree counter.
 */
function computeCallsInByNode(graph: Graph): Map<string, number> {
  const m = new Map<string, number>();
  for (const node of graph.nodes) {
    let d = 0;
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'calls') d++;
    }
    if (d > 0) m.set(node.id, d);
  }
  return m;
}

/**
 * One-symbol entry inside a file summary — a function / class /
 * method declared in the file plus its in/out call counts. Used by
 * the `explore file <path>` subcommand to show "here's what this
 * file declares + how it interconnects."
 */
export interface FileSymbolSummary {
  id: string;
  kind: 'function' | 'class' | 'method' | 'module';
  label: string;
  line?: number;
  exported?: boolean;
  callsIn: number;
  callsOut: number;
}

/**
 * Full summary for a single file: its symbols, its callers (deduped
 * to unique files for readability), its callees, its inbound and
 * outbound imports, and its community membership. Used by `explore
 * file <path>`.
 *
 * `callerFiles` / `calleeFiles` are deduped at the FILE level — if
 * 12 symbols from src/foo.ts call into this file's symbols, the
 * caller appears once in `callerFiles` with `count: 12`. The reader
 * usually wants "which files depend on me" not "every individual
 * call site" (which would scroll for pages on hot files).
 */
export interface FileSummary {
  sourceFile: string;
  found: boolean;
  symbols: FileSymbolSummary[];
  callerFiles: Array<{ sourceFile: string; count: number }>;
  calleeFiles: Array<{ sourceFile: string; count: number }>;
  importsIn: Array<{ sourceFile: string }>;
  importsOut: Array<{ sourceFile: string }>;
  communityId?: number;
  communityLabel?: string;
  communityPack?: string;
}

/**
 * Build the per-file summary. `found: false` when the file isn't in
 * the graph (excluded by minified detection / vendored / unsupported
 * extension); the consumer handles that case with an explanatory
 * note instead of an empty result.
 */
export function fileSummaryQuery(graph: Graph, sourceFile: string): FileSummary {
  const nodes = nodesInFile(graph, sourceFile);
  if (nodes.length === 0) {
    return {
      sourceFile,
      found: false,
      symbols: [],
      callerFiles: [],
      calleeFiles: [],
      importsIn: [],
      importsOut: [],
    };
  }

  // Per-symbol summary for non-module nodes.
  const symbols: FileSymbolSummary[] = [];
  // Caller / callee aggregation, deduped at the file level.
  const callerCounts = new Map<string, number>();
  const calleeCounts = new Map<string, number>();
  // Imports in/out aggregation against the file's module node.
  const importsInFiles = new Set<string>();
  const importsOutFiles = new Set<string>();

  for (const node of nodes) {
    if (node.kind !== 'module') {
      let inCalls = 0;
      let outCalls = 0;
      for (const e of graph.edgesToNode.get(node.id) ?? []) {
        if (e.relation === 'calls') {
          inCalls++;
          const src = graph.nodeById.get(e.from);
          if (src?.sourceFile && src.sourceFile !== sourceFile) {
            callerCounts.set(src.sourceFile, (callerCounts.get(src.sourceFile) ?? 0) + 1);
          }
        }
      }
      for (const e of graph.edgesFromNode.get(node.id) ?? []) {
        if (e.relation === 'calls') {
          outCalls++;
          const dst = graph.nodeById.get(e.to);
          if (dst?.sourceFile && dst.sourceFile !== sourceFile) {
            calleeCounts.set(dst.sourceFile, (calleeCounts.get(dst.sourceFile) ?? 0) + 1);
          }
        }
      }
      symbols.push({
        id: node.id,
        kind: node.kind,
        label: node.label,
        line: node.line,
        exported: node.exported,
        callsIn: inCalls,
        callsOut: outCalls,
      });
    } else {
      // Module node: harvest imports edges.
      for (const e of graph.edgesToNode.get(node.id) ?? []) {
        if (e.relation === 'imports_from') {
          const src = graph.nodeById.get(e.from);
          if (src?.sourceFile && src.sourceFile !== sourceFile) {
            importsInFiles.add(src.sourceFile);
          }
        }
      }
      for (const e of graph.edgesFromNode.get(node.id) ?? []) {
        if (e.relation === 'imports_from') {
          const dst = graph.nodeById.get(e.to);
          if (dst?.sourceFile && dst.sourceFile !== sourceFile) {
            importsOutFiles.add(dst.sourceFile);
          }
        }
      }
    }
  }

  // Pick a representative node for community lookup — module first,
  // else any symbol.
  const moduleNode = nodes.find((n) => n.kind === 'module');
  const sampleNode = moduleNode ?? nodes[0];
  const community = sampleNode ? graph.communityByNode.get(sampleNode.id) : undefined;

  return {
    sourceFile,
    found: true,
    symbols: symbols.sort((a, b) => b.callsIn - a.callsIn || a.label.localeCompare(b.label)),
    callerFiles: [...callerCounts.entries()]
      .map(([sourceFile, count]) => ({ sourceFile, count }))
      .sort((a, b) => b.count - a.count || a.sourceFile.localeCompare(b.sourceFile)),
    calleeFiles: [...calleeCounts.entries()]
      .map(([sourceFile, count]) => ({ sourceFile, count }))
      .sort((a, b) => b.count - a.count || a.sourceFile.localeCompare(b.sourceFile)),
    importsIn: [...importsInFiles].sort().map((sourceFile) => ({ sourceFile })),
    importsOut: [...importsOutFiles].sort().map((sourceFile) => ({ sourceFile })),
    communityId: community?.id,
    communityLabel: community?.dominantSourceDir || undefined,
    communityPack: community?.dominantPack || undefined,
  };
}

/**
 * One row of `vyuh-dxkit explore entry-points` output. An entry
 * point is a symbol declared in a source file whose path matches
 * one of the active packs' `architecturalShape.primaryComponentPaths`
 * or `routePaths` (per CLAUDE.md Rule 8 — these are pack-driven, no
 * hardcoded framework strings here).
 *
 * `componentType` carries the matched pattern label (e.g. `routes`,
 * `controllers`, `forms`) so the consumer can group by surface.
 * Sourced from the pack's `dominantVocabulary` when available, else
 * from the matched path segment.
 */
export interface EntryPointResult {
  sourceFile: string;
  line?: number;
  symbol: string;
  componentType: string;
  callsOut: number;
  pack: string;
}

/**
 * Discover entry-point symbols by intersecting graph nodes with the
 * union of active packs' `primaryComponentPaths` + `routePaths`. The
 * rank is by call out-degree — entry points typically fan OUT (they
 * receive a request, then call many downstream functions). A high
 * out-degree node in a primary-architecture path is almost certainly
 * a real entry point.
 *
 * `flags` is the per-pack boolean map from `DetectedStack.languages`;
 * only patterns from active packs contribute. This matches the
 * existing pack-driven analyzer pattern.
 */
export function entryPointsQuery(
  graph: Graph,
  primaryPaths: ReadonlyArray<string>,
  routePaths: ReadonlyArray<string>,
  limit = 10,
): EntryPointResult[] {
  if (primaryPaths.length === 0 && routePaths.length === 0) {
    return [];
  }

  // Classify each source file by whether it matches a pattern.
  // Patterns are case-insensitive substrings of the relative POSIX
  // path (per the architecturalShape contract). routePaths overlap
  // primaryComponentPaths in many packs; tag a file by the most
  // specific match (route > primary > none).
  const classify = (sourceFile: string): { matched: boolean; label: string; isRoute: boolean } => {
    const lower = sourceFile.toLowerCase();
    for (const p of routePaths) {
      if (lower.includes(p.toLowerCase())) {
        return { matched: true, label: patternLabel(p), isRoute: true };
      }
    }
    for (const p of primaryPaths) {
      if (lower.includes(p.toLowerCase())) {
        return { matched: true, label: patternLabel(p), isRoute: false };
      }
    }
    return { matched: false, label: '', isRoute: false };
  };

  const results: EntryPointResult[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'module') continue;
    if (!node.sourceFile) continue;
    const c = classify(node.sourceFile);
    if (!c.matched) continue;

    let callsOut = 0;
    for (const e of graph.edgesFromNode.get(node.id) ?? []) {
      if (e.relation === 'calls') callsOut++;
    }
    if (callsOut === 0) continue; // entry points fan out; zero-out-degree symbols aren't entry points

    // Pack: derive from extension via the helper below. Avoids a
    // second pack registry import — keeps queries.ts independent of
    // languages/index.ts for this lookup.
    results.push({
      sourceFile: node.sourceFile,
      line: node.line,
      symbol: node.label,
      componentType: c.label,
      callsOut,
      pack: packFromExt(node.sourceFile),
    });
  }

  // Rank by callsOut desc, ties by sourceFile asc for stability.
  results.sort((a, b) => b.callsOut - a.callsOut || a.sourceFile.localeCompare(b.sourceFile));

  return results.slice(0, limit);
}

/**
 * Extract a human-readable label from a path pattern. E.g.
 * `/controllers/` → `controllers`, `/Forms/` → `forms`.
 */
function patternLabel(pattern: string): string {
  return pattern.replace(/[/\\]/g, '').toLowerCase();
}

// Per-extension pack id derivation. Mirrors EXT_TO_PACK in the
// Python script. Kept here as a private helper rather than imported
// from the registry to keep queries.ts importable without pulling
// the whole pack module surface.
function packFromExt(sourceFile: string): string {
  const i = sourceFile.lastIndexOf('.');
  if (i < 0) return '';
  const ext = sourceFile.slice(i).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.java': 'java',
    '.rb': 'ruby',
  };
  return map[ext] ?? '';
}

// Re-export the type so consumers can satisfy the signature without
// pulling DetectedStack from src/types.ts directly.
export type LanguageFlags = DetectedStack['languages'];

/**
 * One row of `vyuh-dxkit explore api-surface` output. An "API surface"
 * symbol is one that the language pack identifies as exported AND has
 * zero internal callers (no other file in the graph calls into it).
 *
 * Typically this set falls into three buckets:
 *   - Genuine public API (library entry points, named exports)
 *   - CLI entry points (legitimately not internally imported)
 *   - Dead exports (false positives surfaced honestly)
 *
 * The consumer should verify before treating any as dead code.
 */
export interface ApiSurfaceResult {
  sourceFile: string;
  line?: number;
  symbol: string;
  kind: 'function' | 'class' | 'method' | 'module';
  pack: string;
}

/**
 * Find exported symbols with zero internal callers. `packsExcluded`
 * lists pack ids whose `exportDetection.reliability === 'unreliable'`
 * — those packs' nodes are skipped because we can't trust their
 * `exported` flag (today: ruby). The consumer surfaces the exclusion
 * as a note in its output.
 */
export function apiSurfaceQuery(
  graph: Graph,
  packsExcluded: ReadonlyArray<string>,
  limit = 25,
): ApiSurfaceResult[] {
  const excluded = new Set(packsExcluded);
  const results: ApiSurfaceResult[] = [];

  for (const node of graph.nodes) {
    if (node.kind === 'module') continue;
    if (node.exported !== true) continue; // absent or false → skip
    const pack = packFromExt(node.sourceFile);
    if (excluded.has(pack)) continue;

    // Zero internal callers — check inbound calls edges. Note: the
    // calls in-degree includes potential graphify same-name conflicts
    // (run() at one site can attract calls meant for run() at another),
    // so this is a "best effort" — but consumers know that's the limit.
    let hasCaller = false;
    for (const e of graph.edgesToNode.get(node.id) ?? []) {
      if (e.relation === 'calls') {
        hasCaller = true;
        break;
      }
    }
    if (hasCaller) continue;

    results.push({
      sourceFile: node.sourceFile,
      line: node.line,
      symbol: node.label,
      kind: node.kind,
      pack,
    });
  }

  // Sort by sourceFile asc (groups by file naturally) then line asc.
  results.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || (a.line ?? 0) - (b.line ?? 0));

  return results.slice(0, limit);
}

/**
 * Options for `featureQuery`. `substring` enables the noisier
 * keyword-substring expansion (off by default per Sprint 0 spec —
 * false-positive prone for short keywords).
 */
export interface FeatureQueryOpts {
  substring?: boolean;
  limit?: number;
}

/**
 * A clustering of symbols that look like they implement one feature.
 * The community membership is the structural backbone — symbols in
 * the same community are tightly coupled by definition. The role
 * label comes from the community's dominantPack/dominantSourceDir
 * + per-pack vocabulary when available.
 */
export interface FeatureCluster {
  clusterId: number;
  communityId?: number;
  role: string;
  dominantSourceDir: string;
  files: string[];
  keySymbols: string[];
  seedHits: number;
}

/**
 * Full result of a feature query. `results` is non-empty when at
 * least one symbol matched the keyword; `suggestions` is populated
 * only when `results` is empty (edit-distance ≤2 against the
 * symbolIndex keys, top-3). `centralEntryPoint` names the highest
 * call-in-degree node across all clusters when results were found
 * — the natural "if you only look at one file, look here" anchor.
 */
export interface FeatureResult {
  results: FeatureCluster[];
  suggestions: Array<{ key: string; hits: number }>;
  centralEntryPoint?: {
    sourceFile: string;
    line?: number;
    symbol: string;
    calledFrom: number;
  };
}

/**
 * The marquee query — "where is feature X implemented?" Three-stage
 * resolution:
 *
 *   1. Direct symbolIndex lookup (case-insensitive, exact match on
 *      the stripped name)
 *   2. Substring expansion (opt-in via opts.substring) — scans every
 *      node's label for substring match
 *   3. Structural expansion — for each seed, gather community
 *      membership + immediate callers + callees, group by community
 *
 * On zero hits, computes edit-distance suggestions against the
 * symbolIndex keys so the caller can prompt the user with "did you
 * mean..."
 */
export function featureQuery(
  graph: Graph,
  keyword: string,
  opts: FeatureQueryOpts = {},
): FeatureResult {
  const limit = opts.limit ?? 50;
  const kw = keyword.toLowerCase().trim();
  if (!kw) {
    return { results: [], suggestions: [] };
  }

  // Stage 1: direct symbolIndex match.
  const seedIds = new Set<string>(graph.symbolIndex[kw] ?? []);

  // Stage 2: optional substring expansion. Iterate symbolIndex keys
  // (smaller than nodes) for the substring scan, then collect their
  // node ids.
  if (opts.substring) {
    for (const [key, ids] of Object.entries(graph.symbolIndex)) {
      if (key.includes(kw)) {
        for (const id of ids) seedIds.add(id);
      }
    }
  }

  if (seedIds.size === 0) {
    // "Did you mean" — two flavors, merged:
    //   1. Substring matches (symbols whose name CONTAINS the keyword)
    //      — the common case, since users rarely guess exact long
    //      symbol names like "gatherGraphifyResult" when they ask
    //      "where is graphify?"
    //   2. Edit-distance suggestions (Levenshtein ≤2) — catches
    //      typos like "graphfiy" → "graphify"-prefixed symbols
    // Substring is only tried for keywords of length >= 3 (anything
    // shorter generates too many false positives).
    const suggestions: Array<{ key: string; hits: number }> = [];
    const seen = new Set<string>();
    if (kw.length >= 3) {
      for (const key of Object.keys(graph.symbolIndex)) {
        if (key.includes(kw)) {
          suggestions.push({ key, hits: graph.symbolIndex[key].length });
          seen.add(key);
        }
      }
    }
    for (const key of Object.keys(graph.symbolIndex)) {
      if (seen.has(key)) continue;
      const d = levenshtein(kw, key);
      if (d <= 2) {
        suggestions.push({ key, hits: graph.symbolIndex[key].length });
      }
    }
    suggestions.sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key));
    return { results: [], suggestions: suggestions.slice(0, 5) };
  }

  // Stage 3: structural expansion. For each seed, gather its
  // community + direct callers/callees. Group expanded set by
  // community id.
  const expandedByComm = new Map<number, Set<string>>();
  const unclusteredExpansion = new Set<string>();

  for (const seedId of seedIds) {
    const community = graph.communityByNode.get(seedId);
    const bucket = community
      ? (expandedByComm.get(community.id) ?? new Set<string>())
      : unclusteredExpansion;
    bucket.add(seedId);

    // Direct callers (1 hop)
    for (const e of graph.edgesToNode.get(seedId) ?? []) {
      if (e.relation === 'calls') bucket.add(e.from);
    }
    // Direct callees (1 hop)
    for (const e of graph.edgesFromNode.get(seedId) ?? []) {
      if (e.relation === 'calls') bucket.add(e.to);
    }

    if (community) expandedByComm.set(community.id, bucket);
  }

  // Build cluster objects, ranked by seed count then size.
  const clusters: FeatureCluster[] = [];
  let clusterIdx = 0;

  const buildCluster = (
    nodeIds: Iterable<string>,
    community: Community | undefined,
  ): FeatureCluster => {
    const files = new Set<string>();
    const keySymbols = new Set<string>();
    let seedHits = 0;
    for (const nid of nodeIds) {
      const node = graph.nodeById.get(nid);
      if (!node) continue;
      if (node.sourceFile) files.add(node.sourceFile);
      if (seedIds.has(nid)) {
        seedHits++;
        // Promote seed nodes to keySymbols list.
        const stripped = stripParens(node.label);
        if (stripped) keySymbols.add(stripped);
      }
    }
    // Top-8 key symbols by alpha for stable output.
    const keySymbolsList = [...keySymbols].sort().slice(0, 8);
    const filesList = [...files].sort();
    const role = roleLabel(community);
    return {
      clusterId: clusterIdx++,
      communityId: community?.id,
      role,
      dominantSourceDir: community?.dominantSourceDir ?? '',
      files: filesList,
      keySymbols: keySymbolsList,
      seedHits,
    };
  };

  for (const [commId, ids] of expandedByComm) {
    const community = graph.communityById.get(commId);
    clusters.push(buildCluster(ids, community));
  }
  if (unclusteredExpansion.size > 0) {
    clusters.push(buildCluster(unclusteredExpansion, undefined));
  }

  // Rank clusters by seedHits desc, then size desc, then community id asc.
  clusters.sort(
    (a, b) =>
      b.seedHits - a.seedHits ||
      b.files.length - a.files.length ||
      (a.communityId ?? 9999) - (b.communityId ?? 9999),
  );

  const limitedClusters = clusters.slice(0, limit);

  // Central entry point: across all seed ids, the one with the
  // highest call in-degree globally.
  let centralId: string | undefined;
  let centralCount = 0;
  for (const seedId of seedIds) {
    let inDeg = 0;
    for (const e of graph.edgesToNode.get(seedId) ?? []) {
      if (e.relation === 'calls') inDeg++;
    }
    if (inDeg > centralCount) {
      centralCount = inDeg;
      centralId = seedId;
    }
  }
  let centralEntryPoint: FeatureResult['centralEntryPoint'];
  if (centralId && centralCount > 0) {
    const n = graph.nodeById.get(centralId);
    if (n) {
      centralEntryPoint = {
        sourceFile: n.sourceFile,
        line: n.line,
        symbol: n.label,
        calledFrom: centralCount,
      };
    }
  }

  return { results: limitedClusters, suggestions: [], centralEntryPoint };
}

function roleLabel(community: Community | undefined): string {
  if (!community) return 'unclustered';
  if (community.dominantSourceDir) return community.dominantSourceDir;
  return `community-${community.id}`;
}

function stripParens(label: string): string {
  if (!label) return '';
  let s = label.replace(/\(\)$/, '');
  if (s.includes('.')) s = s.split('.').pop() ?? s;
  return s;
}

/**
 * Iterative Levenshtein with O(min(a, b)) memory. Fast enough for
 * the suggestions scan (a few hundred symbolIndex keys × ≤20 chars).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const long = a.length >= b.length ? a : b;
  const short = a.length >= b.length ? b : a;
  let prev = new Array<number>(short.length + 1);
  let curr = new Array<number>(short.length + 1);
  for (let i = 0; i <= short.length; i++) prev[i] = i;
  for (let i = 1; i <= long.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[short.length];
}
