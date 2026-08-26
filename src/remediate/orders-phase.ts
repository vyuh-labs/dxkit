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
 *      DISCLOSURE, so sprawl is unlandable by construction.
 *
 * The combined head then goes through the ONE tree verification exactly as
 * the legacy path's does; the outcome mapping shares the runner's phrasing
 * helpers (`verify.ts`), never a second copy.
 *
 * Order-driven tasks are bounded (no score hinge by construction — the
 * catalog test pins that a class-selecting task declares none), so the
 * hinge tail lives only on the legacy path.
 */
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import { checkKey } from '../analyzers/correctness/attribution';
import { clearOrderScope, writeOrderScope } from '../loop/order-scope';
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
import { pathInEnvelope } from './recipes/envelope';
import { priorBlockingNote, resumePromptNote } from './resume';
import { REMEDIATION_NOTES_PATH, type RemediateTask } from './tasks';
import { resolveOrderToolPolicy } from './tool-policy';
import {
  guardrailRedNote,
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
} from './verify';
import { renderWorkOrderPrompt } from './work-orders/render';
import type { WorkOrder } from './work-orders/types';

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
    if (remainingMinutes < 1 || remainingUsd <= 0) {
      partial = true;
      stopReason =
        `the run budget is exhausted (` +
        `${remainingMinutes < 1 ? 'wall clock' : 'spend'} — caps ` +
        `${args.runBudget.maxMinutes} min / $${args.runBudget.maxUsd}); later orders are ` +
        'deferred to the next firing';
      records.push(notDispatched(order, stopReason));
      continue;
    }
    const minutes = Math.min(order.budget.minutes, Math.floor(remainingMinutes));
    const clamped =
      minutes < order.budget.minutes
        ? `minutes clamped ${order.budget.minutes} to ${minutes} (run budget remaining)`
        : undefined;
    const orderBudget: RemediateBudget = {
      maxTurns: order.budget.turns,
      maxMinutes: minutes,
      maxUsd: Math.min(order.budget.usd, remainingUsd),
    };
    const prompt =
      renderWorkOrderPrompt(order) +
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
      envelope: { paths: [...order.envelope.paths], manifests: order.envelope.manifests },
      verifier: order.done.verifier,
      command: order.done.command,
    });
    let result: AgentRunResult;
    try {
      result = await args.driver.run({
        cwd: opts.cwd,
        prompt,
        budget: { maxTurns: orderBudget.maxTurns, maxMinutes: orderBudget.maxMinutes },
        model: args.choice.native,
        env: opts.agentEnv ?? {},
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
      (p) => pathInEnvelope(p, order.envelope) || p === REMEDIATION_NOTES_PATH,
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
    records.push({
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
    });
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
  // orders (a guardrail-verifier order's closure is arbitrated by the
  // guardrail verdict below and the next plan — the ledger says so).
  const failingKeys = new Set(
    (verified.floor?.checks ?? [])
      .filter((c) => c.status === 'fail')
      .map((c) => checkKey(c.pack, c.label)),
  );
  const byId = new Map(dispatchList.map((o) => [o.id, o] as const));
  const withDone = records.map((r) => {
    const order = byId.get(r.orderId);
    if (!order || order.done.verifier !== 'floor' || r.outcome === 'not-dispatched') return r;
    const open = order.done.absentIds.filter((id) => failingKeys.has(id.split('#')[0])).length;
    return { ...r, doneAfterVerify: { closed: order.done.absentIds.length - open, open } };
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
