/**
 * Graph-derived structural-duplicate findings — the explore-layer adapter that
 * turns a code graph into `code-reimplementation` findings (CLAUDE.md Rule 12:
 * graph access is confined to `src/explore/`, so this load+query+map lives here,
 * never in the baseline gate or an analyzer).
 *
 * The detection itself is `duplicatePairsQuery` in `./queries.ts` (the one place
 * graph traversal lives). This module composes it with graph indexing and the
 * canonical fingerprint helper (Rule 9 — via the direct
 * `computeCodeReimplementationFingerprint`, NOT `identityFor`, exactly as the
 * flow gate mints its `flow-binding` ids), so every consumer (the two-ref seam
 * gate, `evaluate`, the dashboard) gets identity-stamped findings from ONE path.
 */

import type { Graph, GraphJson } from './types';
import { indexGraph } from './load';
import { duplicatePairsQuery, type DuplicatePairsOpts } from './queries';
import { computeCodeReimplementationFingerprint } from '../analyzers/tools/fingerprint';
import type { DuplicateAnchor } from '../baseline/types';

/**
 * One structural-duplicate finding: a symmetric pair of function anchors the
 * call graph shows to be the same routine written twice, its durable identity,
 * and the blended similarity score that produced it. The identity + anchors are
 * the same shape the `code-reimplementation` baseline entry stores.
 */
export interface DuplicateFinding {
  /** Durable identity — `computeCodeReimplementationFingerprint` over the sorted
   *  anchor pair (Rule 9, tool-/environment-independent). */
  readonly id: string;
  /** The two duplicate function anchors (dxkit-derived: file, symbol, line). */
  readonly anchors: readonly [DuplicateAnchor, DuplicateAnchor];
  /** Blended structural-similarity score in [0,1] — display/ranking metadata. */
  readonly score: number;
  /** Per-anchor flag: `true` when this anchor's file was touched by the change
   *  under evaluation — i.e. the side the diff INTRODUCED (the thing to
   *  consolidate), as opposed to a pre-existing twin. Set by the two-ref gate
   *  from its changed-file set; absent for a whole-repo query where "new" has no
   *  meaning. Display/remediation metadata only, never hashed. */
  readonly changed?: readonly [boolean, boolean];
}

/** A graph node's dxkit-derived anchor coordinates. */
function anchorOf(node: { sourceFile: string; label: string; line?: number }): DuplicateAnchor {
  return { file: node.sourceFile, symbol: node.label, line: node.line ?? 0 };
}

/**
 * Compute structural-duplicate findings from an in-memory `GraphJson`. Pure —
 * no I/O; the caller supplies the graph (obtained from the producer
 * `gatherGraphifyGraph`, never a disk read here). Returns findings sorted by
 * descending similarity, each carrying a stable identity.
 */
export function duplicateFindingsFromJson(
  json: GraphJson,
  opts: DuplicatePairsOpts = {},
): DuplicateFinding[] {
  return duplicateFindingsFromGraph(indexGraph(json), opts);
}

/**
 * Compute structural-duplicate findings from an ALREADY-INDEXED `Graph` — the
 * sibling of {@link duplicateFindingsFromJson} for a caller that already holds an
 * indexed graph (e.g. one loaded from a fresh on-disk `graph.json` via
 * `loadGraph`), so it need not re-index. Pure.
 */
export function duplicateFindingsFromGraph(
  graph: Graph,
  opts: DuplicatePairsOpts = {},
): DuplicateFinding[] {
  const pairs = duplicatePairsQuery(graph, opts);
  return pairs.map((p) => {
    const a = anchorOf(p.a);
    const b = anchorOf(p.b);
    return {
      id: computeCodeReimplementationFingerprint(a, b),
      anchors: [a, b] as const,
      score: p.score,
    };
  });
}
