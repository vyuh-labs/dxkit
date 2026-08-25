/**
 * Completion of a RECIPE-ONLY remediate run (split from `../run.ts` at the
 * module-size bar): when every order the task selected was recipe-tier, the
 * run finishes without any agent spawn, with the ONE tree verification still
 * arbitrates the combined recipe commits exactly as it would an agent's
 * (install, diff-scoped floor attributed vs entry, guardrail). A $0 run is
 * never a self-certified run.
 */
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import type { RemediateGit, RemediateResult, RemediateRunOptions } from '../outcome';
import type { RemediateTask } from '../tasks';
import { installFailedNote, verifyCommittedHead } from '../verify';
import { recipeCounts, runRecipePhaseForTask, type RecipePhaseSummary } from './run-recipes';

type Partial = Omit<RemediateResult, 'ledger' | 'dispatch' | 'resume'>;

/**
 * The frame's recipe-tier step: run the phase (never throwing past this
 * function; a broken plan is a disclosed `planError` and the agent path
 * proceeds), and when EVERY selected order was recipe-tier, complete the
 * run here. `done` present = the runner finishes with it; absent = the
 * agent path continues with `recipes` disclosed.
 */
export async function recipeTierStep(
  opts: RemediateRunOptions,
  args: {
    readonly task: Pick<RemediateTask, 'id'>;
    readonly entryFloor: CorrectnessFloorResult;
    readonly baseHead: string;
    readonly git: RemediateGit;
    readonly runFloor: () => CorrectnessFloorResult;
  },
): Promise<{ recipes: RecipePhaseSummary; done?: Partial }> {
  let recipes: RecipePhaseSummary;
  try {
    recipes = await (opts.runRecipePhase ?? runRecipePhaseForTask)({
      cwd: opts.cwd,
      trust: opts.trust,
      taskId: args.task.id,
      config: opts.config,
      entryFloor: args.entryFloor,
    });
  } catch (err) {
    recipes = {
      ran: false,
      planError: err instanceof Error ? err.message : String(err),
      disclosures: [],
      selectedRecipeTier: 0,
      selectedAgentTier: 0,
      records: [],
    };
  }
  const selected = recipes.selectedRecipeTier + recipes.selectedAgentTier;
  if (selected === 0 || recipes.selectedAgentTier > 0) return { recipes };
  const done = await completeRecipeOnlyRun(opts, {
    taskId: args.task.id,
    recipes,
    baseHead: args.baseHead,
    head: args.git.head(),
    hasDiff: args.git.hasDiff(args.baseHead),
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  return { recipes, done };
}

export interface RecipeOnlyArgs {
  readonly taskId: RemediateTask['id'];
  readonly recipes: RecipePhaseSummary;
  readonly baseHead: string;
  readonly head: string;
  readonly hasDiff: boolean;
  readonly entryFloor: CorrectnessFloorResult;
  readonly runFloor: () => CorrectnessFloorResult;
}

export async function completeRecipeOnlyRun(
  opts: RemediateRunOptions,
  args: RecipeOnlyArgs,
): Promise<Partial> {
  const counts = recipeCounts(args.recipes);
  const zeroDollar = 'No agent was spawned: every selected work order was recipe-tier ($0 run).';
  if (!args.hasDiff) {
    return {
      outcome: 'no-op',
      task: args.taskId,
      floor: args.entryFloor,
      recipes: args.recipes,
      note:
        `${zeroDollar} No recipe applied a change (${counts.refused} refused, ` +
        `${counts.failed} failed); per-order reasons are in the recipe section below.`,
    };
  }
  const { verified, guardrail } = await verifyCommittedHead(opts, {
    head: args.head,
    baseHead: args.baseHead,
    entryFloor: args.entryFloor,
    runFloor: args.runFloor,
  });
  const common = {
    task: args.taskId,
    recipes: args.recipes,
    ...(verified.floor ? { floor: verified.floor } : {}),
    ...(verified.floorAttribution ? { floorAttribution: verified.floorAttribution } : {}),
    ...(verified.install ? { install: verified.install } : {}),
    ...(verified.changedFiles ? { changedFiles: verified.changedFiles } : {}),
    guardrailVerdict: guardrail.verdict,
    baseHead: args.baseHead,
    head: args.head,
  };
  if (verified.verdict === 'install-failed') {
    return { outcome: 'install-failed', ...common, note: installFailedNote(verified) };
  }
  if (verified.verdict === 'floor-red') {
    return {
      outcome: 'floor-red',
      ...common,
      note:
        'the correctness floor has NET-NEW failures after the recipe commits (the entry ' +
        'floor did not have them), so nothing lands. A recipe that breaks the build gets the ' +
        'same truthful failure an agent would.',
    };
  }
  if (!guardrail.ran || !guardrail.passesGate) {
    return {
      outcome: 'guardrail-red',
      ...common,
      note: guardrail.ran
        ? `the guardrail did not pass (${guardrail.verdict}), so nothing merges. The recipe ` +
          'commits stay on the branch for inspection.'
        : `the guardrail could not run (${guardrail.verdict}), so nothing lands. A recipe ` +
          'diff is never pushed unverified.',
    };
  }
  return {
    outcome: 'verified',
    ...common,
    note: `${zeroDollar} ${counts.applied} order(s) applied and verified the way CI verifies.`,
  };
}
