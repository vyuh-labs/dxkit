/**
 * Guardrail-red containment record types (4.4.7 / 4.4.8, #373), moved
 * verbatim from `outcome.ts` at the module-size bar. `outcome.ts` re-exports
 * them, so every consumer keeps one import surface; the engine
 * (`containment.ts`) produces the record and the ledger renderer, the PR
 * body and the JSON attempt record read it.
 */

/** One containment drop (guardrail-red containment, 4.4.7): the unit whose
 *  commits were reverted because the final guardrail's blocking findings
 *  attributed to it. */
export interface ContainedDrop {
  /** `recipe-order` (4.4.8): one commit of a recipe whose registry entry
   *  declares `containmentUnit: 'order'` (its orders listed), dropped alone
   *  while the rest of the recipe tier lands. */
  readonly unit: 'agent-order' | 'recipe-group' | 'recipe-order';
  readonly orderIds: readonly string[];
  /** Which unwind round dropped it (1-based). */
  readonly round: number;
  /** Compact descriptions of the blocking findings attributed to this unit. */
  readonly blocking: readonly string[];
  /** The overlap evidence the attribution stands on, plus any tiebreak used
   *  (Rule 19: a cause claim always names its evidence). */
  readonly evidence: string;
}

/** What ONE unwind round's re-verification of the remainder reported
 *  (4.4.8, #373): the tree verdict, the guardrail's own word when it ran,
 *  and the blocking findings it named, capped like a drop's evidence. */
export interface ContainmentReverify {
  /** The tree verification verdict of the unwound remainder. */
  readonly verdict: string;
  /** The guardrail's verdict word when the guardrail ran on the remainder. */
  readonly guardrailVerdict?: string;
  /** Compact descriptions of the blocking findings the re-verify reported
   *  (capped); `moreBlocking` counts the rest. */
  readonly blocking: readonly string[];
  readonly moreBlocking: number;
  /** The verification failure, when the remainder did not verify at all
   *  (an install failure, a floor red, infrastructure). */
  readonly failure?: string;
}

/** One executed unwind round (4.4.8, #373): the units it dropped with
 *  their attribution evidence, and what the re-verify of the remainder
 *  reported. Recorded whether the round led to a contained landing or to a
 *  refusal, so a refusal never discards what earlier rounds learned. */
export interface ContainmentRound {
  readonly round: number;
  readonly dropped: readonly ContainedDrop[];
  readonly reverify: ContainmentReverify;
}

/**
 * Guardrail-red containment (4.4.7): when the FINAL guardrail over the
 * landed head is red, the runner attributes each blocking finding to the
 * order whose envelope and committed diff overlap it, reverts the
 * attributed orders, re-verifies (install + floor) and re-runs the
 * guardrail on the remainder, bounded to a small disclosed number of
 * rounds. A red that attributes to NO order, is ambiguous, or survives the
 * bound REFUSES containment (the branch is restored and the run follows
 * the plain guardrail-red salvage policy): never a guess, never an
 * unexplained red landed.
 */
export interface GuardrailContainment {
  /** The disclosed bound on unwind rounds. */
  readonly maxRounds: number;
  /** Rounds actually executed (0 when refused before any unwind). */
  readonly rounds: number;
  /** The dropped units of a CONTAINED attempt (what is missing from the
   *  landing set); empty when containment was refused, because every
   *  revert already made was restored and nothing is dropped from the
   *  landed tree. A refusal's per-round drops live in `roundEvidence`. */
  readonly dropped: readonly ContainedDrop[];
  /** Every executed round in order, contained or refused (4.4.8, #373):
   *  what each dropped, on what evidence, and what its re-verify reported.
   *  `rounds === roundEvidence.length`. Empty when refused before any
   *  unwind (the refusal then names the finding it could not attribute). */
  readonly roundEvidence: readonly ContainmentRound[];
  /** Present when containment was attempted and REFUSED, with the reason;
   *  the run then completes guardrail-red exactly as before this feature. */
  readonly refused?: string;
  /** The round the refusal happened in (1-based): the round whose
   *  attribution, unwind or re-verify refused, or the bound when the red
   *  outlived every round. Absent when the refusal preceded any round (the
   *  kept units could not be reconstructed). */
  readonly refusedAtRound?: number;
  /** True when the refusal's branch RESTORE itself failed: HEAD is then a
   *  half-unwound tree no verification ever saw, so the executor must not
   *  push it as a salvage draft; the branch stays local for inspection
   *  (the refusal note says so). */
  readonly restoreFailed?: true;
}
