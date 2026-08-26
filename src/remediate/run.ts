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
import {
  guardrailRedNote,
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
} from './verify';
import { resolveModelSetting, type AgentRunResult } from './driver';
import { AGENT_DRIVERS, knownDriverIds } from './registry';
import type { RemediateTask } from './tasks';
import { resolveDispatchedTask } from './dispatch';
import { priorBlockingNote, resumePromptNote } from './resume';
import { realGit } from './git-ops';
import { armGateForDriver } from './agent-trust';
import {
  budgetOverruns,
  budgetPromptNote,
  clampBudgetToTokenLifetime,
  unenforceableCapsFor,
} from './budget-notes';
import { evaluateScoreHinge, healthHingeScores } from './score-hinge';
import { salvageForTask } from './config';
import { recipeTierStep } from './recipes/complete';
import { dispatchQueuedOrders } from './orders-phase';
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

  // Budget awareness (`budgetPromptNote`): appended by the runner, the one
  // place the effective budget is known, never baked into the task prompts.
  const budgetNote = budgetPromptNote(budget);
  const resumeNote = opts.resume
    ? resumePromptNote(opts.resume.attempt, opts.resume.blockingContext)
    : '';
  // A prior BLOCKED attempt's findings constrain the legacy prompt too:
  // an empty order queue must not silently drop the negative constraint.
  const negativeNote = opts.priorBlocking ? priorBlockingNote(opts.priorBlocking) : '';
  const agentResult: AgentRunResult = await driver.run({
    cwd: opts.cwd,
    prompt: task.prompt + budgetNote + resumeNote + negativeNote,
    budget: { maxTurns: budget.maxTurns, maxMinutes: budget.maxMinutes },
    model: choice.native,
    env: opts.agentEnv ?? {},
  });

  let envelope: AgentEnvelope = {
    ...envelopeBase,
    ...(agentResult.resolvedModelId ? { resolvedModelId: agentResult.resolvedModelId } : {}),
    ...(agentResult.cliVersion ? { cliVersion: agentResult.cliVersion } : {}),
    ...(agentResult.turns !== undefined ? { turns: agentResult.turns } : {}),
    ...(agentResult.costUsd !== undefined ? { costUsd: agentResult.costUsd } : {}),
    ...(agentResult.failure ? { failure: agentResult.failure.reason } : {}),
  };
  // Job-log evidence for every post-run exit (never rendered into the
  // ledger): a non-clean outcome must be diagnosable from the run page.
  const evidenceTail = agentResult.transcriptTail
    ? { transcriptTail: agentResult.transcriptTail }
    : {};

  // Sweep uncommitted leftovers into a loudly-labeled commit: stranded
  // mid-edit work is still evidence, and a dirty tree must never leak into
  // the landing layer unreviewed. Runs BEFORE the never-ran claim is
  // honored: a classification must never decide the fate of evidence it
  // has not looked at (#272). A genuinely never-ran agent leaves nothing
  // to sweep, so this is a no-op on that path.
  opts.onPhase?.('sweep');
  const sweepError = git.sweepLeftovers();
  // Drop attempt-introduced runtime artifacts (regenerable scan state the
  // agent committed mid-run) BEFORE the diff question — an attempt whose
  // only content was scan output must read as a no-op, and a real attempt
  // must not carry `.dxkit/reports/*` into its PR. Disclosed below.
  const scrubbed = git.scrubRuntimeArtifacts(agentBase);
  const hasDiff = git.hasDiff(agentBase);

  if (agentResult.neverRan) {
    // The tree is the arbiter of "ran": commits past baseHead, or leftovers
    // the sweep touched, are work — and work means the agent RAN, whatever
    // the driver's classification concluded (a future CLI can always invent
    // a new exit encoding; the tree cannot lie). Uncontradicted, the claim
    // stands; contradicted, the claim is demoted to a disclosed failure and
    // verification decides the work's fate — the lane's law applied to the
    // driver's own report.
    if (!hasDiff && !sweepError) {
      return finish({
        outcome: 'agent-never-ran',
        task: task.id,
        ...recipesDisclosure,
        envelope,
        floor: entryFloor,
        ...evidenceTail,
        note: `agent never ran: ${agentResult.neverRan.reason}`,
      });
    }
    envelope = {
      ...envelope,
      failure:
        `driver classified the run as "agent never ran" (${agentResult.neverRan.reason}), ` +
        `but the tree carries work from this attempt — the claim is contradicted by ` +
        `evidence, so verification decides the work's fate`,
    };
  }

  // Budget-overrun facts, claimed only where dxkit can (`budgetOverruns`:
  // reported cost vs advisory cap; turns only when the driver enforces).
  const { overUsd, partial } = budgetOverruns(driver, agentResult, budget);

  // A failed sweep is a hard stop REGARDLESS of whether the agent committed
  // work: `git add -A` already staged the leftovers, so proceeding would let
  // the landing layer commit them alongside the ledger and push them
  // unreviewed. Disclosed either way; nothing lands.
  if (sweepError) {
    if (!hasDiff) {
      return finish({
        outcome: 'agent-never-ran',
        task: task.id,
        ...recipesDisclosure,
        envelope,
        floor: entryFloor,
        ...evidenceTail,
        note: `agent left uncommitted work the sweep could not commit: ${sweepError}`,
      });
    }
    return finish({
      outcome: 'sweep-failed',
      task: task.id,
      ...recipesDisclosure,
      envelope,
      floor: entryFloor,
      ...evidenceTail,
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
    // A benign no-op requires the agent's run to have ENDED CLEAN. An
    // errored run with no diff is a failure — reporting it as "nothing to
    // fix" is the green-job-over-a-dead-agent class, one guard further out
    // than the driver's never-ran taxonomy (defense in depth: any driver
    // that misses its own failure shape still cannot produce a green no-op
    // here). A budget-cut run (timedOut / cap hit) stays a no-op with the
    // `partial` flag: "ran out of budget before committing anything" is a
    // true statement the ledger already makes.
    if (!agentResult.completed && !partial) {
      return finish({
        outcome: 'agent-failed',
        task: task.id,
        ...recipesDisclosure,
        envelope,
        floor: entryFloor,
        ...evidenceTail,
        note:
          `the agent run ended in an error and produced no committed change` +
          `${agentResult.failure ? `: ${agentResult.failure.reason}` : ''}. ` +
          'Nothing to verify; nothing lands' +
          (hasRecipeCommits
            ? ' (the recipe commits stay on the branch, unlanded, for the next attempt)'
            : '') +
          '.',
        baseHead,
        head: git.head(),
      });
    }
    // The AGENT added nothing, but applied recipe commits are real work:
    // fall through so the combined head is verified and can land.
    if (!hasRecipeCommits)
      return finish({
        outcome: 'no-op',
        task: task.id,
        ...recipesDisclosure,
        envelope,
        floor: entryFloor,
        ...evidenceTail,
        // The agent's own account of why nothing changed (#285): a clean
        // no-op discards the transcript by design, which made "no-op against
        // a visibly non-empty inventory" unautopsiable. Attempt-record
        // evidence only, never the ledger / PR body.
        ...(agentResult.finalMessage ? { agentFinalMessage: agentResult.finalMessage } : {}),
        ...(scrubbed.length > 0 ? { scrubbedArtifacts: scrubbed } : {}),
        ...(partial ? { partial } : {}),
        note:
          scrubbed.length > 0
            ? 'agent ran and produced no committed change beyond regenerable dxkit scan state ' +
              '(dropped, disclosed below).'
            : 'agent ran and produced no committed change.',
        baseHead,
        head: git.head(),
      });
  }

  // Verify the committed head the way CI will (the ONE tree verification,
  // `lanes/verify-tree.ts`): a clean worktree of HEAD, the repo's frozen
  // install, the floor diff-scoped vs baseHead and attributed vs entry
  // (through the ONE comparator, shared with the bump lane), then the
  // guardrail. Never the agent's dirty workspace: the class this closes was
  // a "verified" draft whose lockfile CI could not install.
  const head = git.head();
  const { verified, guardrail } = await verifyCommittedHead(opts, {
    head,
    baseHead,
    entryFloor,
    runFloor,
  });

  const common = {
    task: task.id,
    ...recipesDisclosure,
    envelope,
    ...verificationDisclosures(verified, guardrail),
    baseHead,
    head,
    ...evidenceTail,
    ...(scrubbed.length > 0 ? { scrubbedArtifacts: scrubbed } : {}),
    ...(partial ? { partial } : {}),
  };

  if (verified.verdict === 'install-failed') {
    return finish({
      outcome: 'install-failed',
      ...common,
      note: installFailedNote(verified),
    });
  }

  if (verified.verdict === 'floor-red') {
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
  // BLOCKED verdict, the CANNOT-GATE refusal tier, an unrunnable check, and
  // a verification that could not run at all (a worktree or package manager
  // failure, the step named) all land nothing; the ledger says which it was.
  if (!guardrail.ran || !guardrail.passesGate) {
    // The ONE guardrail-red phrasing (`guardrailRedNote`): blocking findings
    // named as evidence (an ephemeral runner's diff evaporates with the
    // job), and the salvage disposition for a RAN-and-BLOCKED verdict —
    // under draft-pr salvage the blocked attempt may be pushed as a RED
    // draft so the work and the exact blocking reasons survive the runner.
    // A blocked draft is NOT a resume anchor (design F): the next run starts
    // fresh with the blocking set as a negative constraint. An UNRUNNABLE
    // guardrail stays absolute: an unverified diff is never pushed.
    return finish({
      outcome: 'guardrail-red',
      ...common,
      note: guardrailRedNote(guardrail, effectiveSalvage),
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
      effectiveSalvage === 'draft-pr'
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
