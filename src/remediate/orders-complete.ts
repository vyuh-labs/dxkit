/**
 * Completion of an order-driven agent run — the post-dispatch half of the
 * orders phase, split from `orders-phase.ts` at the module-size bar
 * (the recipe tier's `complete.ts` precedent): the no-diff outcome arms
 * (dead CLI, all-failed, the recipes-refused starvation guard, the honest
 * no-op), the ONE tree verification of the combined head, the per-order
 * done disclosure through `floorOrderDone` (the same computation the
 * Stop-gate's floor arm reads, Rule 2.30), and the verdict mapping shared
 * with the legacy tail via the `verify.ts` phrasing helpers.
 */
import { floorOrderDone } from '../loop/order-scope';
import type {
  AgentEnvelope,
  OrderRunRecord,
  OrdersPhaseSummary,
  RemediateResult,
  RemediateRunOptions,
} from './outcome';
import type { OrdersPhaseArgs } from './orders-phase';
import {
  guardrailRedNote,
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
} from './verify';
import type { WorkOrder } from './work-orders/types';

type Partial_ = Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>;

/** What the dispatch loop accumulated — everything the completion needs. */
export interface OrdersRunState {
  readonly summary: OrdersPhaseSummary;
  readonly envelope: AgentEnvelope;
  readonly records: readonly OrderRunRecord[];
  readonly dispatchList: readonly WorkOrder[];
  readonly scrubbed: readonly string[];
  readonly lastTail: string;
  readonly partial: boolean;
  readonly anyCompleted: boolean;
}

export async function completeOrdersRun(
  opts: RemediateRunOptions,
  args: OrdersPhaseArgs,
  state: OrdersRunState,
): Promise<Partial_> {
  const { summary, envelope, records, dispatchList, scrubbed, lastTail, partial, anyCompleted } =
    state;
  const evidenceTail = lastTail ? { transcriptTail: lastTail } : {};
  const hasDiff = args.git.hasDiff(args.baseHead);
  const hasRecipeCommits = args.agentBase !== args.baseHead;
  if (!hasDiff) {
    const neverRanOnly =
      records.length > 0 &&
      records.every((r) => r.outcome === 'never-ran' || r.outcome === 'not-dispatched');
    if (neverRanOnly) {
      return {
        outcome: 'agent-never-ran',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...evidenceTail,
        note: `agent never ran: ${records.find((r) => r.outcome === 'never-ran')?.detail ?? 'see the order records'}`,
      };
    }
    if (!anyCompleted && !partial) {
      return {
        outcome: 'agent-failed',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...evidenceTail,
        note:
          'every dispatched order ended in an error and produced no committed change. ' +
          'Nothing to verify; nothing lands' +
          (hasRecipeCommits
            ? ' (the recipe commits stay on the branch, unlanded, for the next attempt)'
            : '') +
          '.',
        baseHead: args.baseHead,
        head: args.git.head(),
      };
    }
    if (!hasRecipeCommits) {
      // Starvation guard (the recipes-refused contract): when the queue
      // carried recipe orders the recipe tier already refused or failed,
      // a no-diff agent fallback must NOT read as a clean no-op — the
      // orders are still open, and a green outcome would let the
      // scheduled lane loop over them forever.
      const fallbackIds = args.queue.filter((o) => o.tier === 'recipe').map((o) => o.id);
      if (fallbackIds.length > 0) {
        return {
          outcome: 'recipes-refused',
          task: args.taskId,
          recipes: args.recipes,
          orders: summary,
          envelope,
          floor: args.entryFloor,
          ...evidenceTail,
          ...(partial ? { partial } : {}),
          note:
            `the recipe tier refused or failed these orders and the agent fallback landed ` +
            `nothing for them: ${fallbackIds.join(', ')}. The orders remain open — this run ` +
            'is not clean, so the scheduled lane surfaces it instead of looping green.',
          baseHead: args.baseHead,
          head: args.git.head(),
        };
      }
      return {
        outcome: 'no-op',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...evidenceTail,
        ...(scrubbed.length > 0 ? { scrubbedArtifacts: scrubbed } : {}),
        ...(partial ? { partial } : {}),
        note:
          scrubbed.length > 0
            ? 'the dispatched orders produced no committed change beyond regenerable dxkit ' +
              'scan state (dropped, disclosed below).'
            : 'the dispatched orders produced no committed change.',
        baseHead: args.baseHead,
        head: args.git.head(),
      };
    }
  }

  const head = args.git.head();
  const { verified, guardrail } = await verifyCommittedHead(opts, {
    head,
    baseHead: args.baseHead,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });

  // Per-order done, judged from the FINAL verified floor for floor-verifier
  // orders through the ONE `floorOrderDone` computation (the Stop-gate's
  // floor arm reads the same function, so the two cannot drift). Honest in
  // both directions: a check the verification did not observe (skipped,
  // absent, or a floor that did not run at all) yields UNDECIDED, never a
  // claimed closure; a guardrail-verifier order's closure is arbitrated by
  // the guardrail verdict below and the next plan — the ledger says so.
  const verifiedChecks = verified.floor?.checks;
  const byId = new Map(dispatchList.map((o) => [o.id, o] as const));
  const withDone = records.map((r) => {
    const order = byId.get(r.orderId);
    if (
      !order ||
      order.done.verifier !== 'floor' ||
      r.outcome === 'not-dispatched' ||
      verifiedChecks === undefined
    ) {
      return r;
    }
    const done = floorOrderDone(order.done.absentIds, verifiedChecks);
    return {
      ...r,
      doneAfterVerify: {
        closed: order.done.absentIds.length - done.open.length - done.undecided.length,
        open: done.open.length,
        undecided: done.undecided.length,
      },
    };
  });
  const finalSummary: OrdersPhaseSummary = { ...summary, records: withDone };

  const common = {
    task: args.taskId,
    recipes: args.recipes,
    orders: finalSummary,
    envelope,
    ...verificationDisclosures(verified, guardrail),
    baseHead: args.baseHead,
    head,
    ...evidenceTail,
    ...(scrubbed.length > 0 ? { scrubbedArtifacts: scrubbed } : {}),
    ...(partial ? { partial } : {}),
  };

  if (verified.verdict === 'install-failed') {
    return { outcome: 'install-failed', ...common, note: installFailedNote(verified) };
  }
  if (verified.verdict === 'floor-red') {
    return {
      outcome: 'floor-red',
      ...common,
      note:
        'the correctness floor has NET-NEW failures after the order dispatches (the entry ' +
        'floor did not have them) — nothing lands. An agent that breaks the build gets a ' +
        'truthful failure, never a PR.',
    };
  }
  if (!guardrail.ran || !guardrail.passesGate) {
    return {
      outcome: 'guardrail-red',
      ...common,
      note: guardrailRedNote(guardrail, args.effectiveSalvage),
    };
  }
  if (partial) {
    const salvage =
      args.effectiveSalvage === 'draft-pr'
        ? 'salvage policy: draft-pr — the verified partial work may land as a DRAFT.'
        : 'salvage policy: discard — the partial work is not landed (branch left for inspection).';
    return {
      outcome: 'budget-exhausted',
      ...common,
      note: `a budget cap cut the order dispatches short — the diff is verified. ${salvage}`,
    };
  }
  return { outcome: 'verified', ...common };
}
