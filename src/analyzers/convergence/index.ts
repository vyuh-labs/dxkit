/**
 * Seam convergence — the novel primitive. A PURE correlation over findings that
 * already carry their own signal (Rule 2: this module re-detects NOTHING; it
 * joins existing findings by a shared anchor). When two INDEPENDENT seam signals
 * agree on the same code, the agreement is what turns each signal's characteristic
 * noise into a ranked, near-certain result — precision by agreement.
 *
 * Phase 2 ships ONE convergence: a structural duplicate (`code-reimplementation`,
 * the shipped gate) ∩ a dead surface (an unconsumed route whose deadness the
 * confidence ladder confirmed). A route that is BOTH a copy-paste AND reaches
 * nobody is the textbook "removable slop" an agent leaves behind — and unlike
 * either signal alone, the pair is safe to surface loudly because two orthogonal
 * analyses had to agree.
 *
 * This is a VISIBILITY correlation (a ranked view), not a gate finding — it
 * carries no baseline identity (see the design's scoping refinement). The
 * BLOCK-TIER promotion (convergence → a verdict) is post-3.7, gated on the
 * validated cross-repo consumed-union.
 */

import type { DuplicateFinding } from '../duplication/findings';
import type { TieredDeadSurface } from './dead-surface-gather';

/** One converged finding — a code location where ≥2 independent seam signals
 *  agree. Phase 2: a dead route (tier `removable`) that is also a structural
 *  duplicate. Carries both contributors so a renderer can name the story and
 *  point at the twin. */
export interface SeamConvergence {
  readonly file: string;
  readonly route: TieredDeadSurface['route'];
  /** The structural-duplicate finding co-located in the same file (the twin +
   *  the direction, reused from the shipped dup finding). */
  readonly duplicate: DuplicateFinding;
  /** The independent seam kinds that agreed here — sorted, so the set is a
   *  stable description ("dead-surface" + "code-reimplementation"). */
  readonly signals: readonly string[];
}

/**
 * Correlate dead surfaces with structural duplicates by shared file. Only the
 * `removable`-tier dead surfaces qualify — the ladder already confirmed their
 * deadness (consumers visible, not a convention/direct-call route), so the
 * convergence is a genuine agreement, not two uncertain signals stacked. Pure;
 * deterministic ordering (by file, then route key).
 */
export function convergeSeams(
  deadSurfaces: readonly TieredDeadSurface[],
  dupFindings: readonly DuplicateFinding[],
): SeamConvergence[] {
  if (deadSurfaces.length === 0 || dupFindings.length === 0) return [];
  // Index duplicates by each anchor's file → the finding, so a dead route in a
  // duplicated file finds its twin.
  const dupByFile = new Map<string, DuplicateFinding>();
  for (const d of dupFindings) {
    for (const a of d.anchors) {
      if (!dupByFile.has(a.file)) dupByFile.set(a.file, d);
    }
  }
  const out: SeamConvergence[] = [];
  for (const s of deadSurfaces) {
    if (s.tier !== 'removable') continue; // only ladder-confirmed dead converges
    const dup = dupByFile.get(s.route.file);
    if (!dup) continue;
    out.push({
      file: s.route.file,
      route: s.route,
      duplicate: dup,
      signals: ['code-reimplementation', 'dead-surface'],
    });
  }
  out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      `${a.route.method} ${a.route.path}`.localeCompare(`${b.route.method} ${b.route.path}`),
  );
  return out;
}
