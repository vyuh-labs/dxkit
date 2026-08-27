/**
 * The remediate frame's binding of the tree-invariant step (4.4.6): the ONE
 * place the recipe phase and the orders phase build the step from the
 * repo (active packs, the bounded exec, the repo's tolerances, the working
 * tree reader), and the ONE place an order prompt asks which invariants
 * apply to its envelope. Both read `collectTreeInvariants`, so the contract
 * the agent is told and the step the frame runs cannot name different
 * invariants. Every spawnable edge is injectable (`FrameInvariantSeams`);
 * a test may replace the whole step.
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import { makeCommandExec, type CommandExec } from '../analyzers/tools/bounded-exec';
import { resolveTolerances, type ResolvedTolerances } from '../install/tolerances';
import { collectTreeInvariants, detectActiveLanguages } from '../languages';
import type { LanguageSupport } from '../languages/types';
import type { TreeInvariant } from '../languages/capabilities/tree-invariants';
import {
  reestablishTreeInvariants,
  renderTreeInvariantContracts,
  type TreeInvariantStep,
} from '../lanes/tree-invariants';
import { realRecipeGit, type RecipeGit } from './recipes/git';
import { REPO_WIDE_ENVELOPE, type WorkOrderEnvelope } from './work-orders/types';

export interface FrameInvariantSeams {
  readonly packs?: readonly LanguageSupport[];
  readonly exec?: CommandExec;
  readonly tolerances?: ResolvedTolerances;
  readonly git?: Pick<RecipeGit, 'changedPaths'>;
  /** Replaces the whole step (unit tests without a repo). */
  readonly step?: TreeInvariantStep;
  /** Replaces the contract-side collection (paired with `step`). */
  readonly invariantsFor?: (envelope: WorkOrderEnvelope) => readonly TreeInvariant[];
}

/** Resolve the seams once per run against the repo at `cwd`. */
function resolved(cwd: string, seams: FrameInvariantSeams) {
  let packs: readonly LanguageSupport[] | undefined = seams.packs;
  let tolerances: ResolvedTolerances | undefined = seams.tolerances;
  return {
    packs: () => (packs ??= detectActiveLanguages(cwd)),
    tolerances: () => (tolerances ??= resolveTolerances(cwd)),
  };
}

/** The frame's step for the repo at `cwd`. */
export function frameInvariantStep(
  cwd: string,
  trust: AnalysisTrustContext,
  seams: FrameInvariantSeams = {},
): TreeInvariantStep {
  if (seams.step) return seams.step;
  const lazy = resolved(cwd, seams);
  const exec = seams.exec ?? makeCommandExec();
  const git = seams.git ?? realRecipeGit(cwd);
  return (input) =>
    reestablishTreeInvariants({
      cwd,
      trust,
      changedPaths: input.changedPaths,
      invariants: collectTreeInvariants(lazy.packs(), cwd, input.changedPaths, lazy.tolerances()),
      exec,
      tolerances: lazy.tolerances(),
      workingTreePaths: () => git.changedPaths(),
    });
}

/**
 * The invariants an order's envelope can trip: those whose `appliesWhen`
 * fires on the envelope's own paths, or every collected invariant for a
 * repo-wide envelope. Rendered into the prompt as the frame's contract.
 */
export function frameInvariantsForEnvelope(
  cwd: string,
  envelope: WorkOrderEnvelope,
  seams: FrameInvariantSeams = {},
): readonly TreeInvariant[] {
  if (seams.invariantsFor) return seams.invariantsFor(envelope);
  const lazy = resolved(cwd, seams);
  const repoWide = envelope.paths.includes(REPO_WIDE_ENVELOPE);
  const all = collectTreeInvariants(lazy.packs(), cwd, envelope.paths, lazy.tolerances());
  return repoWide ? all : all.filter((inv) => inv.appliesWhen(envelope.paths));
}

/** The prompt block for an order (empty when nothing applies). */
export function frameInvariantContractLines(invariants: readonly TreeInvariant[]): string[] {
  if (invariants.length === 0) return [];
  return [
    'Frame-owned invariants (the frame re-establishes these after you finish; never do them yourself):',
    ...renderTreeInvariantContracts(invariants),
  ];
}
