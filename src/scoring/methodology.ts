/**
 * The scoring-methodology identity (impact surface P2, honesty constraint 4).
 *
 * A score is only comparable to another score computed under the SAME
 * methodology: the same dimension specs, penalty rules, cap tiers, and
 * rating thresholds. Comparing across methodology versions produced the
 * observed 0 -> 20 -> 0 trend blip: the score "moved" because the ruler
 * changed, not the repo. This is the recall-context discipline (CLAUDE.md
 * Rule 19) applied to scores: two numbers are diffable only when their
 * provenance matches, and a mismatch is DISCLOSED as not comparable, never
 * silently diffed.
 *
 * The constant is stamped on every published `ReportHistoryEntry`
 * (`reportToHistoryEntry`) and checked by the guardrail's score projection
 * before it renders a "40 -> 46 (projected)" line against a snapshot score.
 *
 * BUMP THIS whenever a change to `src/scoring/` (specs, thresholds, cap
 * tiers, the overall weighting) alters what a score MEANS: after the bump,
 * projections against pre-bump snapshots disclose "not comparable this PR"
 * until the next merge snapshot realigns the history. Do not bump for
 * changes that cannot move any score (comments, refactors, new consumers).
 *
 * A snapshot with NO methodology stamp (written by a pre-4.4.7 dxkit)
 * carries no evidence either way, so it reads as not comparable, mirroring
 * "absent recall is not comparable": never stamp or assume the current
 * version onto old data.
 */
export const SCORING_METHODOLOGY_VERSION = 'spec-v1';
