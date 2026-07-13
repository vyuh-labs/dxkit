/**
 * The seam lane for `vyuh-dxkit pr` — the structural-duplicate signal rendered
 * as a reviewer prompt rather than a block. It surfaces where a function the PR
 * ADDED or CHANGED structurally re-implements an existing one, so the reviewer
 * can confirm the parallel is intentional (or ask for consolidation). This is
 * the warn-tier, advisory form of the seam gate: "make gradual structural drift
 * visible to the reviewer" (the data-backed decision — a lone duplicate warns,
 * it does not block).
 *
 * Diff-scoped and VERIFIED-tier only (score ≥ `VERIFIED_DUP_MIN_SCORE`), grouped
 * one-per-added-function to avoid review fatigue: one added function that copies
 * N existing reads as ONE prompt with N twins. Reuses dxkit's AST duplicate
 * detector (`gatherDuplicateFindings`) and the shared grouping — no parallel
 * pipeline (Rule 2). Fail-open: any failure yields no prompts.
 */
import { VERIFIED_DUP_MIN_SCORE } from '../analyzers/duplication/detect';
import {
  gatherDuplicateFindings,
  groupDuplicatesByAdded,
  type DuplicateGroup,
} from '../analyzers/duplication/findings';

/**
 * Gather the diff-scoped, verified structural duplicates a PR introduces,
 * grouped by the added function. `root` is the absolute repo root (the HEAD
 * tree); `changedFiles` is the repo-relative set the diff touched — a pair is
 * only surfaced when it touches a changed file, and the changed side is marked
 * so the group's `added` is the function the PR is responsible for.
 *
 * Independent of `duplication.mode` (the block gate) — this is the visibility
 * lane, always computed so the reviewer sees the drift even on a repo that never
 * armed the gate.
 */
export async function gatherPrSeams(
  root: string,
  changedFiles: ReadonlySet<string>,
): Promise<DuplicateGroup[]> {
  if (changedFiles.size === 0) return [];
  const findings = await gatherDuplicateFindings(root, {
    minScore: VERIFIED_DUP_MIN_SCORE,
    focusFiles: changedFiles,
  });
  // Mark which anchor the diff introduced (its file is in the changed set), so
  // the grouping picks the added side as the thing to consolidate.
  const directional = findings.map((f) => ({
    ...f,
    changed: [changedFiles.has(f.anchors[0].file), changedFiles.has(f.anchors[1].file)] as const,
  }));
  return groupDuplicatesByAdded(directional);
}
