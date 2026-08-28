/**
 * Guardrail-red containment per order (4.4.7, defect A2).
 *
 * Per-order verification (4.4.6) is install + floor only; the guardrail
 * arbitrates ONCE over the final combined tree. The live class: one
 * agent-tier order left an in-envelope dependency pin whose advisory
 * re-keyed as "added", the final guardrail went red, and the WHOLE run
 * flipped to salvage-draft, dragging nine verified green recipe pins down
 * with it. The unit of landing is the order, so a run-level guardrail
 * verdict must not break that containment.
 *
 * The engine, invoked by `orders-complete.ts` when the final guardrail RAN
 * and did not pass:
 *
 *   1. ATTRIBUTE each blocking finding to exactly one kept unit (a kept
 *      agent order, or the kept recipe group as one unit, the 4.4.6 drop
 *      granularity), on overlap evidence: the unit names the finding's
 *      package, its committed diff touches the finding's file, the file is
 *      inside the order's envelope, or (for a package-shaped finding) the
 *      unit changed a dependency manifest. Ambiguity narrows first to the
 *      unit(s) naming the package, then to a DRIVER-FAILED unit over
 *      verified ones (the driver-failure hygiene policy: a driver-failed
 *      order's committed partial is the first candidate). Rule 19: this is
 *      a CAUSE claim: a finding that overlaps no unit, or stays ambiguous,
 *      REFUSES containment for the whole run; an innocent order is never
 *      dropped on a guess.
 *   2. UNWIND the attributed units: each unit's commit range is reverted as
 *      one commit at the tip (`RemediateGit.revertRange`, the per-order
 *      revert granularity from 4.4.6, lifted off the tip so later kept
 *      commits survive). A revert conflict refuses containment and
 *      restores the branch.
 *   3. RE-VERIFY the remainder through the ONE tree verification
 *      (`verifyCommittedHead`: install + floor + the guardrail, the same
 *      seam the run-level check uses, never a second invocation path).
 *      Verified: contained. Still guardrail-red: another round, bounded by
 *      `MAX_CONTAINMENT_ROUNDS` (small, disclosed). Anything else
 *      (install-failed, floor-red, infrastructure): the unwound remainder
 *      no longer verifies: refuse and restore.
 *
 * A refusal ALWAYS restores the branch to the pre-containment head, so the
 * plain guardrail-red path (salvage draft of the full attempt, negative
 * constraints for the next run) sees exactly the tree it always saw.
 */
import type { GuardrailGateResult } from '../lanes/verify';
import type { VerifyTreeResult } from '../lanes/verify-tree';
import { detectActiveLanguages, dependencyManifestFilesIn } from '../languages';
import type { RecipePhaseSummary } from './recipes/run-recipes';
import { verifyCommittedHead } from './verify';
import type {
  ContainedDrop,
  GuardrailContainment,
  OrderRunRecord,
  RemediateRunOptions,
} from './outcome';
import {
  attributeFinding,
  buildKeptUnits,
  type ContainmentArgs,
  type KeptUnit,
} from './containment-attribution';

// The attribution half lives in `./containment-attribution` (module-size
// split); re-exported so consumers keep one import surface.
export {
  attributeFinding,
  buildKeptUnits,
  overlapEvidence,
  type ContainmentArgs,
  type FindingAttribution,
  type KeptUnit,
  type OverlapEvidence,
} from './containment-attribution';

/**
 * The bound on unwind rounds: small and disclosed, never open-ended. A
 * known consequence of the per-round reverts: two kept units sharing
 * lockfile hunks will usually CONFLICT on the round-2 revert of the
 * second unit (round 1 already rewrote the shared hunks), and that
 * conflict refuses containment honestly, a bounded refusal rather than a
 * mangled tree. A future refinement could attribute ALL blocking findings
 * first and drop every attributed unit in a single round across tiers,
 * avoiding the sequential-revert conflict; deliberately not implemented
 * here.
 */
export const MAX_CONTAINMENT_ROUNDS = 2;

/** Cap on blocking-finding descriptions carried per dropped unit. */
const DROP_EVIDENCE_CAP = 5;

/**
 * The lazy pack-declared manifest-path probe both the orders phase and the
 * containment engine consult (Rule 6: manifest patterns come from the
 * packs). `injected` is the test seam; production derives from the active
 * packs on first use.
 */
export function manifestPathProbe(
  cwd: string,
  injected?: (p: string) => boolean,
): (p: string) => boolean {
  let probe = injected;
  return (p: string): boolean => {
    if (!probe) {
      const packs = detectActiveLanguages(cwd);
      probe = (x) => dependencyManifestFilesIn([x], packs).length > 0;
    }
    return probe(p);
  };
}

export type ContainmentOutcome =
  | {
      readonly kind: 'contained';
      readonly containment: GuardrailContainment;
      /** Records with the attributed orders' dispositions flipped to
       *  `dropped` at step `guardrail`. */
      readonly records: readonly OrderRunRecord[];
      /** The recipe summary, group verification flipped when the group was
       *  dropped by containment. */
      readonly recipes: RecipePhaseSummary;
      /** The final round's verification of the remainder. */
      readonly verified: VerifyTreeResult;
      readonly guardrail: GuardrailGateResult;
      readonly head: string;
    }
  | { readonly kind: 'refused'; readonly containment: GuardrailContainment };

function containmentReason(blocking: readonly string[], round: number): string {
  const shown = blocking.slice(0, DROP_EVIDENCE_CAP);
  const more = blocking.length - shown.length;
  return (
    `the final guardrail attributed blocking finding(s) to this order ` +
    `(containment round ${round}): ${shown.join('; ')}` +
    (more > 0 ? `; and ${more} more` : '')
  );
}

/**
 * Contain a red final guardrail: attribute, unwind, re-verify, bounded.
 * Never throws; a refusal restores the branch and carries the reason.
 */
export async function containGuardrailRed(
  opts: RemediateRunOptions,
  c: ContainmentArgs,
): Promise<ContainmentOutcome> {
  const originalHead = c.git.head();
  let roundsRun = 0;
  const allDrops: ContainedDrop[] = [];
  let recipeGroupDropped: { reason: string; orderIds: readonly string[] } | undefined;

  const refuse = (reason: string): ContainmentOutcome => {
    let restoreNote = '';
    let restoreFailed = false;
    if (c.git.head() !== originalHead) {
      try {
        c.git.resetTo(originalHead);
      } catch (err) {
        restoreFailed = true;
        restoreNote =
          `; restoring the branch to ${originalHead} also failed ` +
          `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}), the branch ` +
          'is left as-is for inspection';
      }
    }
    return {
      kind: 'refused',
      containment: {
        maxRounds: MAX_CONTAINMENT_ROUNDS,
        rounds: roundsRun,
        dropped: [],
        refused: reason + restoreNote,
        ...(restoreFailed ? { restoreFailed: true } : {}),
      },
    };
  };

  const built = buildKeptUnits(c);
  if (typeof built === 'string') return refuse(built);
  let units = built;
  if (units.length === 0) return refuse('no kept order exists to attribute the red to');

  let guardrail = c.guardrail;
  let lastVerified: VerifyTreeResult | undefined;
  for (let round = 1; round <= MAX_CONTAINMENT_ROUNDS; round++) {
    const blocking = guardrail.blockingFindings ?? [];
    if (blocking.length === 0) {
      return refuse(
        `the guardrail is red (${guardrail.verdict}) but reported no attributable blocking ` +
          "findings (a refusal-tier verdict is never an order's fault)",
      );
    }
    // Every blocking finding must attribute to exactly one unit, or the
    // whole containment refuses: an unattributable finding would keep the
    // remainder red anyway, and dropping on a guess blames an innocent
    // order (Rule 19).
    const perUnit = new Map<KeptUnit, { blocking: string[]; evidence: Set<string> }>();
    for (const f of blocking) {
      const a = attributeFinding(f, units, c.isManifestPath);
      if (a.kind === 'unattributed') {
        return refuse(
          `blocking finding ${f.description} overlaps no kept order's envelope or committed ` +
            'diff, so it cannot be attributed and no order is dropped',
        );
      }
      if (a.kind === 'ambiguous') {
        const ids = a.units.map((u) => u.orderIds.join('+')).join(', ');
        return refuse(
          `blocking finding ${f.description} is ambiguous between ${ids}, so it cannot be attributed ` +
            'to one order, so none is dropped',
        );
      }
      const bucket = perUnit.get(a.unit) ?? { blocking: [], evidence: new Set<string>() };
      bucket.blocking.push(f.description);
      bucket.evidence.add(a.evidence);
      perUnit.set(a.unit, bucket);
    }
    const roundDrops = [...perUnit.keys()];
    if (roundDrops.length === units.length) {
      return refuse(
        'every kept order attributed to the red: nothing would remain to land, so the run ' +
          'follows the plain guardrail-red policy',
      );
    }
    // Unwind, newest range first (minimizes revert conflicts).
    const chainIndex = new Map(units.map((u, i) => [u, i] as const));
    for (const u of [...roundDrops].sort(
      (a, b) => (chainIndex.get(b) ?? 0) - (chainIndex.get(a) ?? 0),
    )) {
      try {
        c.git.revertRange(
          u.from,
          u.to,
          `revert(containment): drop ${u.orderIds.join(', ')} (final guardrail attributed ` +
            'blocking findings to this order; see the run ledger)',
        );
      } catch (err) {
        return refuse(
          `reverting ${u.orderIds.join(', ')} conflicted ` +
            `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}), so the ` +
            'unwound remainder cannot be reconstructed',
        );
      }
    }
    roundsRun = round;
    for (const u of roundDrops) {
      const bucket = perUnit.get(u)!;
      allDrops.push({
        unit: u.unit,
        orderIds: u.orderIds,
        round,
        blocking: bucket.blocking,
        evidence: [...bucket.evidence].join('; '),
      });

      if (u.unit === 'recipe-group') {
        recipeGroupDropped = {
          reason: containmentReason(bucket.blocking, round),
          orderIds: u.orderIds,
        };
      }
    }
    units = units.filter((u) => !perUnit.has(u));

    // Re-verify the remainder through the ONE tree verification: install +
    // floor + the guardrail, the same seam the run-level check used.
    const { verified, guardrail: reGuardrail } = await verifyCommittedHead(opts, {
      head: c.git.head(),
      baseHead: c.baseHead,
      entryFloor: c.entryFloor,
      runFloor: c.runFloor,
    });
    lastVerified = verified;
    if (verified.verdict === 'verified') {
      const dropByOrder = new Map<string, ContainedDrop>();
      for (const d of allDrops) for (const id of d.orderIds) dropByOrder.set(id, d);
      const records = c.records.map((rec) => {
        const d = rec.disposition?.kind === 'kept' ? dropByOrder.get(rec.orderId) : undefined;
        if (!d || d.unit !== 'agent-order') return rec;
        return {
          ...rec,
          disposition: {
            kind: 'dropped' as const,
            step: 'guardrail' as const,
            reason: containmentReason(d.blocking, d.round),
          },
        };
      });
      const rg = recipeGroupDropped;
      const recipes: RecipePhaseSummary = rg
        ? {
            ...c.recipes,
            groupVerification: {
              kind: 'dropped',
              step: 'guardrail',
              reason: rg.reason,
              droppedOrderIds: rg.orderIds,
            },
            records: c.recipes.records.map((r) =>
              r.outcome.kind === 'applied'
                ? {
                    ...r,
                    disposition: {
                      kind: 'dropped' as const,
                      step: 'guardrail' as const,
                      reason: rg.reason,
                    },
                  }
                : r,
            ),
          }
        : c.recipes;
      return {
        kind: 'contained',
        containment: { maxRounds: MAX_CONTAINMENT_ROUNDS, rounds: roundsRun, dropped: allDrops },
        records,
        recipes,
        verified,
        guardrail: reGuardrail,
        head: c.git.head(),
      };
    }
    if (verified.verdict === 'guardrail-red' && reGuardrail.ran) {
      guardrail = reGuardrail;
      continue;
    }
    return refuse(
      `the remainder no longer verifies after the unwind (verification ended ` +
        `'${verified.verdict}'${verified.failure ? `: ${verified.failure.message}` : ''})`,
    );
  }
  const lastWord = lastVerified?.guardrail?.verdict ?? 'red';
  return refuse(
    `the guardrail stayed red (${lastWord}) after ${MAX_CONTAINMENT_ROUNDS} unwind round(s); ` +
      'the bound is deliberate; the run follows the plain guardrail-red policy',
  );
}
