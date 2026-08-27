/**
 * The order-driven agent phase (remediate rethink, section 3C): the agent
 * tier stops receiving open-ended task prompts. Each remaining agent-tier
 * order — including every recipe order the recipe tier refused or failed,
 * which falls through to here instead of dead-ending the run — is dispatched
 * ONE ORDER PER AGENT RUN, highest value first, up to
 * `remediate.maxOrdersPerRun`. Per dispatch:
 *
 *   1. the prompt is the rendered work order (findings + evidence +
 *      attribution split + envelope + constraints + done command;
 *      `renderWorkOrderPrompt` already appends the shared ground rules),
 *      plus the runner's budget note — and, when a prior attempt was
 *      guardrail-BLOCKED, its blocking set as a negative constraint;
 *   2. the driver budget IS the order's planner-derived budget (disclosed
 *      with its derivation), clamped to the run's remaining budget;
 *   3. the order's done criterion is written to `.dxkit/loop/order.json`
 *      (the ONE order-scope module the Stop-gate reads) before the spawn
 *      and cleared after, so "done" is verified in-session;
 *   4. tools are narrowed through the driver's declared mechanism (package
 *      manager installs are the frame's job), disclosed either way;
 *   5. after the run: leftover sweep, runtime-artifact scrub, then ENVELOPE
 *      ENFORCEMENT — committed changes outside the order's envelope (plus
 *      the always-allowed remediation notes file) are DROPPED WITH
 *      DISCLOSURE, so sprawl is unlandable by construction;
 *   6. the FRAME-OWNED INVARIANTS (4.4.6, `lanes/tree-invariants.ts`): every
 *      invariant the order's diff tripped is re-established by the frame
 *      (a manifest change re-runs the pack's resync, so an agent's hand
 *      edit to a lockfile is replaced by the tool's truth) and committed as
 *      the frame's own; one that cannot be re-established DROPS the order
 *      at that step, named;
 *   7. PER-ORDER VERIFICATION (4.4.6): the order's commits are verified
 *      (install + floor) on top of the previously verified head; a failing
 *      order is DROPPED (its commits reverted, the reason recorded) and the
 *      next order dispatches from the verified head. The unit of work is
 *      the order, so the unit of landing is the order.
 *
 * The landed head then goes through the ONE tree verification with the
 * guardrail as the final arbiter, exactly as the legacy path's does; the
 * outcome mapping shares the runner's phrasing helpers (`verify.ts`),
 * never a second copy. A run with kept AND dropped orders completes
 * `partially-landed`: non-clean, a PR for the kept set, the dropped orders
 * named as still open.
 *
 * Order-driven tasks are bounded (no score hinge by construction — the
 * catalog test pins that a class-selecting task declares none), so the
 * hinge tail lives only on the legacy path.
 */
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import { detectActiveLanguages, dependencyManifestFilesIn } from '../languages';
import {
  ORDER_TOKEN_ENV,
  clearOrderScope,
  newOrderScopeToken,
  writeOrderScope,
} from '../loop/order-scope';
import { completeOrdersRun } from './orders-complete';
import { budgetOverruns, budgetPromptNote } from './budget-notes';
import type { AgentRunResult, ResolvedModelChoice } from './driver';
import type { AgentDriver } from './driver';
import type {
  AgentEnvelope,
  OrderRunRecord,
  OrdersPhaseSummary,
  RemediateGit,
  RemediateResult,
  RemediateRunOptions,
} from './outcome';
import type { RemediateBudget } from './config';
import type { RecipePhaseSummary } from './recipes/run-recipes';
import { pathAllowedByEnvelope } from './recipes/envelope';
import { priorBlockingNote, resumePromptNote } from './resume';
import { REMEDIATION_NOTES_PATH, type RemediateTask } from './tasks';
import { resolveOrderToolPolicy } from './tool-policy';
import { renderWorkOrderPrompt } from './work-orders/render';
import type { WorkOrder } from './work-orders/types';
import type { TreeInvariantStep } from '../lanes/tree-invariants';
import { frameInvariantStep, frameInvariantsForEnvelope } from './frame-invariants';
import { placeOrder } from './order-placement';

type Partial_ = Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>;

export interface OrdersPhaseArgs {
  readonly taskId: RemediateTask['id'];
  /** The agent queue, plan (value) order, uncapped. */
  readonly queue: readonly WorkOrder[];
  /** Effective `remediate.maxOrdersPerRun` (> 0 here by construction). */
  readonly cap: number;
  readonly driver: AgentDriver;
  readonly choice: ResolvedModelChoice;
  /** The run-level budget (policy, lifetime-clamped) — the ceiling the
   *  per-order derived budgets are clamped against. */
  readonly runBudget: RemediateBudget;
  readonly envelopeBase: Omit<AgentEnvelope, 'turns' | 'costUsd' | 'failure' | 'toolPolicy'>;
  readonly git: RemediateGit;
  readonly baseHead: string;
  /** HEAD after the recipe commits — the agent tier's own base. */
  readonly agentBase: string;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
  readonly recipes: RecipePhaseSummary;
  readonly effectiveSalvage: 'discard' | 'draft-pr';
  /** Injected for tests: is a path a dependency manifest/lockfile? Default
   *  derives from the active packs' declared patterns (Rule 6) and backs
   *  the envelope's `manifests: false` enforcement. */
  readonly isManifestPath?: (path: string) => boolean;
}

/** Injected clock (tests); production uses Date.now. */
export type Clock = () => number;

/**
 * The runner's one call: dispatch the agent queue when one exists (a plan
 * in hand, a positive `remediate.maxOrdersPerRun`), else null — the legacy
 * task-prompt path is then the runner's. The queue is the agent-tier
 * orders plus every recipe order the recipe tier refused or failed;
 * open-ended tasks select no classes, so their queue is always empty.
 */
export async function dispatchQueuedOrders(
  opts: RemediateRunOptions,
  args: Omit<OrdersPhaseArgs, 'queue' | 'cap'>,
): Promise<Partial_ | null> {
  const cap = opts.config.maxOrdersPerRun;
  const queue = cap > 0 ? (args.recipes.agentOrders ?? []) : [];
  if (queue.length === 0) return null;
  return runOrdersPhase(opts, { ...args, queue, cap });
}

export async function runOrdersPhase(
  opts: RemediateRunOptions,
  args: OrdersPhaseArgs,
  now: Clock = Date.now,
): Promise<Partial_> {
  const toolPolicy = resolveOrderToolPolicy(args.driver);
  // The frame's tree-invariant step, bound once per run (4.4.6).
  const invariantStep: TreeInvariantStep = frameInvariantStep(
    opts.cwd,
    opts.trust,
    opts.frameInvariants ?? {},
  );
  // Session binding for the order scope: one token per run, injected into
  // the agent env so the Stop hook (which inherits it) can tell THIS lane's
  // scope from a killed or concurrent lane's leftover.
  const orderToken = newOrderScopeToken();
  // The manifests:false gate reads the pack-declared manifest-pattern union
  // (computed lazily once; injectable for tests).
  let manifestProbe = args.isManifestPath;
  const isManifestPath = (p: string): boolean => {
    if (!manifestProbe) {
      const packs = detectActiveLanguages(opts.cwd);
      manifestProbe = (x) => dependencyManifestFilesIn([x], packs).length > 0;
    }
    return manifestProbe(p);
  };
  const records: OrderRunRecord[] = [];
  const scrubbed: string[] = [];
  const failures: string[] = [];
  let totalTurns: number | undefined;
  let totalCost: number | undefined;
  let cliVersion: string | undefined;
  let resolvedModelId: string | undefined;
  let lastTail = '';
  let partial = false;
  let stopReason: string | undefined;
  let anyCompleted = false;
  let terminal: ((summary: OrdersPhaseSummary, envelope: AgentEnvelope) => Partial_) | undefined;

  const resumeNote = opts.resume
    ? resumePromptNote(opts.resume.attempt, opts.resume.blockingContext)
    : '';
  const negativeNote = opts.priorBlocking ? priorBlockingNote(opts.priorBlocking) : '';
  const startedAt = now();

  const dispatchList = args.queue.slice(0, args.cap);
  for (const order of args.queue.slice(args.cap)) {
    records.push(
      notDispatched(order, `beyond the per-run order cap (remediate.maxOrdersPerRun: ${args.cap})`),
    );
  }

  for (const order of dispatchList) {
    if (terminal) break;
    if (stopReason) {
      records.push(notDispatched(order, stopReason));
      continue;
    }
    // Remaining run budget: the per-order derived budget never exceeds what
    // is left of the run's own caps (wall clock, spend).
    const elapsedMinutes = (now() - startedAt) / 60_000;
    const remainingMinutes = args.runBudget.maxMinutes - elapsedMinutes;
    const remainingUsd = args.runBudget.maxUsd - (totalCost ?? 0);
    const remainingTurns = args.runBudget.maxTurns - (totalTurns ?? 0);
    if (remainingMinutes < 1 || remainingUsd <= 0 || remainingTurns <= 0) {
      partial = true;
      const dimension = remainingMinutes < 1 ? 'wall clock' : remainingUsd <= 0 ? 'spend' : 'turns';
      stopReason =
        `the run budget is exhausted (${dimension} — caps ` +
        `${args.runBudget.maxTurns} turns / ${args.runBudget.maxMinutes} min / ` +
        `$${args.runBudget.maxUsd}); later orders are deferred to the next firing`;
      records.push(notDispatched(order, stopReason));
      continue;
    }
    // The per-order derived budget, clamped to the run's remainder in every
    // dimension — the run-level caps bound the TOTAL across orders, so three
    // orders can never spend three times the configured turn cap.
    const minutes = Math.min(order.budget.minutes, Math.floor(remainingMinutes));
    const turns = Math.min(order.budget.turns, remainingTurns);
    const clamps = [
      ...(minutes < order.budget.minutes
        ? [`minutes clamped ${order.budget.minutes} to ${minutes} (run budget remaining)`]
        : []),
      ...(turns < order.budget.turns
        ? [`turns clamped ${order.budget.turns} to ${turns} (run budget remaining)`]
        : []),
    ];
    const clamped = clamps.length > 0 ? clamps.join('; ') : undefined;
    const orderBudget: RemediateBudget = {
      maxTurns: turns,
      maxMinutes: minutes,
      maxUsd: Math.min(order.budget.usd, remainingUsd),
    };
    // The frame's contract for THIS order's envelope (R2: the agent is told
    // what the frame owns, from the same invariants the step will apply).
    const invariantsInScope = frameInvariantsForEnvelope(
      opts.cwd,
      order.envelope,
      opts.frameInvariants ?? {},
    );
    const prompt =
      renderWorkOrderPrompt(order, { invariants: invariantsInScope }) +
      budgetPromptNote(orderBudget) +
      (clamped ? `\nRun-budget note: ${clamped}.` : '') +
      resumeNote +
      negativeNote;

    const orderBase = args.git.head();
    // The in-session done contract: the Stop-gate reads this file and blocks
    // the agent's stop while the order's target findings are still present.
    writeOrderScope(opts.cwd, {
      orderId: order.id,
      absentIds: [...order.done.absentIds],
      kinds: [...new Set(order.findings.map((f) => f.kind))],
      envelope: { paths: [...order.envelope.paths], manifests: order.envelope.manifests },
      verifier: order.done.verifier,
      command: order.done.command,
      token: orderToken,
      writtenAt: new Date().toISOString(),
    });
    let result: AgentRunResult;
    try {
      result = await args.driver.run({
        cwd: opts.cwd,
        prompt,
        budget: { maxTurns: orderBudget.maxTurns, maxMinutes: orderBudget.maxMinutes },
        model: args.choice.native,
        // The order token rides the agent env so the Stop hook, which
        // inherits it, can bind the scope file to THIS session.
        env: { ...(opts.agentEnv ?? {}), [ORDER_TOKEN_ENV]: orderToken },
        ...(toolPolicy.tools ? { tools: toolPolicy.tools } : {}),
      });
    } finally {
      clearOrderScope(opts.cwd);
    }

    if (result.transcriptTail) lastTail = result.transcriptTail;
    if (result.cliVersion && !cliVersion) cliVersion = result.cliVersion;
    if (result.resolvedModelId) resolvedModelId = result.resolvedModelId;
    if (result.turns !== undefined) totalTurns = (totalTurns ?? 0) + result.turns;
    if (result.costUsd !== undefined) totalCost = (totalCost ?? 0) + result.costUsd;

    // Evidence before classification (#272): sweep + scrub run before any
    // never-ran claim is honored.
    const sweepError = args.git.sweepLeftovers();
    scrubbed.push(...args.git.scrubRuntimeArtifacts(orderBase));
    const orderHasWork = args.git.hasDiff(orderBase);

    if (result.neverRan && !orderHasWork && !sweepError) {
      // Uncontradicted never-ran: the CLI itself is dead (auth, credit) —
      // dispatching further orders would spend nothing but time.
      const reason = result.neverRan.reason;
      records.push({ ...recordBase(order), outcome: 'never-ran', detail: reason });
      stopReason = `the agent CLI did not run (${reason}); later orders were not dispatched`;
      continue;
    }
    if (result.neverRan) {
      failures.push(
        `order ${order.id}: driver classified the run as "agent never ran" ` +
          `(${result.neverRan.reason}), but the tree carries work from this dispatch — the ` +
          `claim is contradicted by evidence, so verification decides the work's fate`,
      );
    }

    if (sweepError) {
      // Same doctrine as the legacy path: a failed sweep already staged the
      // leftovers, so nothing may land. Terminal for the whole run.
      records.push({
        ...recordBase(order),
        outcome: 'failed',
        detail: `the leftover sweep failed: ${sweepError}`,
      });
      const anyDiff = args.git.hasDiff(args.baseHead);
      terminal = (summary, envelope) => ({
        outcome: anyDiff ? 'sweep-failed' : 'agent-never-ran',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...(lastTail ? { transcriptTail: lastTail } : {}),
        ...(partial ? { partial } : {}),
        note: anyDiff
          ? `the agent committed work, but the runner could not sweep its remaining ` +
            `uncommitted state into a reviewable commit: ${sweepError}. Nothing lands — the ` +
            `staged leftovers would otherwise ride the delivery commit unreviewed. The ` +
            `branch is left for inspection.`
          : `agent left uncommitted work the sweep could not commit: ${sweepError}`,
        baseHead: args.baseHead,
        head: args.git.head(),
      });
      continue;
    }

    // Envelope ENFORCEMENT (the sweep half; the prompt half is advisory):
    // drop every committed change outside the order's envelope, plus the
    // always-allowed remediation notes file. Fail-CLOSED on an enforcement
    // error — an unenforced diff must not land.
    const enforced = args.git.enforceEnvelope(
      orderBase,
      (p) =>
        p === REMEDIATION_NOTES_PATH || pathAllowedByEnvelope(p, order.envelope, isManifestPath),
    );
    if (enforced.error) {
      records.push({
        ...recordBase(order),
        outcome: 'failed',
        detail: `envelope enforcement failed: ${enforced.error}`,
      });
      terminal = (summary, envelope) => ({
        outcome: 'sweep-failed',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...(lastTail ? { transcriptTail: lastTail } : {}),
        ...(partial ? { partial } : {}),
        note:
          `the runner could not enforce order ${order.id}'s envelope on the committed diff ` +
          `(${enforced.error}). Nothing lands — an out-of-envelope change must never ride a ` +
          `delivery unenforced. The branch is left for inspection.`,
        baseHead: args.baseHead,
        head: args.git.head(),
      });
      continue;
    }

    const overruns = budgetOverruns(args.driver, result, orderBudget);
    partial = partial || overruns.partial;
    if (result.failure) failures.push(`order ${order.id}: ${result.failure.reason}`);
    if (result.completed) anyCompleted = true;
    const record: OrderRunRecord = {
      ...recordBase(order),
      ...(clamped ? { clamped } : {}),
      outcome: result.neverRan
        ? 'failed'
        : overruns.partial
          ? 'partial'
          : result.completed
            ? 'completed'
            : 'failed',
      ...(result.failure ? { detail: result.failure.reason } : {}),
      ...(result.turns !== undefined || result.costUsd !== undefined
        ? {
            spent: {
              ...(result.turns !== undefined ? { turns: result.turns } : {}),
              ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
            },
          }
        : {}),
      ...(enforced.dropped.length > 0 ? { droppedPaths: enforced.dropped } : {}),
    };
    // Nothing committed for this order: nothing to place. The record stands
    // on the agent's outcome alone (a failed or empty dispatch).
    if (!args.git.hasDiff(orderBase)) {
      records.push(record);
      continue;
    }
    const placement = await placeOrder(opts, args, { order, orderBase, record, invariantStep });
    records.push(placement.record);
    if (placement.fatal) {
      // The drop's own cleanup failed: the tree state is unknown. Stop
      // dispatching; the kept orders' records and ledger still render.
      const fatal = placement.fatal;
      terminal = (summary, envelope) => ({
        outcome: 'sweep-failed',
        task: args.taskId,
        recipes: args.recipes,
        orders: summary,
        envelope,
        floor: args.entryFloor,
        ...(lastTail ? { transcriptTail: lastTail } : {}),
        ...(partial ? { partial } : {}),
        note: fatal,
        baseHead: args.baseHead,
        head: args.git.head(),
      });
      continue;
    }
    if (placement.record.disposition?.kind === 'unverifiable') {
      // Per-order verification infrastructure is unavailable: dispatching
      // further orders would stack unverifiable work. Stop, disclosed.
      stopReason =
        'per-order verification infrastructure is unavailable ' +
        `(order ${order.id}: ${placement.record.disposition.reason}); later orders were not dispatched`;
    }
  }

  const summary: OrdersPhaseSummary = {
    cap: args.cap,
    queued: args.queue.length,
    records,
    ...(opts.priorBlocking ? { priorBlockingApplied: true } : {}),
  };
  const envelope: AgentEnvelope = {
    ...args.envelopeBase,
    toolPolicy: toolPolicy.disclosure,
    ...(resolvedModelId ? { resolvedModelId } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(totalTurns !== undefined ? { turns: totalTurns } : {}),
    ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
    ...(failures.length > 0 ? { failure: failures.join('; ') } : {}),
  };
  if (terminal) return terminal(summary, envelope);

  return completeOrdersRun(opts, args, {
    summary,
    envelope,
    records,
    dispatchList,
    scrubbed,
    lastTail,
    partial,
    anyCompleted,
  });
}

function recordBase(order: WorkOrder): Omit<OrderRunRecord, 'outcome'> {
  return {
    orderId: order.id,
    class: String(order.class),
    findings: order.findings.length,
    budget: order.budget,
    done: { verifier: order.done.verifier, absentIds: order.done.absentIds.length },
  };
}

function notDispatched(order: WorkOrder, reason: string): OrderRunRecord {
  return { ...recordBase(order), outcome: 'not-dispatched', detail: reason };
}
