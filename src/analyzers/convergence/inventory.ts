/**
 * The seam inventory — the ONE orchestration (Rule 2) that assembles every seam
 * VISIBILITY signal for a repo: the structural duplicates, the tiered
 * dead-surface list, and the convergence between them. Both `vyuh-dxkit flow`
 * (the inventory surface) and `vyuh-dxkit evaluate` (the trial's visibility lane)
 * consume this, so the "graphify → duplicates → dead surfaces → converge"
 * sequence lives in exactly one place.
 *
 * Zero-write + fail-open: builds the code graph IN MEMORY, reads diagnoseFlow,
 * writes nothing, and degrades to an empty inventory on any failure (a repo with
 * no graph, no flow surface, or a broken tree never errors the caller).
 */

import * as path from 'path';
import { execFileSync } from 'child_process';
import { gatherGraphifyGraph } from '../tools/graphify';
import { duplicateFindingsFromGraph, type DuplicateFinding } from '../../explore/duplication';
import { indexGraph, tryLoadGraph } from '../../explore/load';
import type { Graph } from '../../explore/types';
import { gatherDeadSurfaces, type DeadSurfaceResult } from './dead-surface-gather';
import { convergeSeams, type SeamConvergence } from './index';

/** Minimum structural-similarity for a duplicate to enter the inventory — the
 *  anti-slop proof's precision floor for the graph-duplicate signal. */
export const SEAM_DUP_MIN_SCORE = 0.75;

export interface SeamInventory {
  /** Structural duplicates the graph surfaced (score ≥ `SEAM_DUP_MIN_SCORE`). */
  readonly duplicates: readonly DuplicateFinding[];
  /** The tiered dead-surface result (removable / likely / expected + counts). */
  readonly dead: DeadSurfaceResult;
  /** The convergence: routes that are BOTH ladder-confirmed dead AND a
   *  structural duplicate — the ranked "removable slop." */
  readonly converged: readonly SeamConvergence[];
}

const EMPTY: SeamInventory = {
  duplicates: [],
  dead: {
    surfaces: [],
    crossRepoConsumersVisible: false,
    byTier: { removable: 0, likely: 0, expected: 0 },
  },
  converged: [],
};

/**
 * Gather the full seam inventory for a repo. `cwd` is the tree to analyze (a
 * worktree at a ref, or the repo root). Never throws.
 *
 * Obtains ONE graph and uses it for both the duplicate pass AND the dead-surface
 * direct-call seam, so the two signals agree. It REUSES a fresh on-disk
 * `graph.json` (one whose `commitSha` matches the current HEAD) to skip a rebuild
 * — the build is not cheap on a large repo (tens of seconds at ~50k+ symbols) —
 * and only builds fresh when no fresh artifact is present (e.g. a git worktree at
 * a ref, where evaluate always builds).
 */
export async function gatherSeamInventory(cwd: string): Promise<SeamInventory> {
  try {
    // Resolve to an ABSOLUTE path: graphify's subprocess resolves its target
    // from its own working directory, so a relative `cwd` silently yields "no
    // files found" (an empty graph → no duplicates → no convergence). Real CLI
    // callers pass absolute paths, but normalizing here makes the inventory
    // robust regardless of caller.
    const root = path.resolve(cwd);
    const graph = await obtainGraph(root);
    if (!graph) {
      const dead = await gatherDeadSurfaces(root, {});
      return { duplicates: [], dead, converged: [] };
    }
    const duplicates = duplicateFindingsFromGraph(graph, { minScore: SEAM_DUP_MIN_SCORE });
    const dead = await gatherDeadSurfaces(root, { dupFindings: duplicates, graph });
    const converged = convergeSeams(dead.surfaces, duplicates);
    return { duplicates, dead, converged };
  } catch {
    return EMPTY;
  }
}

/**
 * Obtain an indexed graph for `root` — reusing a FRESH on-disk `graph.json`
 * (commitSha matches HEAD) to skip a rebuild, else building it in memory
 * (zero-write). Returns undefined when graphify is unavailable / found no files.
 */
async function obtainGraph(root: string): Promise<Graph | undefined> {
  const disk = tryLoadGraph(root);
  if (disk && isFreshGraph(disk, root)) return disk;
  const built = await gatherGraphifyGraph(root, { writeToDisk: false });
  return built.kind === 'success' ? indexGraph(built.graph) : undefined;
}

/** Whether an on-disk graph was built at the current HEAD (so it reflects the
 *  committed tree). Fail-safe: an unresolvable HEAD or an absent `commitSha`
 *  reads as NOT fresh, so we rebuild rather than trust a stale artifact. */
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
