/**
 * Required-observation semantics (4.4.1 WP1, strategy §7.1).
 *
 * The gate's product promise is "refuse to certify what was not seen".
 * Before this module, that held for attribution (Rule 19's refusal tier)
 * but not for OBSERVATION: a check that never ran was disclosed as a
 * skip, yet the verdict word stayed whatever the findings earned — a
 * skipped correctness floor was arithmetically indistinguishable from a
 * passing one at the exit code.
 *
 * This module is the ONE evaluator of the question "was every REQUIRED
 * check observed?", answered as a list of `RequiredObservationGap`s.
 * A non-empty answer joins the existing refusal tier: the one verdict
 * derivation (`verdictWordFrom` in `check-renderers.ts`) turns any gap
 * into `CANNOT GATE`, exactly as it does for attribution gaps — never a
 * silent pass, never a false BLOCK (the developer is not blamed; the
 * missing evidence is named, with its remedy).
 *
 * What can be required, and who evaluates it (ownership, not surface
 * forks — a surface only answers for checks it OWNS the execution of):
 *
 * - `custom:<name>` — a policy-declared check with `required: true`.
 *   Evaluated by the gate ENGINE (both `gate` and `guardrail check`
 *   run user checks through the Rule-17 seam). Default: not required —
 *   an unavailable optional check keeps today's behavior (disclosed
 *   skip, `not_observed` classification, verdict untouched).
 * - `floor` — the correctness floor, `policy.floor.required` (default
 *   TRUE). Evaluated by the surfaces that OWN floor execution over a
 *   whole tree: the `gate` CLI (and through it `gate --workspace`).
 *   The loop Stop-gate / pre-push / CI floor surfaces deliberately keep
 *   their Rule-15 doctrine (fail-open on infrastructure, CI as the
 *   backstop) — a slow toolchain must not wedge an unattended loop, and
 *   those surfaces have a backstop behind them; the one-shot gate has
 *   none, which is why it defaults to refusal.
 *
 * Bias discipline: a gap is only minted for a check that was DECLARED
 * required and demonstrably not observed. A floor that ran and found
 * zero applicable checks (a docs-only tree, no pack declares a
 * runnable floor) counts as OBSERVED-vacuous — refusing there would
 * false-refuse trivial trees. dxkit never invents a requirement.
 */

import type { BrownfieldPolicy } from '../baseline/policy';
import type { CustomChecksUnobserved } from '../analyzers/custom-checks/gather';
import { normalizeCustomChecks } from '../analyzers/custom-checks/config';

/** One required check whose observation is missing — the refusal unit.
 *  Consumed by the verdict derivation, all three renderers, and the
 *  verdict.v1 `refusals` array. */
export interface RequiredObservationGap {
  /** `'floor'` or `custom:<name>` — the required-check vocabulary. */
  readonly checkId: string;
  /** Why the observation is missing (embeds the recorded skip cause). */
  readonly reason: string;
  /** The named way out — consent, config, or mode change. */
  readonly remedy: string;
}

/** Names of policy checks declared `required: true` (trimmed, in policy
 *  order). Pure over the policy document. */
export function requiredCustomCheckNames(policy: BrownfieldPolicy): readonly string[] {
  return (policy.checks ?? [])
    .filter((c) => c.required === true)
    .map((c) => (typeof c.name === 'string' ? c.name.trim() : ''))
    .filter((n) => n.length > 0);
}

/**
 * Gaps for required CUSTOM checks. Sound because the three ways a
 * declared check can go unobserved are all visible from the inputs:
 *
 * 1. it never became a runnable spec (invalid entry dropped by the ONE
 *    normalizer — a config typo must not silently disarm a required
 *    check);
 * 2. the seam recorded it unobserved (skipped-untrusted / -environment
 *    / -unavailable / -timeout / -overflow), or the gather itself did
 *    not run;
 * 3. the mode excluded the `custom-check` kind from gating entirely
 *    (ref-based — the throwaway prior worktree lacks the toolchain, so
 *    the kind cannot be diffed honestly).
 *
 * A required check that is a valid spec, not recorded unobserved, and
 * whose kind gates in this mode was observed (pass or fail — either
 * way the gate SAW it), so no gap is minted.
 */
export function requiredCustomCheckGaps(
  policy: BrownfieldPolicy,
  unobserved: CustomChecksUnobserved | undefined,
  refExcludedKinds: ReadonlyArray<{ readonly kind: string }>,
): RequiredObservationGap[] {
  const required = requiredCustomCheckNames(policy);
  if (required.length === 0) return [];

  // Ref-based mode cannot gate the kind at all: every required check is a
  // structural gap, remedy = the mode that can.
  if (refExcludedKinds.some((k) => k.kind === 'custom-check')) {
    return required.map((name) => ({
      checkId: `custom:${name}`,
      reason: `required check "${name}" cannot be gated in ref-based mode (the prior side is a bare worktree without the repo's toolchain)`,
      remedy:
        'switch to a committed baseline mode (`baseline.mode: "committed-full"`) to gate required checks, or drop `required: true`',
    }));
  }

  // The ONE normalizer decides which declared entries are runnable specs —
  // the same adapter the seam itself uses, so this cannot diverge from
  // what actually ran.
  const specNames = new Set(normalizeCustomChecks(policy.checks).specs.map((s) => s.name));
  const gaps: RequiredObservationGap[] = [];
  for (const name of required) {
    if (!specNames.has(name)) {
      gaps.push({
        checkId: `custom:${name}`,
        reason: `required check "${name}" is not a runnable check (the entry is invalid and was dropped at normalization)`,
        remedy: 'fix the check entry in `.dxkit/policy.json` (see `vyuh-dxkit checks list`)',
      });
      continue;
    }
    if (unobserved === undefined || !unobserved.gathered) {
      gaps.push({
        checkId: `custom:${name}`,
        reason: `required check "${name}" was not observed: ${
          unobserved && !unobserved.gathered ? unobserved.reason : 'custom checks did not run'
        }`,
        remedy: 'run in a mode/scope that executes custom checks, or drop `required: true`',
      });
      continue;
    }
    const record = unobserved.checks.find((c) => c.name === name);
    if (record !== undefined) {
      gaps.push({
        checkId: `custom:${name}`,
        reason: `required check "${name}" was not observed (${record.status}${
          record.reason ? `: ${record.reason}` : ''
        })`,
        remedy: remedyForSkipStatus(record.status),
      });
    }
  }
  return gaps;
}

/** The per-cause way out, phrased once. */
function remedyForSkipStatus(status: string): string {
  switch (status) {
    case 'skipped-untrusted':
      return 'pass --trusted to consent to executing the tree’s declared commands, or drop `required: true`';
    case 'skipped-environment':
      return 'provision the toolchain the check declares (see the disclosed requirement), or drop `required: true`';
    case 'skipped-unavailable':
      return 'install the check’s command so it resolves on this machine, or drop `required: true`';
    default:
      return 'make the check observable on this surface (see its disclosed skip cause), or drop `required: true`';
  }
}

/** Is the correctness floor required for a certifiable verdict on the
 *  surfaces that own tree-level floor execution? Default TRUE — the
 *  §7.1 reversal. A policy opts out with `floor: { required: false }`. */
export function floorRequired(policy: BrownfieldPolicy): boolean {
  return policy.floor?.required ?? true;
}

/**
 * The floor's gap, minted by the gate CLI when the floor was SKIPPED
 * with a cause (untrusted today) while `floor.required` holds. A floor
 * that ran — even vacuously — is observed and mints nothing.
 */
export function floorRequiredGap(
  policy: BrownfieldPolicy,
  skip: { readonly cause: string; readonly detail: string } | undefined,
): RequiredObservationGap | undefined {
  if (skip === undefined || !floorRequired(policy)) return undefined;
  return {
    checkId: 'floor',
    reason: `the correctness floor is required but did not run (${skip.cause}): ${skip.detail}`,
    remedy:
      skip.cause === 'untrusted'
        ? 'pass --trusted to consent to running the tree’s compile + tests, or set `floor: { "required": false }` in the policy'
        : 'make the floor runnable here (see the disclosed cause), or set `floor: { "required": false }` in the policy',
  };
}
