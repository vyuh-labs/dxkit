/**
 * Pure-function adapter — converts the in-memory `Graph` into the
 * shape cytoscape.js consumes (`ElementsDefinition` equivalent).
 *
 * Three tiers, matching the dashboard's three-level drill-down:
 *
 *   Tier 1 — community view (default tab landing)
 *     N community bubbles + inter-community edges, sized by
 *     member-count (sqrt scale) and labeled by dominantSourceDir.
 *
 *   Tier 2 — file view (within one community)
 *     File nodes for every file in the community, sized by call
 *     in-degree, edges = imports_from between member files plus
 *     the strongest cross-community import edges.
 *
 *   Tier 3 — symbol view (within one file)
 *     Symbol nodes for every function / class / method in the file,
 *     sized by call in-degree, edges = calls within the file plus
 *     thin external-call indicators that the renderer can wire as
 *     "click → jump to the target file."
 *
 * Pure: no DOM access, no cytoscape import, no I/O. Tested with
 * synthetic `Graph` fixtures (see test/dashboard/graph-adapter.test.ts).
 * The DOM-bound mounter (Part B's `graph-tab.ts`) consumes these
 * elements and hands them to cytoscape.
 *
 * Per CLAUDE.md Rule 12: every graph traversal here goes through
 * `src/explore/queries.ts` — no callers / callees / community lookup
 * code is reimplemented in this module. The arch gate enforces.
 */

import { callersOf, calleesOf, communitiesQuery, nodesInFile } from '../explore/queries';
import type { Graph, GraphEdge } from '../explore/types';

// ─── Cytoscape element shapes ────────────────────────────────────────────────
//
// Mirror cytoscape's `ElementsDefinition` minimally so this module
// remains importable without the cytoscape runtime in scope. The
// runtime accepts any object with `data: { id, ... }` plus optional
// `position` / `classes` — we emit a strict-typed superset of that.

/** A cytoscape node element — `data.id` is required. */
export interface CytoscapeNode {
  group: 'nodes';
  data: {
    id: string;
    /** Display label rendered by cytoscape. */
    label: string;
    /**
     * Numeric size hint in [0, 1]. The renderer maps this to a pixel
     * radius via the cytoscape stylesheet (e.g., 8px + 24px * size).
     * Sqrt-scaled at the adapter so 2× nodes don't dominate visually.
     */
    size: number;
    /**
     * Color group key — typically a pack id ('typescript', 'python',
     * ...) for Tier 1/2 and a symbol kind ('function', 'class', ...)
     * for Tier 3. The stylesheet binds this to the actual hex.
     */
    colorGroup: string;
    /**
     * Tier-specific payload. Renderer uses these for hover tooltips
     * + click-to-expand wiring. Optional fields are absent (not
     * `null`) when the underlying data didn't supply them.
     */
    tier: 1 | 2 | 3;
    /** Tier 1 only — present so the renderer can drill in. */
    communityId?: number;
    /** Tier 1 + Tier 2 — present so the renderer can drill in. */
    sourceFile?: string;
    /** Tier 3 only — present so the renderer can deep-link by line. */
    line?: number;
    /** Free-form metadata for the hover tooltip. Renderer formats. */
    meta?: Record<string, string | number | boolean>;
  };
}

/** A cytoscape edge element — `data.source` + `data.target` required. */
export interface CytoscapeEdge {
  group: 'edges';
  data: {
    id: string;
    source: string;
    target: string;
    /**
     * Edge category, drives stylesheet variant. `'calls'` = solid
     * gray, `'imports_from'` = dashed gray, `'method'` = thin gray
     * (Tier 3 only), `'community'` = thicker connector between
     * community bubbles in Tier 1.
     */
    relation: 'calls' | 'imports_from' | 'method' | 'community';
    /**
     * Visual weight hint in [0, 1]. The renderer maps to edge
     * thickness (e.g., 1px + 4px * weight). Sqrt-scaled.
     */
    weight: number;
    /** Renderer surfaces this on hover. Always >= 1 when present. */
    occurrences?: number;
    /**
     * Tier 3 only — set when the call's target is in a DIFFERENT
     * file. Renderer styles these as dim "leaving" indicators
     * pointing to a virtual external node, then makes them clickable
     * to navigate to the target file's Tier 3.
     */
    externalTargetFile?: string;
  };
}

/**
 * The complete set of cytoscape elements for one tier. Returned by
 * each adapter; consumed by `cytoscape({ elements: [...] })`. Empty
 * arrays are valid (e.g., a single-node community has no inter-file
 * edges); the renderer handles the empty cases.
 */
export interface CytoscapeElements {
  nodes: CytoscapeNode[];
  edges: CytoscapeEdge[];
}

// ─── Tier 1 — community bubbles ──────────────────────────────────────────────

/**
 * Build the cytoscape elements for the community-view (Tier 1) of a
 * graph. Each community becomes one node; inter-community edges are
 * synthesized by counting cross-community `calls` + `imports_from`
 * edges.
 *
 * Limit defaults to the top-20 communities by node-count — beyond
 * that the layout gets dense without adding information. The CLI's
 * `explore communities` default is 8; the viz needs more breadth to
 * communicate "this repo has lots of natural modules" so we lift
 * the cap.
 */
export function adaptToTier1(graph: Graph, opts: { limit?: number } = {}): CytoscapeElements {
  const limit = opts.limit ?? 20;

  // Use the canonical query for the per-community summary (Rule 12).
  // Rank-by-node-count is identical to communitiesQuery's behavior;
  // we just want the top-N rendered.
  const summaries = communitiesQuery(graph, limit);
  const communityIds = new Set(summaries.map((s) => s.id));

  // Largest community → size 1.0; sqrt scale ensures a 4× node-count
  // community renders ~2× the radius (visual area still proportional).
  const maxNodeCount = summaries.reduce((m, s) => Math.max(m, s.nodeCount), 0);

  const nodes: CytoscapeNode[] = summaries.map((s) => ({
    group: 'nodes',
    data: {
      id: communityId(s.id),
      label: s.dominantSourceDir || `community-${s.id}`,
      size: maxNodeCount > 0 ? Math.sqrt(s.nodeCount / maxNodeCount) : 0,
      colorGroup: s.dominantPack || 'multi',
      tier: 1,
      communityId: s.id,
      meta: {
        nodeCount: s.nodeCount,
        cohesion: round2(s.cohesion),
        dominantPack: s.dominantPack || 'mixed',
        topHotFiles: s.topHotFiles.slice(0, 3).join(', '),
      },
    },
  }));

  // Inter-community edges — count cross-community calls + imports.
  // Bidirectional pairs collapse to one undirected edge for visual
  // clarity (cytoscape can still treat the underlying edge as
  // directed if a layout cares).
  const pairCounts = new Map<string, { from: number; to: number; count: number }>();
  for (const edge of graph.edges) {
    if (edge.relation === 'method') continue; // method ownership is intra-file noise
    const fromComm = graph.communityByNode.get(edge.from);
    const toComm = graph.communityByNode.get(edge.to);
    if (!fromComm || !toComm) continue;
    if (fromComm.id === toComm.id) continue; // intra-community
    if (!communityIds.has(fromComm.id) || !communityIds.has(toComm.id)) continue;
    const [a, b] = fromComm.id < toComm.id ? [fromComm.id, toComm.id] : [toComm.id, fromComm.id];
    const key = `${a}->${b}`;
    const existing = pairCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      pairCounts.set(key, { from: a, to: b, count: 1 });
    }
  }

  const maxPairCount = Math.max(0, ...[...pairCounts.values()].map((p) => p.count));
  const edges: CytoscapeEdge[] = [...pairCounts.entries()].map(([key, p]) => ({
    group: 'edges',
    data: {
      id: `e1:${key}`,
      source: communityId(p.from),
      target: communityId(p.to),
      relation: 'community',
      weight: maxPairCount > 0 ? Math.sqrt(p.count / maxPairCount) : 0,
      occurrences: p.count,
    },
  }));

  return { nodes, edges };
}

// ─── Tier 2 — files within a community ───────────────────────────────────────

/**
 * Build the cytoscape elements for the file-view (Tier 2) of one
 * community. File nodes are the union of `sourceFile` across all
 * nodes whose community is the target.
 *
 * Edges are intra-community `imports_from` + `calls` aggregated to
 * the file level (a 12-call cluster from src/foo.ts → src/bar.ts
 * becomes one edge with `occurrences: 12`).
 *
 * Empty result when the community id is unknown — the renderer
 * surfaces a "community not found" error in that case.
 */
export function adaptToTier2(graph: Graph, communityId: number): CytoscapeElements {
  const community = graph.communityById.get(communityId);
  if (!community) {
    return { nodes: [], edges: [] };
  }

  // Files in the community: union of nodes[].sourceFile.
  const filesInCommunity = new Set<string>();
  for (const nodeId of community.nodeIds) {
    const node = graph.nodeById.get(nodeId);
    if (node?.sourceFile) filesInCommunity.add(node.sourceFile);
  }

  // Per-file call in-degree, computed via callersOf for Rule 12 compliance.
  const callsInByFile = new Map<string, number>();
  for (const nodeId of community.nodeIds) {
    const node = graph.nodeById.get(nodeId);
    if (!node?.sourceFile) continue;
    const callers = callersOf(graph, nodeId);
    callsInByFile.set(node.sourceFile, (callsInByFile.get(node.sourceFile) ?? 0) + callers.length);
  }

  // Per-file pack id (derived from the most common extension in the file's nodes).
  const packByFile = new Map<string, string>();
  for (const sourceFile of filesInCommunity) {
    packByFile.set(sourceFile, packFromExt(sourceFile));
  }

  // Per-file line-of-code aggregation surfaces on hover.
  const symbolCountByFile = new Map<string, number>();
  for (const sourceFile of filesInCommunity) {
    symbolCountByFile.set(sourceFile, nodesInFile(graph, sourceFile).length);
  }

  const maxCallsIn = Math.max(0, ...callsInByFile.values());

  const fileToNodeId = (sourceFile: string): string => `f2:${sourceFile}`;

  const nodes: CytoscapeNode[] = [...filesInCommunity].sort().map((sourceFile) => {
    const callsIn = callsInByFile.get(sourceFile) ?? 0;
    return {
      group: 'nodes',
      data: {
        id: fileToNodeId(sourceFile),
        label: basename(sourceFile),
        size: maxCallsIn > 0 ? Math.sqrt(callsIn / maxCallsIn) : 0,
        colorGroup: packByFile.get(sourceFile) || 'multi',
        tier: 2,
        communityId: community.id,
        sourceFile,
        meta: {
          callsIn,
          symbolCount: symbolCountByFile.get(sourceFile) ?? 0,
          path: sourceFile,
        },
      },
    };
  });

  // Aggregate edges to the file level. Walk every node in the
  // community + every outbound edge; bucket by (sourceFile,
  // targetFile, relation).
  const edgeKey = (from: string, to: string, rel: GraphEdge['relation']) =>
    `${from}\x00${to}\x00${rel}`;
  type EdgeBucket = {
    from: string;
    to: string;
    relation: GraphEdge['relation'];
    occurrences: number;
  };
  const edgeBuckets = new Map<string, EdgeBucket>();

  for (const nodeId of community.nodeIds) {
    const fromNode = graph.nodeById.get(nodeId);
    if (!fromNode?.sourceFile) continue;
    const fromFile = fromNode.sourceFile;
    for (const e of graph.edgesFromNode.get(nodeId) ?? []) {
      if (e.relation === 'method') continue;
      const toNode = graph.nodeById.get(e.to);
      if (!toNode?.sourceFile) continue;
      const toFile = toNode.sourceFile;
      if (fromFile === toFile) continue;
      if (!filesInCommunity.has(toFile)) continue; // intra-community only at Tier 2
      const k = edgeKey(fromFile, toFile, e.relation);
      const existing = edgeBuckets.get(k);
      if (existing) {
        existing.occurrences += e.occurrences ?? 1;
      } else {
        edgeBuckets.set(k, {
          from: fromFile,
          to: toFile,
          relation: e.relation,
          occurrences: e.occurrences ?? 1,
        });
      }
    }
  }

  const maxOcc = Math.max(0, ...[...edgeBuckets.values()].map((b) => b.occurrences));
  const edges: CytoscapeEdge[] = [...edgeBuckets.values()].map((b, i) => ({
    group: 'edges',
    data: {
      id: `e2:${i}`,
      source: fileToNodeId(b.from),
      target: fileToNodeId(b.to),
      relation: b.relation,
      weight: maxOcc > 0 ? Math.sqrt(b.occurrences / maxOcc) : 0,
      occurrences: b.occurrences,
    },
  }));

  return { nodes, edges };
}

// ─── Tier 3 — symbols within a file ──────────────────────────────────────────

/**
 * Build the cytoscape elements for the symbol-view (Tier 3) of one
 * file. Symbol nodes are the function / class / method declarations
 * (module nodes are excluded — they're file-as-a-whole markers, not
 * navigable symbols).
 *
 * Edges are `calls` edges between symbols within the file. Calls
 * that LEAVE the file become "external" indicators carrying the
 * target file path — the renderer styles them as dim arrows and
 * makes them clickable for navigation.
 *
 * Empty result when no symbols are declared in the file (the file
 * isn't in the graph) — the renderer surfaces a "no symbols
 * extracted" message.
 */
export function adaptToTier3(graph: Graph, sourceFile: string): CytoscapeElements {
  const fileNodes = nodesInFile(graph, sourceFile);
  if (fileNodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const symbolNodes = fileNodes.filter((n) => n.kind !== 'module');
  const symbolIds = new Set(symbolNodes.map((n) => n.id));

  // Per-symbol call in-degree drives size.
  const callsInBySymbol = new Map<string, number>();
  for (const n of symbolNodes) {
    callsInBySymbol.set(n.id, callersOf(graph, n.id).length);
  }
  const maxCallsIn = Math.max(0, ...callsInBySymbol.values());

  const nodes: CytoscapeNode[] = symbolNodes.map((n) => ({
    group: 'nodes',
    data: {
      id: `s3:${n.id}`,
      label: stripParens(n.label),
      size: maxCallsIn > 0 ? Math.sqrt((callsInBySymbol.get(n.id) ?? 0) / maxCallsIn) : 0,
      colorGroup: n.kind, // 'function' | 'class' | 'method'
      tier: 3,
      sourceFile,
      line: n.line,
      meta: {
        kind: n.kind,
        callsIn: callsInBySymbol.get(n.id) ?? 0,
        callsOut: calleesOf(graph, n.id).length,
        exported: n.exported === undefined ? 'unknown' : n.exported,
      },
    },
  }));

  const intraEdges: CytoscapeEdge[] = [];
  const externalBuckets = new Map<
    string,
    { sourceSymbol: string; targetFile: string; occurrences: number }
  >();

  for (const n of symbolNodes) {
    for (const e of graph.edgesFromNode.get(n.id) ?? []) {
      if (e.relation !== 'calls') continue;
      if (symbolIds.has(e.to)) {
        // Intra-file call — render as a real edge between two Tier 3 nodes.
        intraEdges.push({
          group: 'edges',
          data: {
            id: `i3:${e.from}->${e.to}`,
            source: `s3:${e.from}`,
            target: `s3:${e.to}`,
            relation: 'calls',
            weight: 0, // weight assigned below once max is known
            occurrences: e.occurrences ?? 1,
          },
        });
      } else {
        // Out-of-file call — bucket by (source symbol, target file).
        const target = graph.nodeById.get(e.to);
        const targetFile = target?.sourceFile;
        if (!targetFile || targetFile === sourceFile) continue;
        const key = `${n.id}\x00${targetFile}`;
        const existing = externalBuckets.get(key);
        if (existing) {
          existing.occurrences += e.occurrences ?? 1;
        } else {
          externalBuckets.set(key, {
            sourceSymbol: n.id,
            targetFile,
            occurrences: e.occurrences ?? 1,
          });
        }
      }
    }
  }

  // Weight scaling — share the same denominator across intra + external
  // for visual consistency.
  const allOcc = [
    ...intraEdges.map((e) => e.data.occurrences ?? 1),
    ...[...externalBuckets.values()].map((b) => b.occurrences),
  ];
  const maxOcc = Math.max(0, ...allOcc);
  for (const edge of intraEdges) {
    edge.data.weight = maxOcc > 0 ? Math.sqrt((edge.data.occurrences ?? 1) / maxOcc) : 0;
  }

  const externalEdges: CytoscapeEdge[] = [...externalBuckets.values()].map((b, i) => ({
    group: 'edges',
    data: {
      id: `x3:${i}`,
      source: `s3:${b.sourceSymbol}`,
      target: `ext3:${b.targetFile}`,
      relation: 'calls',
      weight: maxOcc > 0 ? Math.sqrt(b.occurrences / maxOcc) : 0,
      occurrences: b.occurrences,
      externalTargetFile: b.targetFile,
    },
  }));

  // Virtual "external file" nodes — one per distinct target file —
  // sized small + neutral-colored. Renderer wires them as clickable
  // "leaves this file" affordances.
  const externalFiles = new Set([...externalBuckets.values()].map((b) => b.targetFile));
  const externalNodes: CytoscapeNode[] = [...externalFiles].sort().map((f) => ({
    group: 'nodes',
    data: {
      id: `ext3:${f}`,
      label: basename(f),
      size: 0.1,
      colorGroup: 'external',
      tier: 3,
      sourceFile: f,
      meta: {
        external: true,
        path: f,
      },
    },
  }));

  return {
    nodes: [...nodes, ...externalNodes],
    edges: [...intraEdges, ...externalEdges],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function communityId(id: number): string {
  return `c1:${id}`;
}

function basename(p: string): string {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function stripParens(label: string): string {
  if (!label) return '';
  let s = label.replace(/\(\)$/, '');
  if (s.includes('.')) s = s.split('.').pop() ?? s;
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Tier 2's pack derivation mirrors `queries.ts:packFromExt` — kept
// inline rather than re-exported from queries.ts because the public
// queries.ts surface should remain the documented "graph queries"
// API (per Rule 12) and not leak a per-extension lookup table.
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
