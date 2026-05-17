/**
 * Declarative scoring specification — one per dimension.
 *
 * A `DimensionScoringSpec<TInput>` is a self-contained artifact: the
 * baseline score, the list of penalty rules, and the list of cap rules
 * that enforce the dimension's Label Contract. The evaluator
 * (`evaluator.ts`) consumes a spec + input and produces a `ScoreResult`.
 *
 * Specs are values, not functions — each rule is a small object with
 * declarative predicates and reason-builders. This lets us:
 *   - register specs in a central index
 *   - generate documentation from specs (citations, penalty lists)
 *   - test new dimensions by injecting synthetic specs
 *   - keep the cross-dimension contract (return shape, rating mapping)
 *     uniform regardless of per-dimension methodology
 *
 * Per-dimension specs live in `dimensions/<name>.ts` (one file per
 * dimension, mirroring the LanguageSupport pattern in CLAUDE.md Rule 6).
 */

import type { CapTier } from './result';

/**
 * A single penalty rule. Fires when `applies(input)` returns true; its
 * `delta` (typically negative for subtractive specs, positive for
 * additive specs like Documentation) adjusts the running score.
 *
 * `describe(input)` produces the human-readable reason surfaced in the
 * report ("3 hardcoded secrets detected"). `upliftIfFixed` is optional;
 * when omitted, the evaluator defaults to `Math.abs(delta(input))`.
 * Override when fixing the underlying condition would yield more (or
 * less) than the raw delta — e.g., when fixing a single source also
 * clears a related cap.
 */
export interface PenaltyRule<TInput> {
  readonly id: string;
  readonly describe: (input: TInput) => string;
  readonly applies: (input: TInput) => boolean;
  readonly delta: (input: TInput) => number;
  readonly upliftIfFixed?: (input: TInput) => number;
}

/**
 * A cap rule. Bounds the final score at the tier's ceiling when
 * `applies(input)` returns true. Tier name is the contract; the
 * numeric ceiling comes from `thresholds.ts:CAP_TIERS[tier]`.
 *
 * Caps express the Label Contract: "A grade means no blockers." Each
 * cap names a specific blocker class. The evaluator applies the
 * most-aggressive applicable cap (lowest ceiling); other applicable
 * caps would not bind on the post-cap score and are not surfaced.
 */
export interface CapRule<TInput> {
  readonly id: string;
  readonly tier: CapTier;
  readonly describe: (input: TInput) => string;
  readonly applies: (input: TInput) => boolean;
}

/**
 * The full dimension scoring specification.
 *
 * `baseline` is the starting score. Subtractive specs (Security,
 * Quality, Maintainability) start at 100; additive checklist specs
 * (Documentation, DevEx) start at 0.
 *
 * `methodology` is a citation key matching an entry in `STANDARDS.md` —
 * e.g., `'iso-iec-5055-severity-dominant'` for the SonarQube-shape
 * Security rating, `'sqale-debt-ratio'` for the Maintainability dim.
 * The renderer surfaces this so customers can trace any score claim to
 * its methodological source.
 */
export interface DimensionScoringSpec<TInput> {
  readonly dimension: string;
  readonly methodology: string;
  readonly baseline: number;
  readonly penalties: readonly PenaltyRule<TInput>[];
  readonly caps: readonly CapRule<TInput>[];
}
