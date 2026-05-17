/**
 * Canonical score-result envelope produced by `evaluateSpec`.
 *
 * Every dimension's scorer returns this shape. Carries the numeric score,
 * the letter rating, and structured provenance: what was penalized, what
 * caps fired, and the actionable next moves sorted by potential uplift.
 *
 * This shape is the contract between the spec engine and every renderer +
 * agent that consumes scoring output. See STANDARDS.md for methodology
 * citations and `spec.ts` for how dimensions declare penalties and caps.
 */

/**
 * Uniform rating across all dimensions. Derived from the numeric score
 * via the thresholds in `thresholds.ts` (A≥80, B≥60, C≥40, D≥20, E<20).
 *
 * The numeric 0-100 score is the customer-friendly surface; the letter
 * rating is the industry-anchored claim. Both ship together.
 */
export type Rating = 'A' | 'B' | 'C' | 'D' | 'E';

/**
 * Named cap severity tiers. Each tier maps to a numeric ceiling in
 * `thresholds.ts:CAP_TIERS`. Lower ceiling = more serious disclosure.
 *
 * Tiers express WHAT a cap means, not arbitrary numbers:
 *   - `trust-broken`: definite catastrophic failure (committed secrets)
 *   - `unmeasured`: no signal at all (testing-null, all quality tools off)
 *   - `uncertainty`: key signal source unavailable (dep scanner)
 *   - `partial-uncertainty`: some measurement tools didn't run
 *   - `fixable-finding`: a concrete bounded finding is open (HIGH+ code)
 */
export type CapTier =
  | 'trust-broken'
  | 'unmeasured'
  | 'uncertainty'
  | 'partial-uncertainty'
  | 'fixable-finding';

/**
 * A penalty that fired during evaluation. Surfaces the underlying input
 * condition (`reason`), how much the score changed (`delta`), and how
 * much the score WOULD lift if the condition were resolved.
 *
 * `upliftIfFixed` is bounded by any binding cap — when a cap holds the
 * score below the rawScore ceiling, fixing a non-cap deduction yields no
 * actual score change, so this value reads as 0 in that state.
 */
export interface Deduction {
  readonly id: string;
  readonly reason: string;
  readonly delta: number;
  readonly upliftIfFixed: number;
}

/**
 * A cap that bound the score below its rawScore. Only the most-aggressive
 * applicable cap binds; non-binding caps (higher ceilings whose conditions
 * are also met) are not surfaced here — they would not constrain the
 * rating until the binding cap clears.
 *
 * `upliftIfRemoved` = how much the score would rise if this cap were
 * lifted. Equals (next-most-aggressive ceiling or unclamped post-penalty
 * score, whichever is lower) minus current score.
 */
export interface CapApplied {
  readonly id: string;
  readonly tier: CapTier;
  readonly ceiling: number;
  readonly reason: string;
  readonly upliftIfRemoved: number;
}

/**
 * One actionable next-move, derived from either a deduction or a cap.
 * Sorted across the result so the highest-uplift item is first.
 *
 * `ratingTransition` is populated when fixing the action would lift the
 * dimension across a rating boundary (e.g., B → A). When undefined, the
 * uplift stays within the current rating band.
 */
export interface TopAction {
  readonly source: 'deduction' | 'cap';
  readonly id: string;
  readonly reason: string;
  readonly upliftIfFixed: number;
  readonly ratingTransition?: { readonly from: Rating; readonly to: Rating };
}

/**
 * The full score-result envelope.
 *
 * Field roles:
 *   - `score`: the final, post-cap, post-clamp 0-100 number the customer
 *     sees on the dimension tile.
 *   - `rawScore`: the pre-cap, pre-clamp score. Can be negative if
 *     penalties exceeded the baseline. Surfaced so a 0/100 floor reads
 *     as "severe — raw -85" rather than indistinguishable from a 0/100
 *     where one penalty pushed past the boundary.
 *   - `rawPenalty`: the sum of all penalty deltas applied. Equals
 *     `rawScore - baseline` for subtractive specs.
 *   - `rating`: derived from `score` via uniform thresholds.
 *   - `deductions`: every penalty that fired, with structured reason.
 *   - `capsApplied`: the binding cap (zero or one entry per result).
 *   - `topActions`: union of deductions + caps, sorted by `upliftIfFixed`
 *     descending. The renderer reads this for the "what to fix next" UI.
 */
export interface ScoreResult {
  readonly dimension: string;
  readonly methodology: string;
  readonly rating: Rating;
  readonly score: number;
  readonly rawScore: number;
  readonly rawPenalty: number;
  readonly deductions: readonly Deduction[];
  readonly capsApplied: readonly CapApplied[];
  readonly topActions: readonly TopAction[];
}
