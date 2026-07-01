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
 * the file (summed across the file's function / class / method
 * nodes)
 * - `importsIn`: count of `imports_from` edges terminating at the
 * file's module node
 * - `callsOut`: count of `calls` edges originating from any symbol
 * in the file
 * - `communityId` / `communityLabel`: the community the file's
 * module node belongs to, when one exists; label is the
 * community's dominantSourceDir for a quick visual anchor
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
 * - Genuine public API (library entry points, named exports)
 * - CLI entry points (legitimately not internally imported)
 * - Dead exports (false positives surfaced honestly)
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
 * 1. Direct symbolIndex lookup (case-insensitive, exact match on
 * the stripped name)
 * 2. Substring expansion (opt-in via opts.substring) — scans every
 * node's label for substring match
 * 3. Structural expansion — for each seed, gather community
 * membership + immediate callers + callees, group by community
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

  // Stage 1 + 2: direct symbolIndex match + optional substring expansion.
  const seedIds = findSeedIds(graph, kw, opts.substring ?? false);

  if (seedIds.size === 0) {
    return { results: [], suggestions: suggestionsFor(graph, kw) };
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

// ─── Context query (token-budgeted subgraph for LLM injection) ───────────────

/**
 * Options for `contextQuery`. `budget` is the soft token ceiling on
 * the rendered output (BFS stops adding nodes once the running
 * estimate would exceed it). `tokensPerNode` is the per-symbol render
 * cost estimate the budget math uses — tuned to roughly match one
 * markdown line like "- `foo()` src/a.ts:42 (5 in / 3 out)". `maxDepth`
 * is an optional HARD ceiling on BFS hops for power users; default is
 * budget-bounded only (adaptive depth).
 */
export interface ContextQueryOpts {
  substring?: boolean;
  budget?: number;
  tokensPerNode?: number;
  maxDepth?: number;
}

/** One symbol in the budget-bounded selection. */
export interface ContextNode {
  id: string;
  symbol: string;
  sourceFile: string;
  line?: number;
  kind: GraphNode['kind'];
  /** 0 = seed (matched the query), 1 = direct neighbor, 2 = … */
  hop: number;
  callsIn: number;
  callsOut: number;
}

/** Community grouping of the selection, for orientation. */
export interface ContextCommunityGroup {
  communityId?: number;
  role: string;
  files: string[];
  symbols: string[];
}

/**
 * Result of a context query — a slim, ranked, budget-bounded subgraph
 * built for injection into an LLM's context window (or a human's
 * terminal). The formatter (`src/explore/format.ts`) turns this into
 * markdown / JSON; this function owns only the graph work + budget
 * math (Rule 12).
 *
 * `selection` is BFS-ordered: seeds first (hop 0), then their direct
 * neighbors (hop 1), then hop 2, … — so the most relevant symbols
 * survive when the budget truncates the tail. `anchor` is the
 * highest call-in-degree seed ("if you read one thing, read this").
 * `blastRadius` counts unique callers of the SEEDS (the symbols a
 * change would touch). `suggestions` is populated only when nothing
 * matched (the did-you-mean path). `truncated` + `omittedCount`
 * drive the formatter's honest "+N more …" footer.
 */
export interface ContextResult {
  query: string;
  matched: boolean;
  anchor?: { sourceFile: string; line?: number; symbol: string; calledFrom: number };
  selection: ContextNode[];
  byCommunity: ContextCommunityGroup[];
  blastRadius: { callers: number; callerFiles: number };
  truncated: boolean;
  omittedCount: number;
  estimatedTokens: number;
  budget: number;
  suggestions: Array<{ key: string; hits: number }>;
}

/**
 * The marquee token-reduction primitive — "give me just the relevant
 * structural slice for this query." Resolves seeds the same way
 * `featureQuery` does (shared `findSeedIds`), then expands breadth-
 * first through `calls` edges, stopping when the running token
 * estimate fills the budget (or an optional `maxDepth` ceiling is
 * reached). Adaptive depth falls out for free: a hot symbol's
 * immediate neighbors fill the budget at hop 1, while a cold symbol's
 * sparse neighborhood leaves room to reach hop 2+.
 *
 * Pure: no I/O, no formatting. Same `Graph` in → same `ContextResult`
 * out.
 */
export function contextQuery(
  graph: Graph,
  keyword: string,
  opts: ContextQueryOpts = {},
): ContextResult {
  const budget = opts.budget ?? 2000;
  const tokensPerNode = opts.tokensPerNode ?? 15;
  const maxDepth = opts.maxDepth ?? Infinity;
  const kw = keyword.toLowerCase().trim();

  const empty: ContextResult = {
    query: keyword,
    matched: false,
    selection: [],
    byCommunity: [],
    blastRadius: { callers: 0, callerFiles: 0 },
    truncated: false,
    omittedCount: 0,
    estimatedTokens: 0,
    budget,
    suggestions: [],
  };

  if (!kw) return empty;

  const seedIds = findSeedIds(graph, kw, opts.substring ?? false);
  if (seedIds.size === 0) {
    return { ...empty, suggestions: suggestionsFor(graph, kw) };
  }

  // Budget-bounded BFS over `calls` edges. The queue carries (id, hop);
  // seeds enter at hop 0. We add a node to the selection only if its
  // estimated render cost still fits the budget; the first node that
  // would overflow flips `truncated` and we drain the remaining queue
  // into `omittedCount` (a lower bound — honest "+N more").
  const selection: ContextNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; hop: number }> = [];
  for (const id of seedIds) queue.push({ id, hop: 0 });

  let estimatedTokens = 0;
  let truncated = false;
  let omittedCount = 0;

  while (queue.length > 0) {
    const { id, hop } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = graph.nodeById.get(id);
    if (!node || node.kind === 'module') continue;

    if (estimatedTokens + tokensPerNode > budget) {
      // Budget exhausted — this node + everything still queued is omitted.
      truncated = true;
      omittedCount++;
      continue;
    }

    const callers = callersOf(graph, id);
    const callees = calleesOf(graph, id);
    selection.push({
      id,
      symbol: stripParens(node.label),
      sourceFile: node.sourceFile,
      line: node.line,
      kind: node.kind,
      hop,
      callsIn: callers.length,
      callsOut: callees.length,
    });
    estimatedTokens += tokensPerNode;

    if (hop < maxDepth) {
      for (const n of callers) if (!visited.has(n.id)) queue.push({ id: n.id, hop: hop + 1 });
      for (const n of callees) if (!visited.has(n.id)) queue.push({ id: n.id, hop: hop + 1 });
    }
  }

  // Anchor: highest call-in-degree seed (the "start here" symbol).
  let anchor: ContextResult['anchor'];
  let anchorCount = -1;
  for (const seedId of seedIds) {
    const node = graph.nodeById.get(seedId);
    if (!node) continue;
    const inDeg = callersOf(graph, seedId).length;
    if (inDeg > anchorCount) {
      anchorCount = inDeg;
      anchor = {
        sourceFile: node.sourceFile,
        line: node.line,
        symbol: stripParens(node.label),
        calledFrom: inDeg,
      };
    }
  }

  // Blast radius: unique callers of the SEEDS + distinct caller files
  // (the surface a change to the matched symbols would touch).
  const callerIds = new Set<string>();
  const callerFiles = new Set<string>();
  for (const seedId of seedIds) {
    for (const caller of callersOf(graph, seedId)) {
      callerIds.add(caller.id);
      if (caller.sourceFile) callerFiles.add(caller.sourceFile);
    }
  }

  // Group the selection by community for orientation. Communities
  // containing a SEED (hop-0) symbol rank first — the reader cares
  // most about where the matched symbols live, not the biggest
  // incidental cluster the BFS fanned into. (graphify often lumps
  // much of a repo into one mega-community; sorting purely by size
  // would bury the seed under that grab-bag.)
  const groupsByComm = new Map<number | undefined, ContextCommunityGroup & { hasSeed: boolean }>();
  for (const sel of selection) {
    const community = graph.communityByNode.get(sel.id);
    const key = community?.id;
    let group = groupsByComm.get(key);
    if (!group) {
      group = {
        communityId: community?.id,
        role: roleLabel(community),
        files: [],
        symbols: [],
        hasSeed: false,
      };
      groupsByComm.set(key, group);
    }
    if (sel.sourceFile && !group.files.includes(sel.sourceFile)) group.files.push(sel.sourceFile);
    group.symbols.push(sel.symbol);
    if (sel.hop === 0) group.hasSeed = true;
  }
  const byCommunity: ContextCommunityGroup[] = [...groupsByComm.values()]
    .sort(
      (a, b) =>
        Number(b.hasSeed) - Number(a.hasSeed) ||
        b.symbols.length - a.symbols.length ||
        (a.communityId ?? 9999) - (b.communityId ?? 9999),
    )
    .map(({ hasSeed: _hasSeed, ...group }) => group);

  return {
    query: keyword,
    matched: true,
    anchor,
    selection,
    byCommunity,
    blastRadius: { callers: callerIds.size, callerFiles: callerFiles.size },
    truncated,
    omittedCount,
    estimatedTokens,
    budget,
    suggestions: [],
  };
}

// ─── Finding-context query (graph context attached to one analyzer finding) ──

/**
 * Graph context for a single analyzer finding (a security vuln, a
 * test-gap source file, a quality offender) located at `sourceFile`
 * (+ an optional `line`). Built for the enrichment pass that decorates
 * detailed reports: a fixing agent reading a finding sees its
 * structural blast radius + module membership inline, without running
 * the `context` command itself.
 *
 * `found: false` when the file isn't in the graph (excluded as
 * vendored / autogenerated / minified, an unsupported extension, or
 * simply not parsed by graphify). Consumers degrade gracefully —
 * attach nothing.
 *
 * `blastRadius` is FILE-level: unique caller files / caller symbols
 * across every symbol the file declares — the surface a change to this
 * file would touch. File-level is the robust signal; graphify can
 * conflate same-name symbols across files, so per-symbol caller counts
 * are noisier. `enclosingSymbol` is a labeled best-effort for the
 * symbol the finding sits inside.
 */
export interface FindingContext {
  found: boolean;
  sourceFile: string;
  community?: { id?: number; role: string };
  blastRadius: { callerFiles: number; callers: number; topCallerFiles: string[] };
  /**
   * Trust level of `blastRadius` for this file's language, stamped by
   * the enrichment adapter (not the pure query — `queries.ts` stays
   * independent of the language registry). `'unreliable'` means
   * graphify can't resolve this language's call edges (today: C#
   * cross-assembly `using`), so a 0 here is NOT evidence of "no callers"
   * and the renderer suppresses the number. Absent ⇒ treated as `'full'`.
   */
  callGraphReliability?: 'full' | 'partial' | 'unreliable';
  /**
   * Best-effort symbol the finding sits inside: the declaration
   * nearest at-or-above `line`. Absent when no `line` was given or the
   * file declares no symbol at-or-above the line. Graph nodes carry
   * only a declaration line (no end line), so this is a heuristic — a
   * finding can sit below the last symbol's declaration yet outside it.
   * Labeled as best-effort so consumers report it honestly.
   */
  enclosingSymbol?: { symbol: string; line?: number };
}

/**
 * Graph context for one finding location. Reuses `fileSummaryQuery`
 * for the file-level caller aggregation + community lookup (Rule 2 —
 * one source of truth for "who depends on this file"), then maps an
 * optional `line` to the nearest enclosing declaration.
 *
 * Pure: same `Graph` + location in → same `FindingContext` out. The
 * enrichment adapter (`src/explore/finding-context.ts`) owns the
 * graph load, the per-finding loop, and the dedupe budget.
 */
export function findingContextQuery(
  graph: Graph,
  sourceFile: string,
  line?: number,
  opts: { topCallerFiles?: number } = {},
): FindingContext {
  const topN = opts.topCallerFiles ?? 5;
  const summary = fileSummaryQuery(graph, sourceFile);
  if (!summary.found) {
    return {
      found: false,
      sourceFile,
      blastRadius: { callerFiles: 0, callers: 0, topCallerFiles: [] },
    };
  }

  const callers = summary.callerFiles.reduce((acc, c) => acc + c.count, 0);
  const topCallerFiles = summary.callerFiles.slice(0, topN).map((c) => c.sourceFile);

  let enclosingSymbol: FindingContext['enclosingSymbol'];
  if (typeof line === 'number') {
    let best: FileSymbolSummary | undefined;
    for (const sym of summary.symbols) {
      if (typeof sym.line !== 'number') continue;
      if (sym.line <= line && (best?.line === undefined || sym.line > best.line)) {
        best = sym;
      }
    }
    if (best) enclosingSymbol = { symbol: stripParens(best.label), line: best.line };
  }

  const community =
    summary.communityId !== undefined
      ? {
          id: summary.communityId,
          role: summary.communityLabel ?? `community-${summary.communityId}`,
        }
      : { role: 'unclustered' };

  return {
    found: true,
    sourceFile,
    community,
    blastRadius: { callerFiles: summary.callerFiles.length, callers, topCallerFiles },
    enclosingSymbol,
  };
}

/**
 * Resolve the enclosing symbol for a source location — the focused
 * primitive behind the content-anchored identity scope (CLAUDE.md
 * Rule 12: graph traversal stays in this module). Returns the label
 * (parens stripped) of the declaration nearest at-or-above `line` in
 * `sourceFile`, or `undefined` when the file declares no symbol
 * at-or-above the line (top-level code, file absent from the graph).
 *
 * Same heuristic `findingContextQuery` uses, extracted as a cheap
 * standalone query (no caller aggregation / community lookup) because
 * the scope pre-pass runs it once per code finding. Graph nodes carry
 * only a declaration line (no end line), so this is best-effort: a
 * finding below the last symbol's declaration but outside its body
 * attributes to that symbol. Accepted for identity — far stabler than a
 * line number, and `undefined` cleanly degrades to the file-level anchor.
 */
export function enclosingSymbolFor(
  graph: Graph,
  sourceFile: string,
  line: number,
): string | undefined {
  const nodes = graph.nodesByFile.get(sourceFile);
  if (!nodes) return undefined;
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (typeof n.line !== 'number' || n.line > line) continue;
    if (best?.line === undefined || n.line > best.line) best = n;
  }
  return best ? stripParens(best.label) : undefined;
}

/**
 * Resolve the id of the structural node enclosing a source location —
 * the node-id sibling of {@link enclosingSymbolFor}. Used by the flow
 * writer to anchor the `from` end of a `calls-endpoint` edge onto the
 * real call graph when graphify is present (so a UI→API edge composes
 * with the structural `calls` edges for multi-hop blast radius). Returns
 * `undefined` when the file declares no symbol at-or-above `line` AND has
 * no module node (the writer then leaves `from` empty and relies on the
 * edge's fromFile / fromLine coordinates, keeping the map
 * graphify-independent).
 *
 * Prefers the nearest non-module declaration at-or-above `line`; falls
 * back to the file's module node (a top-level call outside any symbol
 * still anchors to its file). Graph traversal stays in this module
 * (Rule 12).
 */
export function enclosingNodeIdFor(
  graph: Graph,
  sourceFile: string,
  line: number,
): string | undefined {
  const nodes = graph.nodesByFile.get(sourceFile);
  if (!nodes) return undefined;
  let best: GraphNode | undefined;
  let moduleFallback: GraphNode | undefined;
  for (const n of nodes) {
    if (n.kind === 'module') {
      moduleFallback = n;
      continue;
    }
    if (typeof n.line !== 'number' || n.line > line) continue;
    if (best?.line === undefined || n.line > best.line) best = n;
  }
  return (best ?? moduleFallback)?.id;
}

// ─── File-line context query (the `context <file:line>` structural half) ─────

/**
 * Structural context for one source location, resolved by POSITION
 * rather than by symbol name (the `context <file:line>` surface; its
 * sibling `contextQuery` resolves by keyword). The CLI pairs this with
 * the actual source slice read from disk — the graph carries no source
 * text — to hand a coding agent a focused chunk instead of a whole
 * file.
 *
 * `enclosingSymbol` is the declaration nearest at-or-above `line`;
 * `span` bounds that symbol's body as `[startLine, endLineExclusive)`
 * where `endLineExclusive` is the next declaration in the file (the
 * slice runs to EOF when the symbol is the last one). Both are
 * best-effort: graph nodes store only a declaration line, so a nested
 * or sibling boundary can be off — consumers label it as a heuristic.
 *
 * `found: false` when the file isn't in the graph (vendored /
 * autogenerated / unsupported / simply unparsed); the CLI still
 * delivers a centered raw-line window as a fallback.
 */
export interface FileLineContext {
  found: boolean;
  sourceFile: string;
  enclosingSymbol?: {
    id: string;
    symbol: string;
    line: number;
    kind: GraphNode['kind'];
    callsIn: number;
    callsOut: number;
  };
  span?: { startLine: number; endLineExclusive?: number };
  callers: Array<{ symbol: string; sourceFile: string; line?: number }>;
  callees: Array<{ symbol: string; sourceFile: string; line?: number }>;
  community?: { id?: number; role: string };
  blastRadius: { callerFiles: number; callers: number };
  /**
   * Trust level of `blastRadius` for this file's language, stamped by
   * the CLI (not this pure query — `queries.ts` stays independent of the
   * language registry, Rule 6). `'unreliable'` ⇒ graphify can't resolve
   * the call edges (C# cross-assembly), so a 0 is NOT "no callers" and
   * the renderer suppresses the number. Absent ⇒ treated as `'full'`.
   */
  callGraphReliability?: 'full' | 'partial' | 'unreliable';
}

/**
 * Resolve the structural neighborhood of a `file:line` location. Reuses
 * `fileSummaryQuery` for the file-level blast radius + community (Rule 2
 * — one source of truth for "who depends on this file") and the
 * `callersOf` / `calleesOf` primitives for the enclosing symbol's direct
 * edges. Pure: same `Graph` + location in → same `FileLineContext` out.
 */
export function fileLineContextQuery(
  graph: Graph,
  sourceFile: string,
  line: number,
  opts: { maxList?: number } = {},
): FileLineContext {
  const maxList = opts.maxList ?? 8;
  const summary = fileSummaryQuery(graph, sourceFile);
  if (!summary.found) {
    return {
      found: false,
      sourceFile,
      callers: [],
      callees: [],
      blastRadius: { callerFiles: 0, callers: 0 },
    };
  }

  const nodes = nodesInFile(graph, sourceFile).filter((n) => n.kind !== 'module');

  // Enclosing symbol: declaration nearest at-or-above the target line.
  let enclosing: GraphNode | undefined;
  for (const n of nodes) {
    if (typeof n.line !== 'number' || n.line > line) continue;
    if (enclosing?.line === undefined || n.line > enclosing.line) enclosing = n;
  }

  // Span end: the next declaration strictly below the enclosing one
  // (exclusive). Undefined ⇒ the symbol runs to EOF (CLI slices to the
  // budget). Module nodes are excluded so an import block doesn't cut
  // the body short.
  let endLineExclusive: number | undefined;
  if (enclosing?.line !== undefined) {
    for (const n of nodes) {
      if (typeof n.line !== 'number' || n.line <= enclosing.line) continue;
      if (endLineExclusive === undefined || n.line < endLineExclusive) endLineExclusive = n.line;
    }
  }

  const toRef = (n: GraphNode) => ({
    symbol: stripParens(n.label),
    sourceFile: n.sourceFile,
    line: n.line,
  });

  const callers = enclosing ? callersOf(graph, enclosing.id).slice(0, maxList).map(toRef) : [];
  const callees = enclosing ? calleesOf(graph, enclosing.id).slice(0, maxList).map(toRef) : [];

  const fileCallers = summary.callerFiles.reduce((acc, c) => acc + c.count, 0);
  const community =
    summary.communityId !== undefined
      ? {
          id: summary.communityId,
          role: summary.communityLabel ?? `community-${summary.communityId}`,
        }
      : { role: 'unclustered' };

  return {
    found: true,
    sourceFile,
    enclosingSymbol: enclosing
      ? {
          id: enclosing.id,
          symbol: stripParens(enclosing.label),
          line: enclosing.line!,
          kind: enclosing.kind,
          callsIn: callersOf(graph, enclosing.id).length,
          callsOut: calleesOf(graph, enclosing.id).length,
        }
      : undefined,
    span:
      enclosing?.line !== undefined ? { startLine: enclosing.line, endLineExclusive } : undefined,
    callers,
    callees,
    community,
    blastRadius: { callerFiles: summary.callerFiles.length, callers: fileCallers },
  };
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

/**
 * Resolve seed node ids for a (lowercased, trimmed) keyword. Stage 1
 * is an exact symbolIndex hit; stage 2 (opt-in) adds substring
 * matches across the index keys. Shared by `featureQuery` and
 * `contextQuery` so the two surfaces match identically — one source
 * of truth for "what does this keyword resolve to" (Rule 2).
 */
function findSeedIds(graph: Graph, kw: string, substring: boolean): Set<string> {
  const seedIds = new Set<string>(graph.symbolIndex[kw] ?? []);
  if (substring) {
    for (const [key, ids] of Object.entries(graph.symbolIndex)) {
      if (key.includes(kw)) {
        for (const id of ids) seedIds.add(id);
      }
    }
  }
  return seedIds;
}

/**
 * "Did you mean" suggestions for a keyword that matched no symbols.
 * Two merged flavors: substring matches (symbols whose name CONTAINS
 * the keyword — the common case, since users rarely type exact long
 * symbol names) and Levenshtein ≤2 typo candidates. Substring is only
 * tried for keywords of length ≥ 3 (shorter generates too many false
 * positives). Top-5 by hit count. Shared by `featureQuery` +
 * `contextQuery`.
 */
function suggestionsFor(graph: Graph, kw: string): Array<{ key: string; hits: number }> {
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
    if (levenshtein(kw, key) <= 2) {
      suggestions.push({ key, hits: graph.symbolIndex[key].length });
    }
  }
  suggestions.sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key));
  return suggestions.slice(0, 5);
}
