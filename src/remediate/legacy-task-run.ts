/**
 * The LEGACY single-prompt task path (split from `run.ts` at the
 * module-size bar): when no order queue exists (order dispatch off, a
 * failed plan, an open-ended task), the agent runs once with the task's
 * own prompt. It is NOT exempt from the frame (review fix 8): the prompt
 * carries the same frame-owned-invariant contract an order gets
 * (repo-wide envelope), the driver gets the same install-denying tool
 * policy through its declared mechanism, and after the run the SAME
 * post-agent invariant application (`applyFrameInvariants`) re-establishes
 * what the frame owns before the one tree verification arbitrates.
 */
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import {
  guardrailRedNote,
  installFailedNote,
  verificationDisclosures,
  verifyCommittedHead,
} from './verify';
import type { AgentDriver, AgentRunResult, ResolvedModelChoice } from './driver';
import type { RemediateBudget } from './config';
import type { RemediateTask } from './tasks';
import { priorBlockingNote, resumePromptNote } from './resume';
import { budgetOverruns, budgetPromptNote } from './budget-notes';
import { evaluateScoreHinge, type HingeScores } from './score-hinge';
import { applyFrameInvariants } from './order-placement';
import {
  frameInvariantContractLines,
  frameInvariantsForEnvelope,
  frameInvariantStep,
} from './frame-invariants';
import { resolveOrderToolPolicy } from './tool-policy';
import { REPO_WIDE_ENVELOPE } from './work-orders/types';
import type { AgentEnvelope, RemediateGit, RemediateResult, RemediateRunOptions } from './outcome';
import type { RecipePhaseSummary } from './recipes/run-recipes';

/** Everything the runner accumulated before handing over. */
export interface LegacyTaskState {
  readonly task: RemediateTask;
  readonly driver: AgentDriver;
  readonly choice: ResolvedModelChoice;
  readonly budget: RemediateBudget;
  readonly effectiveSalvage: 'discard' | 'draft-pr';
  readonly envelopeBase: Omit<AgentEnvelope, 'turns' | 'costUsd' | 'failure' | 'toolPolicy'>;
  readonly git: RemediateGit;
  readonly runFloor: () => CorrectnessFloorResult;
  readonly entryFloor: CorrectnessFloorResult;
  readonly entryScores: HingeScores | undefined;
  readonly hingeProbe: (h: NonNullable<RemediateTask['scoreHinge']>) => Promise<HingeScores>;
  readonly baseHead: string;
  readonly agentBase: string;
  readonly hasRecipeCommits: boolean;
  readonly recipesDisclosure: { readonly recipes: RecipePhaseSummary };
}

export async function runLegacyTaskPath(
  opts: RemediateRunOptions,
  s: LegacyTaskState,
  finish: (r: Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>) => RemediateResult,
): Promise<RemediateResult> {
  const {
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
  } = s;
  // Budget awareness (`budgetPromptNote`): appended by the runner, the one
  // place the effective budget is known, never baked into the task prompts.
  const budgetNote = budgetPromptNote(budget);
  const resumeNote = opts.resume
    ? resumePromptNote(opts.resume.attempt, opts.resume.blockingContext)
    : '';
  // A prior BLOCKED attempt's findings constrain the legacy prompt too:
  // an empty order queue must not silently drop the negative constraint.
  const negativeNote = opts.priorBlocking ? priorBlockingNote(opts.priorBlocking) : '';
  // The legacy task path gets the SAME frame contract, tool policy and
  // post-agent invariant step as an order dispatch (review fix 8): a legacy
  // run is repo-wide, so every collected invariant is in scope, the same
  // install denial applies through the driver's declared mechanism, and the
  // agent is told what the frame owns before it is denied anything.
  const legacyToolPolicy = resolveOrderToolPolicy(driver);
  const legacyContract = frameInvariantContractLines(
    frameInvariantsForEnvelope(
      opts.cwd,
      { paths: [REPO_WIDE_ENVELOPE], manifests: true },
      opts.frameInvariants ?? {},
    ),
  );
  const contractNote = legacyContract.length > 0 ? '\n' + legacyContract.join('\n') + '\n' : '';
  const agentResult: AgentRunResult = await driver.run({
    cwd: opts.cwd,
    prompt: task.prompt + contractNote + budgetNote + resumeNote + negativeNote,
    budget: { maxTurns: budget.maxTurns, maxMinutes: budget.maxMinutes },
    model: choice.native,
    env: opts.agentEnv ?? {},
    ...(legacyToolPolicy.tools ? { tools: legacyToolPolicy.tools } : {}),
  });

  let envelope: AgentEnvelope = {
    ...envelopeBase,
    toolPolicy: legacyToolPolicy.disclosure,
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

  // The frame re-establishes what it owns on the agent's diff, through the
  // ONE post-agent application (`applyFrameInvariants`, shared with the
  // order dispatches — review fix 8): wherever the agent produced a tree,
  // the same invariants are re-established by the same code path.
  let frameDisclosure: Pick<RemediateResult, 'frameInvariants'> = {};
  if (git.hasDiff(agentBase)) {
    opts.onPhase?.('frame-invariants');
    const frame = await applyFrameInvariants({
      git,
      base: agentBase,
      invariantStep: frameInvariantStep(opts.cwd, opts.trust, opts.frameInvariants ?? {}),
      label: 'after the task run',
    });
    if (frame.outcomes.length > 0 || frame.disclosures.length > 0) {
      frameDisclosure = {
        frameInvariants: { applied: frame.outcomes, disclosures: frame.disclosures },
      };
    }
    if (frame.failure !== undefined) {
      return finish({
        outcome: 'install-failed',
        task: task.id,
        ...recipesDisclosure,
        envelope,
        floor: entryFloor,
        ...evidenceTail,
        ...frameDisclosure,
        note:
          `a frame-owned invariant could not be re-established after the agent ran ` +
          `(${frame.failure}); nothing lands. The commits stay on the branch for inspection.`,
        baseHead,
        head: git.head(),
      });
    }
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
    ...frameDisclosure,
    ...verificationDisclosures(verified, guardrail, opts.cwd),
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
