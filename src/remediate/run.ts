/**
 * The agentic remediation runner — `vyuh-dxkit remediate --task <t>`.
 *
 * The agent runs INSIDE the verified frame the deterministic bump lane
 * built (design §2): entry floor snapshot on the pristine tree → agent →
 * leftover sweep → floor at full scope attributed vs entry (only a NET-NEW
 * failure blocks; pre-existing debt is disclosed, never weaponized) → the
 * guardrail as final arbiter. The agent's "completed" claim is NEVER
 * trusted — an agent that says done with a red net-new floor gets the same
 * treatment as a failed bump: no landing, truthful failure.
 *
 * Every budget cap is enforced by the RUNNER, not the agent's self-report:
 * maxTurns rides the driver when it supports it, maxMinutes is the process
 * timeout (a kill is SALVAGE territory — committed work is finished work),
 * maxUsd is read from the spend envelope after the run. A cap the driver
 * cannot enforce is a DISCLOSED limitation in the ledger, never a silent
 * no-op.
 *
 * SECURITY: the runner executes an agent CLI against the checked-out tree.
 * It takes the REQUIRED typed trust context and refuses when repo execution
 * is not allowed; the managed lane runs on the default branch only, with
 * dxkit-authored prompts only. Landing (the standing PR) is composed by the
 * CLI/workflow layer on top of this runner's outcome.
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../analyzers/correctness/run';
import {
  attributeFloorFailures,
  type AttributedFloorFailure,
  type FloorBaseCheck,
} from '../analyzers/correctness/attribution';
import { detectActiveLanguages } from '../languages';
import { renderRemediateLedger } from './ledger-render';
import { guardrailVerdictFor, toFloorBaseChecks, type GuardrailGateResult } from '../lanes/verify';
import { resolveModelSetting, type AgentDriver, type AgentRunResult } from './driver';
import { AGENT_DRIVERS, knownDriverIds } from './registry';
import type { RemediateTask } from './tasks';
import { resolveDispatchedTask, type DispatchOverrides } from './dispatch';
import { realGit } from './git-ops';
import {
  evaluateScoreHinge,
  healthHingeScores,
  type HingeEvidence,
  type HingeScores,
} from './score-hinge';
import type { RemediateConfig } from './config';

export type RemediateOutcome =
  | 'verified' // diff produced, floor net-new-clean, guardrail PASSED — ready to land
  | 'no-op' // agent ran, no diff (nothing to fix)
  | 'floor-red' // diff breaks the net-new floor — never lands
  | 'guardrail-red' // guardrail blocked, refused, or could not run — never lands
  | 'score-red' // the task's score hinge did not hold (goal not met) — never lands
  | 'budget-exhausted' // a cap hit; partial diff (salvage policy decides its fate)
  | 'agent-never-ran' // CLI/auth/env failure — infra, not a code outcome
  | 'sweep-failed' // agent committed work but leftovers could not be swept
  | 'refused'; // trust/config refusal, disclosed

export interface AgentEnvelope {
  readonly driver: string;
  /** Driver-native model argument + how it was chosen (ledger disclosure). */
  readonly model: string;
  readonly modelSource: 'auto-tier' | 'pinned-tier' | 'pinned-native';
  readonly modelWarning?: string;
  /** Concrete id the run reported, or absent ("not reported by driver"). */
  readonly resolvedModelId?: string;
  readonly turns?: number;
  readonly costUsd?: number;
  readonly budget: {
    readonly maxTurns: number;
    readonly maxMinutes: number;
    readonly maxUsd: number;
  };
  /** Caps the driver cannot enforce — disclosed, never silent. */
  readonly unenforceableCaps: readonly string[];
}

export interface RemediateResult {
  readonly outcome: RemediateOutcome;
  readonly task?: RemediateTask['id'];
  readonly note?: string;
  readonly envelope?: AgentEnvelope;
  /** True when the run was cut short (wall-clock or turn cap) — the ledger
   *  must say the task was budget-bounded, not finished. */
  readonly partial?: boolean;
  readonly floor?: CorrectnessFloorResult;
  readonly floorAttribution?: readonly AttributedFloorFailure[];
  readonly guardrailVerdict?: string;
  /** Score-hinge evidence (tasks that declare one): the entry vs post-agent
   *  dimension scores the land decision was made on. Present on success AND
   *  failure — the ledger shows the delta either way. */
  readonly scoreHinge?: HingeEvidence;
  /** HEAD before/after the agent — the commit range a lander pushes. */
  readonly baseHead?: string;
  readonly head?: string;
  /** Dispatch-campaign disclosure (E3): who fired it, the verbatim custom
   *  prompt (when the `custom` task ran), and any clamped overrides. In the
   *  ledger = in the PR body, so the reviewer sees exactly what was asked. */
  readonly dispatch?: {
    readonly actor?: string;
    readonly prompt?: string;
    readonly clamped: readonly string[];
  };
  /** The verification ledger — PR body / job summary markdown. */
  readonly ledger: string;
}

export interface RemediateGit {
  head(): string;
  /** Commit uncommitted leftovers (excluding dxkit runtime state); returns
   *  an error string when the sweep commit failed. */
  sweepLeftovers(): string | undefined;
  /** Any commits in base..HEAD? */
  hasDiff(baseHead: string): boolean;
}

export interface RemediateRunOptions {
  readonly cwd: string;
  /** REQUIRED typed trust context — the runner executes an agent CLI. */
  readonly trust: AnalysisTrustContext;
  readonly taskId: string;
  readonly config: RemediateConfig;
  /** Credentials for the driver (CI: from repo secrets). Local default is
   *  empty — the claude-code driver then runs subscription-mode. */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /** Injected for tests. */
  readonly drivers?: readonly AgentDriver[];
  readonly git?: RemediateGit;
  readonly runFloor?: () => CorrectnessFloorResult;
  readonly runGuardrail?: () => Promise<GuardrailGateResult>;
  /** Injected for tests: replaces the health-score probe behind a task's
   *  score hinge. */
  readonly hingeScores?: (hinge: NonNullable<RemediateTask['scoreHinge']>) => Promise<HingeScores>;
  /** Progress hook — called as each phase begins so the CLI layer can emit
   *  log groups + heartbeats (a 35-minute silent step is indistinguishable
   *  from a hang; "working" must be observable from the job log). */
  readonly onPhase?: (phase: RemediatePhase) => void;
  /** Dispatch-campaign overrides (E2/E3), read from env by the CLI layer.
   *  Carries the custom task's prompt, the clamp disclosures, and the
   *  dispatcher for the ledger. */
  readonly dispatch?: DispatchOverrides;
}

/** The runner's observable phases, in order. */
export type RemediatePhase =
  | 'entry-floor'
  | 'agent'
  | 'sweep'
  | 'verify-floor'
  | 'guardrail'
  | 'score-hinge';

// The ledger renderer lives in `./ledger-render` (module-size split);
// re-exported so consumers keep one import surface.
export { renderRemediateLedger };

export async function runRemediateTask(opts: RemediateRunOptions): Promise<RemediateResult> {
  // Populated once the task resolves (a dispatch campaign's disclosure);
  // folded into EVERY exit so no outcome can drop it from the ledger.
  let dispatchDisclosure: Pick<RemediateResult, 'dispatch'> = {};
  const finish = (r: Omit<RemediateResult, 'ledger' | 'dispatch'>): RemediateResult => {
    const withDispatch = { ...dispatchDisclosure, ...r };
    return { ...withDispatch, ledger: renderRemediateLedger(withDispatch) };
  };

  // Trust boundary first: this runner spawns an agent against the tree.
  if (!opts.trust.repoExecutionAllowed) {
    return finish({
      outcome: 'refused',
      note:
        'refused: repo execution is not allowed under this trust context ' +
        `(${opts.trust.source}) — the remediate lane runs on the default branch only.`,
    });
  }

  // Task resolution + dispatch disclosure — one dispatch-aware entry
  // (`resolveDispatchedTask`); the disclosure rides every result from here
  // on (finish() folds it into the ledger).
  const resolved = resolveDispatchedTask(opts.taskId, opts.dispatch);
  if (!resolved.task) {
    return finish({ outcome: 'refused', note: resolved.refusalNote });
  }
  const task = resolved.task;
  if (resolved.disclosure) dispatchDisclosure = { dispatch: resolved.disclosure };

  const drivers = opts.drivers ?? AGENT_DRIVERS;
  const driver = drivers.find((d) => d.id === opts.config.agent.driver);
  if (!driver) {
    const known = drivers.map((d) => d.id).join(', ') || knownDriverIds().join(', ');
    return finish({
      outcome: 'refused',
      task: task.id,
      note: `refused: unknown agent driver '${opts.config.agent.driver}' — known drivers: ${known}.`,
    });
  }

  const availability = driver.available(opts.cwd);
  if (!availability.ok) {
    return finish({
      outcome: 'agent-never-ran',
      task: task.id,
      note: `agent never ran: ${availability.reason}`,
    });
  }

  const choice = resolveModelSetting(driver, opts.config.agent.model, task.tier);
  const budget = opts.config.agent.budget;
  const unenforceableCaps: string[] = [];
  if (!driver.budgetSupport.turns) {
    unenforceableCaps.push(
      `maxTurns is not enforceable by ${driver.id}; the wall-clock cap (${budget.maxMinutes} min) applies`,
    );
  }
  if (!driver.budgetSupport.cost) {
    unenforceableCaps.push(
      `maxUsd is not enforceable by ${driver.id} (no spend reporting); the wall-clock cap applies`,
    );
  }

  const envelopeBase = {
    driver: driver.id,
    model: choice.native,
    modelSource: choice.source,
    ...(choice.warning ? { modelWarning: choice.warning } : {}),
    budget,
    unenforceableCaps,
  };

  const git = opts.git ?? realGit(opts.cwd);
  const runFloor =
    opts.runFloor ??
    (() =>
      runCorrectnessFloor({
        cwd: opts.cwd,
        changedFiles: [],
        scope: 'full',
        packs: detectActiveLanguages(opts.cwd),
      }));

  // Entry snapshot on the pristine tree: the base side of the attribution
  // comparator — a repo already red at entry keeps its debt disclosed, never
  // weaponized against the agent's change.
  opts.onPhase?.('entry-floor');
  const entryFloor = runFloor();

  // $0 deterministic fast-exit (per-task opt-in): a floor-goal task with a
  // GREEN entry floor has nothing to fix — return no-op BEFORE any agent
  // spawns, so a scheduled firing on a healthy repo costs nothing.
  if (task.skipWhenEntryFloorGreen && !entryFloor.blocks) {
    return finish({
      outcome: 'no-op',
      task: task.id,
      floor: entryFloor,
      note:
        'nothing to do: the entry correctness floor is green, and this task exists to fix ' +
        'floor debt — no agent was spawned ($0).',
    });
  }
  // Entry side of the task's score hinge (when it declares one) — computed on
  // the same pristine tree the entry floor snapshots.
  const hingeProbe =
    opts.hingeScores ??
    ((h: NonNullable<RemediateTask['scoreHinge']>) => healthHingeScores(opts.cwd, opts.trust, h));
  const entryScores = task.scoreHinge ? await hingeProbe(task.scoreHinge) : undefined;
  const baseHead = git.head();

  opts.onPhase?.('agent');
  const agentResult: AgentRunResult = await driver.run({
    cwd: opts.cwd,
    prompt: task.prompt,
    budget: { maxTurns: budget.maxTurns, maxMinutes: budget.maxMinutes },
    model: choice.native,
    env: opts.agentEnv ?? {},
  });

  const envelope: AgentEnvelope = {
    ...envelopeBase,
    ...(agentResult.resolvedModelId ? { resolvedModelId: agentResult.resolvedModelId } : {}),
    ...(agentResult.turns !== undefined ? { turns: agentResult.turns } : {}),
    ...(agentResult.costUsd !== undefined ? { costUsd: agentResult.costUsd } : {}),
  };

  if (agentResult.neverRan) {
    return finish({
      outcome: 'agent-never-ran',
      task: task.id,
      envelope,
      note: `agent never ran: ${agentResult.neverRan.reason}`,
    });
  }

  // Sweep uncommitted leftovers into a loudly-labeled commit — work the
  // budget kill stranded mid-edit is still evidence, and a dirty tree must
  // never leak into the landing layer unreviewed.
  opts.onPhase?.('sweep');
  const sweepError = git.sweepLeftovers();
  const hasDiff = git.hasDiff(baseHead);

  const overUsd =
    driver.budgetSupport.cost &&
    agentResult.costUsd !== undefined &&
    agentResult.costUsd > budget.maxUsd;
  // A cap dxkit cannot enforce is a cap dxkit may not claim was HIT — the
  // same refusal the cost clause makes. A driver that reports turns without
  // enforcing them would otherwise mislabel a natural completion as
  // budget-exhausted while the envelope discloses the cap as unenforceable.
  const overTurns =
    driver.budgetSupport.turns &&
    agentResult.turns !== undefined &&
    agentResult.turns >= budget.maxTurns;
  const partial = agentResult.timedOut || overUsd || overTurns;

  // A failed sweep is a hard stop REGARDLESS of whether the agent committed
  // work: `git add -A` already staged the leftovers, so proceeding would let
  // the landing layer commit them alongside the ledger and push them
  // unreviewed. Disclosed either way; nothing lands.
  if (sweepError) {
    if (!hasDiff) {
      return finish({
        outcome: 'agent-never-ran',
        task: task.id,
        envelope,
        note: `agent left uncommitted work the sweep could not commit: ${sweepError}`,
      });
    }
    return finish({
      outcome: 'sweep-failed',
      task: task.id,
      envelope,
      ...(partial ? { partial } : {}),
      note:
        `the agent committed work, but the runner could not sweep its remaining uncommitted ` +
        `state into a reviewable commit: ${sweepError}. Nothing lands — the staged leftovers ` +
        `would otherwise ride the delivery commit unreviewed. The branch is left for inspection.`,
      baseHead,
      head: git.head(),
    });
  }

  if (!hasDiff) {
    return finish({
      outcome: 'no-op',
      task: task.id,
      envelope,
      ...(partial ? { partial } : {}),
      note: 'agent ran and produced no committed change.',
      baseHead,
      head: git.head(),
    });
  }

  // Verify: floor at full scope attributed vs entry (through the ONE
  // base-check projection, shared with the bump lane), then the guardrail.
  opts.onPhase?.('verify-floor');
  const floor = runFloor();
  const baseChecks: FloorBaseCheck[] = toFloorBaseChecks(entryFloor);
  const floorAttribution = attributeFloorFailures(floor, baseChecks, {
    // The entry floor always ran (just above): an absent base check is a
    // check the agent's change introduced — net-new (conservative).
    absentMeans: 'net-new',
  });
  const netNewFloorRed = floorAttribution.some((a) => a.attribution === 'net-new');

  opts.onPhase?.('guardrail');
  const guardrail = opts.runGuardrail
    ? await opts.runGuardrail()
    : await guardrailVerdictFor(opts.cwd, opts.trust);

  const common = {
    task: task.id,
    envelope,
    floor,
    floorAttribution,
    guardrailVerdict: guardrail.verdict,
    baseHead,
    head: git.head(),
    ...(partial ? { partial } : {}),
  };

  if (netNewFloorRed) {
    return finish({
      outcome: 'floor-red',
      ...common,
      note:
        'the correctness floor has NET-NEW failures after the agent ran (the entry floor ' +
        'did not have them) — nothing lands. An agent that breaks the build gets a truthful ' +
        'failure, never a PR.',
    });
  }

  // The agent lane fails CLOSED on the guardrail (unlike the bump lane's
  // declared fail-open): an agent-authored diff — including whatever the
  // leftover sweep committed — must never reach the remote unverified. A
  // BLOCKED verdict, the CANNOT-GATE refusal tier, and an unrunnable check
  // all land nothing; the ledger says which it was.
  if (!guardrail.ran || !guardrail.passesGate) {
    // Name the blocking findings in the ledger: on an ephemeral runner the
    // diff evaporates with the job, so "did not pass" with no evidence made
    // a BLOCKED attempt uninspectable (the workflow additionally uploads the
    // attempt diff as a run artifact).
    const evidence =
      guardrail.blocking && guardrail.blocking.length > 0
        ? `\n\nBlocking findings:\n${guardrail.blocking.map((b) => `- ${b}`).join('\n')}`
        : '';
    return finish({
      outcome: 'guardrail-red',
      ...common,
      note:
        (guardrail.ran
          ? `the guardrail did not pass (${guardrail.verdict}) — nothing lands. The attempt ` +
            'diff is uploaded as a run artifact when this ran under Actions; locally the ' +
            'branch stays for inspection.'
          : `the guardrail could not run (${guardrail.verdict}) — nothing lands. An ` +
            'agent-authored diff is never pushed unverified.') + evidence,
    });
  }

  // The score hinge — the task's GOAL as a deterministic land condition. It
  // gates salvage too: a partial docs diff that moves nothing is noise, not
  // salvageable work.
  if (task.scoreHinge && entryScores) {
    const verdict = evaluateScoreHinge(
      task.scoreHinge,
      entryScores,
      await hingeProbe(task.scoreHinge),
    );
    if (!verdict.ok) {
      return finish({
        outcome: 'score-red',
        ...common,
        scoreHinge: verdict.evidence,
        note: verdict.note,
      });
    }
    (common as { scoreHinge?: typeof verdict.evidence }).scoreHinge = verdict.evidence;
  }

  if (partial) {
    const salvage =
      opts.config.salvage === 'draft-pr'
        ? 'salvage policy: draft-pr — the verified partial work may land as a DRAFT.'
        : 'salvage policy: discard — the partial work is not landed (branch left for inspection).';
    return finish({
      outcome: 'budget-exhausted',
      ...common,
      note:
        `budget cap hit (${agentResult.timedOut ? 'wall-clock' : overUsd ? 'maxUsd' : 'maxTurns'}) — ` +
        `the diff is verified but the task was cut short. ${salvage}`,
    });
  }

  return finish({ outcome: 'verified', ...common });
}
