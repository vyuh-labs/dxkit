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
import type { BlockingFinding, GuardrailGateResult } from '../lanes/verify';
import type { VerifyTreeResult } from '../lanes/verify-tree';
import { detectActiveLanguages, dependencyManifestFilesIn } from '../languages';
import { pathInEnvelope } from './recipes/envelope';
import type { RecipePhaseSummary } from './recipes/run-recipes';
import { verifyCommittedHead } from './verify';
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import type {
  ContainedDrop,
  GuardrailContainment,
  OrderRunRecord,
  RemediateGit,
  RemediateRunOptions,
} from './outcome';
import type { WorkOrder, WorkOrderEnvelope } from './work-orders/types';

/** The bound on unwind rounds: small and disclosed, never open-ended. */
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

/** One kept unit of the landed head: a kept agent order, or the kept
 *  recipe group as a whole (the 4.4.6 drop granularity). */
export interface KeptUnit {
  readonly unit: 'agent-order' | 'recipe-group';
  readonly orderIds: readonly string[];
  /** The unit's commit range on the branch (`from..to`). */
  readonly from: string;
  readonly to: string;
  /** Repo-relative paths the unit's commits changed. */
  readonly diffPaths: readonly string[];
  /** The order's envelope (agent orders; the recipe group attributes on
   *  its committed diff alone). */
  readonly envelope?: WorkOrderEnvelope;
  /** Packages the order's findings name (dep-advisory evidence). */
  readonly packages: ReadonlySet<string>;
  /** The driver reported this order's run failed or was cut short; its
   *  committed partial verified, but it is first in line for attribution. */
  readonly driverFailed: boolean;
}

export interface ContainmentArgs {
  readonly git: RemediateGit;
  readonly baseHead: string;
  /** HEAD after the recipe tier (the chain sanity check needs it). */
  readonly agentBase: string;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
  readonly recipes: RecipePhaseSummary;
  readonly records: readonly OrderRunRecord[];
  /** The dispatched work orders, by id (envelope + package evidence). */
  readonly ordersById: ReadonlyMap<string, WorkOrder>;
  /** The red final-guardrail result being contained. */
  readonly guardrail: GuardrailGateResult;
  readonly isManifestPath: (p: string) => boolean;
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

/** Overlap evidence between one blocking finding and one kept unit, or
 *  null when they do not overlap. */
export function overlapEvidence(
  f: BlockingFinding,
  u: KeptUnit,
  isManifestPath: (p: string) => boolean,
): string | null {
  if (f.package !== undefined && u.packages.has(f.package)) {
    return `the order names package ${f.package}`;
  }
  if (f.file !== undefined) {
    if (u.diffPaths.includes(f.file)) return `the committed diff touches ${f.file}`;
    if (u.envelope && pathInEnvelope(f.file, u.envelope)) {
      return `${f.file} is inside the order envelope`;
    }
    return null;
  }
  if (f.package !== undefined) {
    // A package-shaped finding with no file: any unit that changed the
    // dependency graph is a candidate (a pin can pull a transitive
    // advisory in), narrowed below by the package-name and driver tiers.
    if (u.diffPaths.some(isManifestPath)) return 'the committed diff touches a dependency manifest';
    if (u.envelope?.manifests === true) return 'the order envelope allows manifest changes';
    return null;
  }
  return null;
}

export type FindingAttribution =
  | { readonly kind: 'attributed'; readonly unit: KeptUnit; readonly evidence: string }
  | { readonly kind: 'ambiguous'; readonly units: readonly KeptUnit[] }
  | { readonly kind: 'unattributed' };

/**
 * Attribute ONE blocking finding to ONE kept unit, or say why it cannot be
 * (Rule 19). Narrowing ladder on ambiguity: the unit(s) naming the
 * finding's package first, then a driver-failed unit over verified ones.
 */
export function attributeFinding(
  f: BlockingFinding,
  units: readonly KeptUnit[],
  isManifestPath: (p: string) => boolean,
): FindingAttribution {
  const candidates = units
    .map((u) => ({ u, evidence: overlapEvidence(f, u, isManifestPath) }))
    .filter((c): c is { u: KeptUnit; evidence: string } => c.evidence !== null);
  if (candidates.length === 0) return { kind: 'unattributed' };
  let pool = candidates;
  const notes: string[] = [];
  const pkg = f.package;
  if (pool.length > 1 && pkg !== undefined) {
    const named = pool.filter((c) => c.u.packages.has(pkg));
    if (named.length > 0 && named.length < pool.length) {
      pool = named;
      notes.push(`narrowed to the order(s) naming package ${pkg}`);
    }
  }
  if (pool.length > 1) {
    const failed = pool.filter((c) => c.u.driverFailed);
    if (failed.length > 0 && failed.length < pool.length) {
      pool = failed;
      notes.push('driver-failed order preferred over verified ones (the ambiguity tiebreak)');
    }
  }
  if (pool.length === 1) {
    return {
      kind: 'attributed',
      unit: pool[0].u,
      evidence: [pool[0].evidence, ...notes].join('; '),
    };
  }
  return { kind: 'ambiguous', units: pool.map((c) => c.u) };
}

function packagesOf(order: WorkOrder): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of order.findings) {
    if (f.evidence.type === 'dep-vuln') out.add(f.evidence.package);
  }
  return out;
}

/**
 * Reconstruct the kept units' commit ranges from the chained kept
 * dispositions (each drop reset to the previously verified head, so the
 * kept heads chain from `baseHead` to the verified head). A chain that
 * does not close is a string (the refusal reason): containment never
 * reverts ranges it cannot trust.
 */
export function buildKeptUnits(c: ContainmentArgs): KeptUnit[] | string {
  const units: KeptUnit[] = [];
  let prev = c.baseHead;
  const gv = c.recipes.groupVerification;
  if (gv?.kind === 'kept') {
    const appliedIds = c.recipes.records
      .filter((r) => r.outcome.kind === 'applied')
      .map((r) => r.orderId);
    units.push({
      unit: 'recipe-group',
      orderIds: appliedIds,
      from: prev,
      to: gv.head,
      diffPaths: c.git.changedPaths(prev, gv.head),
      packages: new Set(),
      driverFailed: false,
    });
    prev = gv.head;
  } else if (gv === undefined && c.agentBase !== c.baseHead) {
    return (
      'recipe commits exist without a per-group verification record, so the per-order ' +
      'commit ranges cannot be reconstructed'
    );
  }
  for (const rec of c.records) {
    if (rec.disposition?.kind !== 'kept') continue;
    const order = c.ordersById.get(rec.orderId);
    if (!order) {
      return `no work order is in scope for kept record ${rec.orderId}, so its range cannot be attributed`;
    }
    units.push({
      unit: 'agent-order',
      orderIds: [rec.orderId],
      from: prev,
      to: rec.disposition.head,
      diffPaths: c.git.changedPaths(prev, rec.disposition.head),
      envelope: order.envelope,
      packages: packagesOf(order),
      driverFailed: rec.outcome === 'failed' || rec.outcome === 'partial',
    });
    prev = rec.disposition.head;
  }
  const head = c.git.head();
  if (prev !== head) {
    return (
      `the kept orders' commit chain ends at ${prev} but the verified head is ${head}, ` +
      'so the per-order ranges cannot be trusted'
    );
  }
  return units;
}

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
    if (c.git.head() !== originalHead) {
      try {
        c.git.resetTo(originalHead);
      } catch (err) {
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
