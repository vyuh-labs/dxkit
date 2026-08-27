/**
 * The frame's tree-invariant step (4.4.6): re-establish every frame-owned
 * invariant an order's diff tripped, BEFORE that order is verified. ONE
 * executor for every caller (the recipe phase after each recipe group, the
 * orders phase after each agent order, the legacy task path after the
 * agent), reading the ONE collector (`collectTreeInvariants`) and the ONE
 * contract renderer the prompt reads, so what the agent was told, what the
 * frame does, and what the ledger says are one definition (Rule 2.30).
 *
 * Per applicable invariant, in order:
 *
 *   1. VERIFY first. Holds already: `already-consistent`, nothing touched
 *      (an override-pin recipe resyncs itself; the step confirms and moves
 *      on).
 *   2. ATTRIBUTE before blaming (the verifyTree base-install doctrine): a
 *      failing check is probed at the ORDER BASE through `baseVerify`. A
 *      check that fails at the base too is PRE-EXISTING drift: disclosed,
 *      never the order's fault, and the frame does NOT re-establish it (a
 *      whole-root rewrite of unrelated drift must not ride an order's PR).
 *   3. RE-ESTABLISH through the ONE install executor (`runInstall`: the
 *      declared ladder under the repo's authorized tolerances, never a
 *      blanket retry). No declared command: `could-not-reestablish`,
 *      reason named.
 *   4. VERIFY again. Passes: `reestablished`, with the working-tree paths
 *      the re-establishment rewrote (the caller commits them as the frame's
 *      own; an agent's hand edit to an owned path is thereby REPLACED by the
 *      tool's truth). Fails: `could-not-reestablish` at `verify`. A declared
 *      verify skip (an ecosystem with no dry-run) is disclosed on the
 *      outcome; the tree verification's frozen install stays the backstop.
 *
 * Touched-path accounting holds on EVERY exit path, success and failure
 * alike: each outcome carries the paths the step rewrote (new paths plus
 * owned paths it touched, even ones that were already dirty before the
 * step, which are additionally disclosed as `preDirtyOwned`), so a caller
 * that drops the order can restore exactly what the step touched.
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
      /** The check fails at the ORDER BASE too: the drift predates the
       *  order. Disclosed, never blamed on the order, and deliberately not
       *  re-established here (unrelated pre-existing drift must not be
       *  rewritten inside an order's PR). */
      readonly status: 'pre-existing';
      readonly reason: string;
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
      /** Owned paths that were ALREADY dirty before the step ran (their
       *  content is included in `changedPaths` when still touched):
       *  disclosed so the rewrite is never silent. */
      readonly preDirtyOwned?: readonly string[];
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
      /** What the FAILED attempt still touched (a partial resync rewrote
       *  the lockfile before dying): the caller's discard set must be able
       *  to restore everything the step touched. */
      readonly changedPaths: readonly string[];
      readonly preDirtyOwned?: readonly string[];
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
  /** Every working-tree path the step rewrote (union over the applied
   *  outcomes, failures included). */
  readonly changedPaths: readonly string[];
  /** Collector + step disclosures (a changed manifest under no resolvable
   *  root, a base probe that could not answer): rendered per order. */
  readonly disclosures: readonly string[];
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
  /** Collector disclosures, passed through to the result. */
  readonly disclosures?: readonly string[];
  readonly exec: CommandExec;
  readonly tolerances: ResolvedTolerances;
  /** The uncommitted working-tree paths, read before and after each
   *  re-establishment to attribute what it rewrote. Throws when the tree
   *  cannot be read; the invariant then fails at `reestablish`. */
  readonly workingTreePaths: () => readonly string[];
  /** Does the invariant's check hold at the ORDER BASE? The attribution
   *  probe (step 2). Absent = unknown (the step proceeds, disclosed). */
  readonly baseVerify?: (inv: TreeInvariant) => Promise<'holds' | 'fails' | 'unknown'>;
}

/** The bound step every frame caller holds (a test may replace it whole):
 *  the repo, trust, packs, exec and tolerances are bound once per run.
 *  `baseHead` anchors the pre-existing-drift probe (absent = unknown). */
export type TreeInvariantStep = (input: {
  readonly changedPaths: readonly string[];
  readonly baseHead?: string;
}) => Promise<TreeInvariantStepResult>;

const NONE: TreeInvariantStepResult = {
  applied: [],
  notApplicable: [],
  changedPaths: [],
  disclosures: [],
  failed: false,
};

/** The step over an already-collected invariant list. */
export async function reestablishTreeInvariants(
  input: TreeInvariantStepInput,
): Promise<TreeInvariantStepResult> {
  if (input.invariants.length === 0) {
    return { ...NONE, disclosures: input.disclosures ?? [] };
  }
  const applied: TreeInvariantOutcome[] = [];
  const notApplicable: string[] = [];
  const changed = new Set<string>();
  const disclosures = [...(input.disclosures ?? [])];
  let failed = false;
  for (const inv of input.invariants) {
    if (!inv.appliesWhen(input.changedPaths)) {
      notApplicable.push(inv.id);
      continue;
    }
    const outcome = await reestablishOne(inv, input, disclosures);
    applied.push(outcome);
    if (outcome.status === 'reestablished' || outcome.status === 'could-not-reestablish') {
      for (const p of outcome.changedPaths) changed.add(p);
    }
    if (outcome.status === 'could-not-reestablish' || outcome.status === 'skipped-untrusted') {
      failed = true;
    }
  }
  return { applied, notApplicable, changedPaths: [...changed], disclosures, failed };
}

type Verify =
  | { readonly holds: true; readonly note?: string }
  | { readonly holds: false; readonly reason: string }
  | { readonly holds: 'unknown'; readonly skipped: string };

/** Execute an invariant's check at `rootAbs` (the ONE check execution,
 *  shared with the floor via `executeLockfileCheck`). */
export function verifyInvariantAt(inv: TreeInvariant, rootAbs: string, exec: CommandExec): Verify {
  if (inv.verify.kind === 'none') return { holds: 'unknown', skipped: inv.verify.reason };
  const r = executeLockfileCheck(inv.pack as LanguageId, inv.verify, rootAbs, exec);
  if (r.status === 'pass') return r.note ? { holds: true, note: r.note } : { holds: true };
  if (r.status === 'fail') return { holds: false, reason: tail(r.output ?? 'the check failed') };
  return { holds: 'unknown', skipped: `${r.status}${r.output ? `: ${r.output}` : ''}` };
}

async function reestablishOne(
  inv: TreeInvariant,
  input: TreeInvariantStepInput,
  disclosures: string[],
): Promise<TreeInvariantOutcome> {
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
  const before = verifyInvariantAt(inv, rootAbs, input.exec);
  if (before.holds === true) return { ...base, status: 'already-consistent' };

  // Working-tree snapshot BEFORE anything can rewrite it, so every exit
  // path below (success or failure) can report what the step touched.
  let pre: Set<string>;
  try {
    pre = new Set(input.workingTreePaths());
  } catch (err) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: `could not read the working tree: ${err instanceof Error ? err.message : String(err)}`,
      changedPaths: [],
    };
  }
  const touched = (): { changedPaths: string[]; preDirtyOwned: string[] } => {
    const preDirtyOwned = inv.ownedPaths.filter((p) => pre.has(p));
    try {
      const after = input.workingTreePaths();
      const changedPaths = [
        ...new Set([
          ...after.filter((p) => !pre.has(p)),
          // An owned path the step touched counts even when it was already
          // dirty before the step (the resync rewrote its content): the
          // caller's discard set must cover it, and the pre-dirty fact is
          // disclosed rather than hidden behind the diff.
          ...inv.ownedPaths.filter((p) => after.includes(p)),
        ]),
      ];
      return { changedPaths, preDirtyOwned };
    } catch {
      return { changedPaths: [...inv.ownedPaths], preDirtyOwned };
    }
  };
  const dirt = (t: { preDirtyOwned: string[] }) =>
    t.preDirtyOwned.length > 0 ? { preDirtyOwned: t.preDirtyOwned } : {};

  // Attribution before blame (step 2): drift that exists at the ORDER BASE
  // predates the order. Disclosed, never fixed here, never a failure.
  if (before.holds === false) {
    const atBase = input.baseVerify ? await input.baseVerify(inv) : 'unknown';
    if (atBase === 'fails') {
      return {
        ...base,
        status: 'pre-existing',
        reason:
          `the check fails at the order base too, so the drift predates this order ` +
          `(${before.reason}); the frame does not rewrite pre-existing drift inside an ` +
          `order, and the tree verification attributes it the same way`,
      };
    }
    if (atBase === 'unknown' && input.baseVerify) {
      disclosures.push(
        `${inv.id} (${inv.pack}): the base-side probe could not answer; the failing check is ` +
          "treated as this order's to re-establish",
      );
    }
  }

  if (inv.reestablish === null) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason:
        `the ${inv.pack} pack declares no command that re-establishes ${inv.id}` +
        (before.holds === false ? `; the check fails: ${before.reason}` : ''),
      changedPaths: [],
      ...dirt({ preDirtyOwned: inv.ownedPaths.filter((p) => pre.has(p)) }),
    };
  }
  // The invariant's Rule 20 requirement gates the spawn, exactly as the
  // tree verification gates the strategy's own install.
  const run = runInstall(
    inv.reestablish,
    rootAbs,
    input.exec,
    input.tolerances,
    inv.execution !== undefined ? { execution: inv.execution } : undefined,
  );
  if (run.status === 'infrastructure') {
    const t = touched();
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: describeInfrastructure(run),
      changedPaths: t.changedPaths,
      ...dirt(t),
    };
  }
  if (run.status === 'failed') {
    const t = touched();
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'reestablish',
      reason: `\`${installCommandText(run.command)}\` failed (${run.classification}): ${tail(run.output)}`,
      changedPaths: t.changedPaths,
      ...dirt(t),
    };
  }
  const after = verifyInvariantAt(inv, rootAbs, input.exec);
  const t = touched();
  if (after.holds === false) {
    return {
      ...base,
      status: 'could-not-reestablish',
      step: 'verify',
      reason: `\`${installCommandText(run.command)}\` ran, but the check still fails: ${after.reason}`,
      changedPaths: t.changedPaths,
      ...dirt(t),
    };
  }
  const ran: InstallCommand = run.fallback ? run.fallback.command : run.command;
  return {
    ...base,
    status: 'reestablished',
    command: installCommandText(ran),
    changedPaths: t.changedPaths,
    ...dirt(t),
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
    case 'pre-existing':
      return `${where}: PRE-EXISTING drift, not this order's fault: ${o.reason}`;
    case 'reestablished':
      return (
        `${where}: RE-ESTABLISHED by \`${o.command}\`` +
        (o.changedPaths.length > 0
          ? `, rewrote ${o.changedPaths.join(', ')}`
          : ', no file changed') +
        (o.preDirtyOwned && o.preDirtyOwned.length > 0
          ? ` (${o.preDirtyOwned.join(', ')} carried uncommitted changes before the step)`
          : '') +
        (o.verification === 'verified'
          ? ', re-checked'
          : `, re-check skipped (${o.verification.skipped}); the tree verification's frozen install is the backstop`) +
        (o.note ? ` (${o.note})` : '')
      );
    case 'could-not-reestablish':
      return (
        `${where}: COULD NOT be re-established at ${o.step}: ${o.reason}` +
        (o.changedPaths.length > 0
          ? ` (the attempt touched ${o.changedPaths.join(', ')}, restored on drop)`
          : '')
      );
    case 'skipped-untrusted':
      return `${where}: not re-established, ${o.reason}`;
  }
}

/** The contract lines for a prompt, from the same invariants the step applies. */
export function renderTreeInvariantContracts(invariants: readonly TreeInvariant[]): string[] {
  return invariants.map((inv) => `- ${renderTreeInvariantContract(inv)}`);
}
