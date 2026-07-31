/**
 * The remediation score hinge (4.3.4) — a task's GOAL as a deterministic
 * land condition, split from `run.ts` at the large-file bar.
 *
 * The lane's law is that a task ships only when "done" is re-verifiable
 * without reading prose. For work whose whole point is a health dimension
 * moving (docs), the floor and guardrail are necessary but prove nothing
 * about the goal — so a task may declare a hinge: the `improve` dimension's
 * score must end STRICTLY higher than the pristine-tree entry score, and
 * every `holdSteady` dimension must not drop. Both sides are computed by the
 * same deterministic scorer in the same environment, so the DELTA is fair
 * even where absolute scores are degraded (a missing scanner degrades entry
 * and after equally).
 */

import type { AnalysisTrustContext } from '../analysis-trust';
import type { RemediateTask } from './tasks';

type Hinge = NonNullable<RemediateTask['scoreHinge']>;

/** Entry/after snapshot for a score hinge: the improve dimension's score plus
 *  the holdSteady dimensions' scores, index-aligned with the declaration. */
export interface HingeScores {
  readonly improve: number;
  readonly holds: readonly number[];
}

export interface HingeEvidence {
  readonly dimension: string;
  readonly before: number;
  readonly after: number;
  readonly holds: readonly { dimension: string; before: number; after: number }[];
}

export type HingeVerdict =
  | { readonly ok: true; readonly evidence: HingeEvidence }
  | { readonly ok: false; readonly evidence: HingeEvidence; readonly note: string };

/** Default hinge probe: the deterministic health scorer. */
export async function healthHingeScores(
  cwd: string,
  trust: AnalysisTrustContext,
  hinge: Hinge,
): Promise<HingeScores> {
  const { analyzeHealth } = await import('../analyzers/health');
  // The lane runs on the maintainers' own default branch — the same trust
  // the agent itself ran under.
  const report = await analyzeHealth(cwd, { trust });
  return {
    improve: report.dimensions[hinge.improve].score,
    holds: hinge.holdSteady.map((d) => report.dimensions[d].score),
  };
}

/** Pure hinge evaluation — one place decides what "goal met" means. */
export function evaluateScoreHinge(
  hinge: Hinge,
  entry: HingeScores,
  after: HingeScores,
): HingeVerdict {
  const evidence: HingeEvidence = {
    dimension: hinge.improve,
    before: entry.improve,
    after: after.improve,
    holds: hinge.holdSteady.map((d, i) => ({
      dimension: d,
      before: entry.holds[i],
      after: after.holds[i],
    })),
  };
  const improved = evidence.after > evidence.before;
  const held = evidence.holds.every((h) => h.after >= h.before);
  if (improved && held) return { ok: true, evidence };
  return {
    ok: false,
    evidence,
    note: !improved
      ? `the ${evidence.dimension} score did not improve (${evidence.before} -> ` +
        `${evidence.after}) — the task's goal is part of the verified frame, so ` +
        `nothing lands. Cosmetic churn is rejected, not shipped.`
      : `a held dimension dropped (${evidence.holds
          .filter((h) => h.after < h.before)
          .map((h) => `${h.dimension} ${h.before} -> ${h.after}`)
          .join(', ')}) — improving one score by degrading another never lands.`,
  };
}

/** The hinge's ledger line — evidence rendered one way everywhere. */
export function renderScoreHinge(h: HingeEvidence): string {
  const arrow = (b: number, a: number): string =>
    `${b} -> ${a}${a > b ? ' ✓' : a < b ? ' ✗' : ' ='}`;
  return (
    `- score hinge: **${h.dimension}** ${arrow(h.before, h.after)}` +
    (h.holds.length > 0
      ? ` (held: ${h.holds.map((x) => `${x.dimension} ${arrow(x.before, x.after)}`).join(', ')})`
      : '')
  );
}
