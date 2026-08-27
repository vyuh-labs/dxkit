/**
 * The agentic remediation runner — `vyuh-dxkit remediate --task <t>`.
 *
 * The agent runs INSIDE the verified frame the deterministic bump lane
 * built (design §2): entry floor snapshot on the pristine tree → agent →
 * leftover sweep → the ONE tree verification (`lanes/verify-tree.ts`: a clean
 * worktree of the committed head, the repo's frozen install, the floor
 * diff-scoped and attributed vs entry so only a NET-NEW failure blocks and
 * pre-existing debt is disclosed, never weaponized, then the guardrail as
 * final arbiter). The agent's "completed" claim is NEVER
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
import { runCorrectnessFloor } from '../analyzers/correctness/run';
import { detectActiveLanguages } from '../languages';
import { renderRemediateLedger } from './ledger-render';
import { resolveModelSetting } from './driver';
import { AGENT_DRIVERS, knownDriverIds } from './registry';
import type { RemediateTask } from './tasks';
import { resolveDispatchedTask } from './dispatch';
import { realGit } from './git-ops';
import { armGateForDriver } from './agent-trust';
import { clampBudgetToTokenLifetime, unenforceableCapsFor } from './budget-notes';
import { healthHingeScores } from './score-hinge';
import { salvageForTask } from './config';
import { recipeTierStep } from './recipes/complete';
import { dispatchQueuedOrders } from './orders-phase';
import { runLegacyTaskPath } from './legacy-task-run';
import type { AgentEnvelope, RemediateResult, RemediateRunOptions } from './outcome';

// The outcome vocabulary (`./outcome`) and ledger renderer
// (`./ledger-render`) are re-exported so consumers keep one import surface.
export type {
  AgentEnvelope,
  RemediateGit,
  RemediateOutcome,
  RemediatePhase,
  RemediateResult,
  RemediateRunOptions,
} from './outcome';
export { renderRemediateLedger };

export async function runRemediateTask(opts: RemediateRunOptions): Promise<RemediateResult> {
  // Populated once the task resolves (a dispatch campaign's disclosure);
  // folded into EVERY exit so no outcome can drop it from the ledger.
  let dispatchDisclosure: Pick<RemediateResult, 'dispatch'> = {};
  const finish = (r: Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>): RemediateResult => {
    const withDispatch = {
      ...dispatchDisclosure,
      ...(opts.resume ? { resume: { attempt: opts.resume.attempt } } : {}),
      ...r,
    };
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
  // The credential-lifetime clamp applies at the ONE budget read, so
  // enforcement (the process timeout), the agent's prompt, and the
  // envelope disclosure all see the same effective wall clock.
  const lifetime = clampBudgetToTokenLifetime(opts.config.agent.budget, process.env);
  const budget = lifetime.budget;
  // The ONE salvage resolver (config.ts): explicit policy wins; 'auto'
  // follows the task's completion shape (the CLI's land decision agrees).
  const effectiveSalvage = salvageForTask(opts.config, task);
  // Budget-envelope disclosures — the ONE phrasing, split to
  // `budget-notes.ts` at the large-file bar.
  const unenforceableCaps = [...lifetime.notes, ...unenforceableCapsFor(driver, budget)];

  // Auth-path disclosure (driver-generic): a declared credential the runner
  // actually injected = billed API spend; none = the CLI's stored login
  // (subscription), whose reported costs are notional API-equivalents.
  const auth: AgentEnvelope['auth'] = driver.credentialEnv.some((name) => opts.agentEnv?.[name])
    ? 'api-key'
    : 'subscription';

  // The in-loop gate (#305): probe the wiring and disclose the result,
  // armed vs backstop-only with the reason, in the envelope
  // (`armGateForDriver`). Injectable for tests (the runFloor seam pattern).
  const inLoopGate = (opts.armInLoopGate ?? (() => armGateForDriver(driver, opts.cwd)))();

  const envelopeBase = {
    driver: driver.id,
    model: choice.native,
    modelSource: choice.source,
    ...(choice.warning ? { modelWarning: choice.warning } : {}),
    auth,
    budget,
    unenforceableCaps,
    inLoopGate,
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
  // A resume passes the entry floor in (captured on the pristine tree before
  // the salvage checkout); a fresh run captures it here.
  const entryFloor = opts.entryFloor ?? runFloor();

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

  // The deterministic recipe tier (section 3B, `recipeTierStep`): execute
  // recipe-tier orders FIRST, each committed inside its envelope. A
  // recipe-only plan completes right here with no agent spawn, the ONE
  // tree verification still arbitrating. Fail-open on planning.
  opts.onPhase?.('recipes');
  const tier = await recipeTierStep(opts, { task, entryFloor, baseHead, git, runFloor });
  const recipesDisclosure = { recipes: tier.recipes };
  if (tier.done) return finish(tier.done);
  // The agent's OWN base: recipe commits advance the branch first, so every
  // "did the agent produce work" question measures from here; otherwise a
  // dead agent wears the recipes' commits and an honest never-ran claim
  // reads as contradicted. Verification and the lander's range stay
  // anchored at baseHead so recipe commits are verified and land.
  const agentBase = git.head();
  const hasRecipeCommits = agentBase !== baseHead;

  opts.onPhase?.('agent');
  // Order-driven dispatch (section 3C): with a queue in hand the agent tier
  // receives ONE rendered work order per run; null keeps the legacy path.
  const ordered = await dispatchQueuedOrders(opts, {
    taskId: task.id,
    driver,
    choice,
    runBudget: budget,
    envelopeBase,
    git,
    baseHead,
    agentBase,
    entryFloor,
    runFloor,
    recipes: tier.recipes,
    effectiveSalvage,
  });
  if (ordered) return finish(ordered);

  // The legacy single-prompt tail (split to `legacy-task-run.ts` at the
  // module-size bar): the open-ended task prompt with the SAME frame
  // contract, tool policy and post-agent invariant step an order dispatch
  // gets, then the one tree verification.
  return runLegacyTaskPath(
    opts,
    {
      task,
      driver,
      choice,
      budget,
      effectiveSalvage,
      envelopeBase,
      git,
      runFloor,
      entryFloor,
      entryScores,
      hingeProbe,
      baseHead,
      agentBase,
      hasRecipeCommits,
      recipesDisclosure,
    },
    finish,
  );
}
