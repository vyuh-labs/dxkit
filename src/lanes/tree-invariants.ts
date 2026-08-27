/**
 * The frame's tree-invariant step (4.4.6): re-establish every frame-owned
 * invariant an order's diff tripped, BEFORE that order is verified. ONE
 * executor for every caller (the recipe phase after each recipe group, the
 * orders phase after each agent order), reading the ONE collector
 * (`collectTreeInvariants`) and the ONE contract renderer the prompt reads,
 * so what the agent was told, what the frame does, and what the ledger
 * says are one definition (Rule 2.30).
 *
 * Per applicable invariant, in order:
 *
 *   1. VERIFY first. Holds already: `already-consistent`, nothing touched
 *      (an override-pin recipe resyncs itself; the step confirms and moves
 *      on).
 *   2. RE-ESTABLISH through the ONE install executor (`runInstall`: the
 *      declared ladder under the repo's authorized tolerances, never a
 *      blanket retry). No declared command: `could-not-reestablish`,
 *      reason named.
 *   3. VERIFY again. Passes: `reestablished`, with the working-tree paths
 *      the re-establishment rewrote (the caller commits them as the frame's
 *      own; an agent's hand edit to an owned path is thereby REPLACED by the
 *      tool's truth). Fails: `could-not-reestablish` at `verify`. A declared
 *      verify skip (an ecosystem with no dry-run) is disclosed on the
 *      outcome; the tree verification's frozen install stays the backstop.
 *
 * Policy, owned here: infrastructure (a missing manager, a timeout, a
 * capture overflow) is `could-not-reestablish` with the infrastructure
 * named. It is NOT fail-open: the agent changed a manifest and the frame
 * cannot make the tree coherent, so landing would break CI's install; the
 * order fails at this step, honestly, and stays open. SECURITY (Rule 17):
 * the step executes package-manager commands, so it gates on the REQUIRED
 * trust context itself: an untrusted tree yields `skipped-untrusted`, which
 * also fails the step (nothing was re-established), never a spawn.
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import type { CommandExec } from '../analyzers/tools/bounded-exec';
import { tail } from '../analyzers/tools/bounded-exec';
import { executeLockfileCheck } from '../analyzers/correctness/lockfile-check';
import { describeInfrastructure, runInstall } from '../install/run';
import type { ResolvedTolerances } from '../install/tolerances';
import type { LanguageId } from '../languages/types';
import {
  installCommandText,
  type InstallCommand,
} from '../languages/capabilities/install-strategy';
import {
  renderTreeInvariantContract,
  type TreeInvariant,
} from '../languages/capabilities/tree-invariants';
import * as path from 'path';

/** One invariant's outcome, as disclosed per order. */
export type TreeInvariantOutcome =
  | {
      readonly id: string;
      readonly pack: string;
      readonly root: string;
      readonly status: 'already-consistent';
    }
  | {
      readonly id: string;
      readonly pack: string;
      readonly root: string;
      readonly status: 'reestablished';
      /** The re-establishing command that ran (the primary, or the
       *  fallback that answered a tolerated failure). */
      readonly command: string;
      /** Working-tree paths the re-establishment rewrote; the caller
       *  commits them as the frame's own. */
      readonly changedPaths: readonly string[];
      /** `verified`, or the disclosed reason the check could not run. */
      readonly verification: 'verified' | { readonly skipped: string };
      readonly note?: string;
    }
  | {
      readonly id: string;
      readonly pack: string;
      readonly root: string;
      readonly status: 'could-not-reestablish';
      readonly step: 'reestablish' | 'verify';
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly pack: string;
      readonly root: string;
      readonly status: 'skipped-untrusted';
      readonly reason: string;
    };

export interface TreeInvariantStepResult {
  /** Outcomes of the invariants that APPLIED, in collector order. */
  readonly applied: readonly TreeInvariantOutcome[];
  /** Ids of the collected invariants the diff did not trip. */
  readonly notApplicable: readonly string[];
  /** Every working-tree path the step rewrote (union over `reestablished`). */
  readonly changedPaths: readonly string[];
  /** True when any applicable invariant could not be re-established: the
   *  order fails at this step. */
  readonly failed: boolean;
}

/** The step's inputs; everything spawnable is injected. */
export interface TreeInvariantStepInput {
  readonly cwd: string;
  readonly trust: AnalysisTrustContext;
  /** The paths the order changed (committed diff for an agent order, the
   *  in-envelope delta for a recipe group). */
  readonly changedPaths: readonly string[];
  readonly invariants: readonly TreeInvariant[];
  readonly exec: CommandExec;
  readonly tolerances: ResolvedTolerances;
  /** The uncommitted working-tree paths, read before and after each
   *  re-establishment to attribute what it rewrote. Throws when the tree
   *  cannot be read; the invariant then fails at `reestablish`. */
  readonly workingTreePaths: () => readonly string[];
}

/** The bound step every frame caller holds (a test may replace it whole):
 *  the repo, trust, packs, exec and tolerances are bound once per run. */
export type TreeInvariantStep = (input: {
  readonly changedPaths: readonly string[];
}) => TreeInvariantStepResult;

const NONE: TreeInvariantStepResult = {
  applied: [],
  notApplicable: [],
  changedPaths: [],
  failed: false,
};

/** The step over an already-collected invariant list. */
export function reestablishTreeInvariants(input: TreeInvariantStepInput): TreeInvariantStepResult {
  if (input.invariants.length === 0) return NONE;
  const applied: TreeInvariantOutcome[] = [];
  const notApplicable: string[] = [];
  const changed = new Set<string>();
  let failed = false;
  for (const inv of input.invariants) {
    if (!inv.appliesWhen(input.changedPaths)) {
      notApplicable.push(inv.id);
      continue;
    }
    const outcome = reestablishOne(inv, input);
    applied.push(outcome);
    if (outcome.status === 'reestablished') {
      for (const p of outcome.changedPaths) changed.add(p);
    } else if (outcome.status !== 'already-consistent') {
      failed = true;
    }
  }
  return { applied, notApplicable, changedPaths: [...changed], failed };
}

type Verify =
  | { readonly holds: true; readonly note?: string }
  | { readonly holds: false; readonly reason: string }
  | { readonly holds: 'unknown'; readonly skipped: string };

function verifyOne(inv: TreeInvariant, rootAbs: string, exec: CommandExec): Verify {
  if (inv.verify.kind === 'none') return { holds: 'unknown', skipped: inv.verify.reason };
  const r = executeLockfileCheck(inv.pack as LanguageId, inv.verify, rootAbs, exec);
  if (r.status === 'pass') return r.note ? { holds: true, note: r.note } : { holds: true };
  if (r.status === 'fail') return { holds: false, reason: tail(r.output ?? 'the check failed') };
  return { holds: 'unknown', skipped: `${r.status}${r.output ? `: ${r.output}` : ''}` };
}

function reestablishOne(inv: TreeInvariant, input: TreeInvariantStepInput): TreeInvariantOutcome {
  const base = { id: inv.id, pack: inv.pack, root: inv.root };
  if (!input.trust.repoExecutionAllowed) {
    return {
      ...base,
      status: 'skipped-untrusted',
      reason:
        `repo execution is not allowed under this trust context (${input.trust.source}); ` +
        're-establishing an invariant runs package-manager commands, so nothing spawned',
    };
  }
  const rootAbs = inv.root === '' ? input.cwd : path.join(input.cwd, inv.root);
  const before = verifyOne(inv, rootAbs, input.exec);
  if (before.holds === true) return { ...base, status: 'already-consistent' };
  if (inv.reestablish === null) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason:
        `the ${inv.pack} pack declares no command that re-establishes ${inv.id}` +
        (before.holds === false ? `; the check fails: ${before.reason}` : ''),
    };
  }
  let pre: Set<string>;
  try {
    pre = new Set(input.workingTreePaths());
  } catch (err) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: `could not read the working tree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const run = runInstall(inv.reestablish, rootAbs, input.exec, input.tolerances);
  if (run.status === 'infrastructure') {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: describeInfrastructure(run),
    };
  }
  if (run.status === 'failed') {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: `\`${installCommandText(run.command)}\` failed (${run.classification}): ${tail(run.output)}`,
    };
  }
  const after = verifyOne(inv, rootAbs, input.exec);
  if (after.holds === false) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'verify',
      reason: `\`${installCommandText(run.command)}\` ran, but the check still fails: ${after.reason}`,
    };
  }
  let changedPaths: string[];
  try {
    changedPaths = input.workingTreePaths().filter((p) => !pre.has(p));
  } catch (err) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'verify',
      reason: `could not read the working tree after re-establishing: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const ran: InstallCommand = run.fallback ? run.fallback.command : run.command;
  return {
    ...base,
    status: 'reestablished',
    command: installCommandText(ran),
    changedPaths,
    verification: after.holds === true ? 'verified' : { skipped: after.skipped },
    ...(run.fallback
      ? { note: run.fallback.disclosure }
      : after.holds === true && after.note
        ? { note: after.note }
        : {}),
  };
}

/** One line per outcome for a ledger. */
export function describeTreeInvariantOutcome(o: TreeInvariantOutcome): string {
  const where = `${o.id} (${o.pack}, ${o.root === '' ? 'repo root' : o.root})`;
  switch (o.status) {
    case 'already-consistent':
      return `${where}: already consistent, nothing re-established`;
    case 'reestablished':
      return (
        `${where}: RE-ESTABLISHED by \`${o.command}\`` +
        (o.changedPaths.length > 0
          ? `, rewrote ${o.changedPaths.join(', ')}`
          : ', no file changed') +
        (o.verification === 'verified'
          ? ', re-checked'
          : `, re-check skipped (${o.verification.skipped}); the tree verification's frozen install is the backstop`) +
        (o.note ? ` (${o.note})` : '')
      );
    case 'could-not-reestablish':
      return `${where}: COULD NOT be re-established at ${o.step}: ${o.reason}`;
    case 'skipped-untrusted':
      return `${where}: not re-established, ${o.reason}`;
  }
}

/** The contract lines for a prompt, from the same invariants the step applies. */
export function renderTreeInvariantContracts(invariants: readonly TreeInvariant[]): string[] {
  return invariants.map((inv) => `- ${renderTreeInvariantContract(inv)}`);
}
