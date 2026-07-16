/**
 * Attribution gaps — the ONE value that carries "dxkit could not answer" from
 * the classifier to the verdict, so an observation gap on the policy's block
 * rules can never render as PASSED.
 *
 * # Why this exists (the class it closes)
 *
 * Rule 19 (recall attribution) demotes a drifted kind's net-new findings to
 * `tooling_drift` — warn, never block — because a tool change is not the
 * developer's mistake. Correct for the generic gate; catastrophic for the
 * block RULES: every baseline written before recall attribution existed reads
 * as drifted for every kind, so on upgrade day the demotion disarmed all eight
 * block rules at once — three live credentials exited 0 under a PASSED banner
 * on a real repo (3.7.5 blocked the same tree). The mechanism was the closed
 * #20 config-drift bypass, one status over: `config_drift` got the block-rule
 * carve-out in v3.0.0, `tooling_drift` did not.
 *
 * The carve-out is NOT the right fix here, though: `config_drift` keeps
 * blocking because a policy edit cannot create phantom findings, but recall
 * drift is real evidence that the delta may not be the developer's — blocking
 * would misattribute (the exact false-block Rule 19 exists to kill). Neither
 * BLOCKED nor PASSED is true. The honest verdict is the third one dxkit
 * already knows how to give: the identity-scheme guard refuses to gate across
 * a scheme change, names the gap, and states the remedy. This module gives
 * recall drift the same treatment, scoped to the findings where it matters —
 * a drifted finding an armed block rule would have tested.
 *
 * # The contract
 *
 *   - The classifier records `unattributableBlockRule` on any pair demoted by
 *     recall drift that an armed block rule covers (evaluated through the ONE
 *     `evaluateBlockRules` — no second kind↔rule table to diverge, CLAUDE.md
 *     2.30).
 *   - `collectAttributionGaps` aggregates those pairs per kind, attaching the
 *     drift evidence (which input moved, old → new).
 *   - `GuardrailCheckResult.attributionGaps` is a REQUIRED field, and the one
 *     verdict derivation (`verdictCounts` / `verdictWordFrom`) consumes it:
 *     while a gap exists the verdict is `CANNOT GATE` and the exit code is 1.
 *     A renderer cannot print PASSED without going through that derivation.
 *
 * Fail-closed, never wedged: the remedy is one command, and an allowlisted
 * finding (reviewed and accepted) never contributes a gap.
 */

import type { RecallDrift } from './recall';
import { describeRecallDrift } from './recall';

/** One kind whose block-rule-class findings cannot be attributed this run. */
export interface AttributionGap {
  /** The finding kind (an `IdentityKind` — typed structurally to keep this
   *  module import-light and cycle-free). */
  readonly kind: string;
  /** The block rules that would have tested the demoted findings, sorted. */
  readonly rules: ReadonlyArray<string>;
  /** How many findings of this kind were demoted out of block-rule reach. */
  readonly findingCount: number;
  /** The recall-drift evidence for this kind (which input moved, old → new).
   *  Absent only defensively — a gap always originates from a drifted kind. */
  readonly drift?: RecallDrift;
}

/** The minimal pair shape the collector reads — structural, so this module
 *  never imports `check.ts` (which imports it). */
interface GapSourcePair {
  readonly kind: string;
  readonly classification: { readonly unattributableBlockRule?: string };
  readonly suppressedByAllowlist?: unknown;
}

/**
 * Aggregate the classifier's per-pair `unattributableBlockRule` markers into
 * per-kind gaps, attaching each kind's drift evidence. An allowlist-suppressed
 * pair is excluded — a reviewed-and-accepted finding is an answered question,
 * not a gap. Pure; order is stable (kinds sorted).
 */
export function collectAttributionGaps(
  pairs: ReadonlyArray<GapSourcePair>,
  recallDrift: ReadonlyArray<RecallDrift>,
): AttributionGap[] {
  const byKind = new Map<string, { rules: Set<string>; count: number }>();
  for (const p of pairs) {
    const rule = p.classification.unattributableBlockRule;
    if (rule === undefined || p.suppressedByAllowlist !== undefined) continue;
    const entry = byKind.get(p.kind) ?? { rules: new Set<string>(), count: 0 };
    entry.rules.add(rule);
    entry.count += 1;
    byKind.set(p.kind, entry);
  }
  const driftByKind = new Map(recallDrift.map((d) => [d.kind as string, d]));
  return [...byKind.keys()].sort().map((kind) => {
    const entry = byKind.get(kind)!;
    const drift = driftByKind.get(kind);
    return {
      kind,
      rules: [...entry.rules].sort(),
      findingCount: entry.count,
      ...(drift ? { drift } : {}),
    };
  });
}

/** Human one-liner for a gap, shared by every renderer (Rule 2). */
export function describeAttributionGap(gap: AttributionGap): string {
  const findings = `${gap.findingCount} finding${gap.findingCount === 1 ? '' : 's'}`;
  const rules = gap.rules.join(', ');
  const evidence = gap.drift
    ? describeRecallDrift(gap.drift)
    : `${gap.kind}: recall drifted for this kind`;
  return (
    `${findings} covered by block rule${gap.rules.length === 1 ? '' : 's'} ${rules} ` +
    `cannot be attributed — ${evidence}`
  );
}

/** The remedy every gap shares — one string so the three renderers agree. The
 *  gate stays refused (exit 1, never PASSED) until attribution is restored. */
export const ATTRIBUTION_GAP_REMEDY =
  'run `vyuh-dxkit update` (migrates + re-baselines) or `vyuh-dxkit baseline create --force` ' +
  'to restore attribution; the guardrail refuses to pass until then';
