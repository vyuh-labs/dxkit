/**
 * The ONE tree verification the scheduled lanes share with CI (4.4.5, Rule
 * 2.30: one concept, one code path).
 *
 * The class this module closes: the remediate lane verified the agent's
 * DIRTY workspace, with whatever `node_modules` the agent last installed,
 * at full scope with an empty changed-set. CI verifies a different tree: a
 * clean checkout, a fresh frozen-lockfile install, then the gate. A draft
 * whose package.json had moved ahead of its lockfile was pushed as
 * "verified"; CI's `npm ci` died with EUSAGE before any gate ran and the PR
 * read "NOT gated". Two verifications of one concept, drifted.
 *
 * `verifyTree` verifies a candidate head the way CI does, in order:
 *
 *   1. a CLEAN worktree of that head (Rule 11's `withRefWorktree`, never a
 *      second `git worktree add`);
 *   2. the repo's frozen install with the repo's own fallback
 *      (`frozenInstallFor`, the same table the CI templates render from);
 *   3. the correctness floor DIFF-SCOPED against `baseHead` (`changedFiles`
 *      from the one changed-files primitive; the runner escalates to full on
 *      a manifest change and runs the lockfile-sync check there);
 *   4. attribution vs the entry floor through the ONE comparator;
 *   5. the guardrail.
 *
 * Fail-open discipline, the `GateFailure` shape: every infrastructure
 * failure (a ref that cannot be checked out, a package manager not on PATH,
 * a throw anywhere) is a DISCLOSED step failure with the step named, never a
 * silent pass and never a false block. An install that RAN and failed is not
 * infrastructure: it is the exact defect this module exists to catch, so it
 * is its own verdict (`install-failed`). The consumer decides what an
 * unverifiable tree means for landing (the agent lane: nothing lands).
 *
 * Every step is injectable (`seams`) so the composition is unit-testable
 * without a git repo, a package manager, or a scanner toolchain.
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../analyzers/correctness/run';
import { makeCommandExec, tail, type CommandExec } from '../analyzers/tools/bounded-exec';
import {
  attributeFloorFailures,
  type AttributedFloorFailure,
  type FloorBaseCheck,
} from '../analyzers/correctness/attribution';
import { computeChangedFiles } from '../baseline/changed-files';
import { captureGateFailure, type GateFailure } from '../baseline/gate-failopen';
import { withRefWorktree, type RefWorktreeOptions } from '../baseline/ref-baseline';
import { detectActiveLanguages } from '../languages';
import { frozenInstallFor } from '../package-manager';
import { guardrailVerdictFor, toFloorBaseChecks, type GuardrailGateResult } from './verify';

/** How the frozen install of the candidate tree went. */
export type InstallOutcome =
  | {
      readonly status: 'installed';
      readonly argv: readonly string[];
      /** Present when the primary failed and the fallback (the one CI mirrors)
       *  succeeded, with the reason the fallback exists. Disclosed. */
      readonly fallback?: { readonly argv: readonly string[]; readonly reason: string };
    }
  | { readonly status: 'failed'; readonly argv: readonly string[]; readonly output: string }
  /** The repo has no package.json: nothing to install, nothing claimed. */
  | { readonly status: 'nothing-to-install' };

export type VerifyTreeVerdict =
  /** Clean worktree installs, the floor has no net-new failure, the guardrail passes. */
  | 'verified'
  /** The frozen install of the candidate tree FAILED: CI could not install
   *  this tree, so no gate would ever run on it. */
  | 'install-failed'
  /** The floor has a NET-NEW failure vs the entry floor. */
  | 'floor-red'
  /** The guardrail ran and did not pass (BLOCKED or the CANNOT-GATE tier). */
  | 'guardrail-red'
  /** Verification itself could not run: `failure` names the step. */
  | 'error';

export interface VerifyTreeResult {
  readonly verdict: VerifyTreeVerdict;
  readonly install?: InstallOutcome;
  /** Repo-relative files the candidate changed vs `baseHead` (empty when the
   *  diff was undeterminable, which the floor treats as full scope). */
  readonly changedFiles?: readonly string[];
  readonly floor?: CorrectnessFloorResult;
  readonly floorAttribution?: readonly AttributedFloorFailure[];
  readonly guardrail?: GuardrailGateResult;
  /** Present on `error`: the step that failed and why. */
  readonly failure?: GateFailure;
}

/** Injection points, one per step, so the composition is testable without a
 *  repo. Production callers omit them all. */
export interface VerifyTreeSeams {
  readonly worktree?: <T>(
    opts: RefWorktreeOptions,
    fn: (worktreePath: string) => Promise<T>,
  ) => Promise<T>;
  readonly install?: (worktreePath: string) => InstallOutcome;
  readonly changedFiles?: (worktreePath: string, baseHead: string) => readonly string[] | null;
  readonly runFloor?: (args: {
    readonly cwd: string;
    readonly changedFiles: readonly string[];
  }) => CorrectnessFloorResult;
  readonly runGuardrail?: (worktreePath: string) => Promise<GuardrailGateResult>;
}

export interface VerifyTreeOptions {
  /** The repo whose object database holds `head` (the lane's checkout). */
  readonly cwd: string;
  /** The candidate commit to verify. */
  readonly head: string;
  /** The commit the candidate is diffed against for floor scope. */
  readonly baseHead: string;
  readonly trust: AnalysisTrustContext;
  /** The entry floor (captured on the pristine base) the candidate's floor is
   *  attributed against. Absent = every failure is unattributed (disclosed,
   *  never blocked). */
  readonly entryFloor?: CorrectnessFloorResult;
  /** What an ABSENT base check means for attribution (see
   *  `attributeFloorFailures`); the remediate lane, whose entry floor always
   *  ran, passes `'net-new'`. */
  readonly absentMeans: 'net-new' | 'unattributed';
  /** Per-command budget for the install + floor commands (ms). */
  readonly timeoutMs?: number;
  /** Progress hook, called as each step begins (the lane's heartbeat). */
  readonly onStep?: (step: VerifyTreeStep) => void;
  readonly seams?: VerifyTreeSeams;
}

/** The steps, in order; also the `GateFailure.step` vocabulary. */
export type VerifyTreeStep =
  | 'worktree'
  | 'install'
  | 'changed-files'
  | 'floor'
  | 'attribution'
  | 'guardrail';

/**
 * Run the repo's frozen install in a worktree: the primary, then the declared
 * fallback when the primary fails (the CI template's `a || b`). A package
 * manager that is not on PATH THROWS (infrastructure: the caller's catch
 * turns it into a disclosed step failure, never an install verdict).
 */
export function runFrozenInstall(worktreePath: string, exec: CommandExec): InstallOutcome {
  const plan = frozenInstallFor(worktreePath);
  if (plan === null) return { status: 'nothing-to-install' };
  const [bin, ...args] = plan.argv;
  const primary = exec({ bin, args }, worktreePath);
  if (!primary.available) {
    throw new Error(
      `${plan.pm} is not available in the verification environment` +
        (primary.output ? `: ${primary.output}` : ''),
    );
  }
  if (primary.code === 0 && !primary.timedOut && !primary.overflowed) {
    return { status: 'installed', argv: plan.argv };
  }
  if (plan.fallback) {
    const [fbin, ...fargs] = plan.fallback.argv;
    const fallback = exec({ bin: fbin, args: fargs }, worktreePath);
    if (fallback.available && fallback.code === 0 && !fallback.timedOut && !fallback.overflowed) {
      return { status: 'installed', argv: plan.argv, fallback: plan.fallback };
    }
    return {
      status: 'failed',
      argv: plan.fallback.argv,
      output: tail(
        `${primary.output}\n--- fallback (${plan.fallback.argv.join(' ')}) ---\n${fallback.output}`,
      ),
    };
  }
  return {
    status: 'failed',
    argv: plan.argv,
    output: tail(primary.timedOut ? `${primary.output}\n(timed out)` : primary.output),
  };
}

/** Verify a candidate head the way CI would. Never throws. */
export async function verifyTree(opts: VerifyTreeOptions): Promise<VerifyTreeResult> {
  const seams = opts.seams ?? {};
  const exec = makeCommandExec(opts.timeoutMs);
  const worktree = seams.worktree ?? withRefWorktree;
  const install = seams.install ?? ((wt: string) => runFrozenInstall(wt, exec));
  const changed = seams.changedFiles ?? computeChangedFiles;
  const runFloor =
    seams.runFloor ??
    ((args: { cwd: string; changedFiles: readonly string[] }) =>
      runCorrectnessFloor({
        cwd: args.cwd,
        changedFiles: args.changedFiles,
        scope: 'affected',
        packs: detectActiveLanguages(args.cwd),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }));
  const runGuardrail = seams.runGuardrail ?? ((wt: string) => guardrailVerdictFor(wt, opts.trust));
  const baseChecks: FloorBaseCheck[] = opts.entryFloor ? toFloorBaseChecks(opts.entryFloor) : [];

  // The step being executed, so a throw anywhere names WHERE it broke.
  let step: VerifyTreeStep = 'worktree';
  const enter = (s: VerifyTreeStep): void => {
    step = s;
    opts.onStep?.(s);
  };
  try {
    enter('worktree');
    return await worktree({ cwd: opts.cwd, ref: opts.head }, async (wt) => {
      enter('install');
      const installed = install(wt);
      if (installed.status === 'failed') return { verdict: 'install-failed', install: installed };

      enter('changed-files');
      const changedFiles = changed(wt, opts.baseHead) ?? [];

      enter('floor');
      const floor = runFloor({ cwd: wt, changedFiles });
      enter('attribution');
      const floorAttribution = attributeFloorFailures(floor, baseChecks, {
        absentMeans: opts.absentMeans,
      });
      const partial = { install: installed, changedFiles, floor, floorAttribution };
      if (floorAttribution.some((a) => a.attribution === 'net-new')) {
        return { verdict: 'floor-red', ...partial };
      }

      enter('guardrail');
      const guardrail = await runGuardrail(wt);
      if (!guardrail.ran) {
        return {
          verdict: 'error',
          ...partial,
          guardrail,
          failure: { step, message: guardrail.verdict },
        };
      }
      return {
        verdict: guardrail.passesGate ? 'verified' : 'guardrail-red',
        ...partial,
        guardrail,
      };
    });
  } catch (err) {
    return { verdict: 'error', failure: captureGateFailure(step, err) };
  }
}

/** One-line disclosure of the install step for a ledger. */
export function describeInstall(install: InstallOutcome | undefined): string | null {
  if (!install) return null;
  switch (install.status) {
    case 'nothing-to-install':
      return 'Install: nothing to install (no package.json).';
    case 'installed':
      return install.fallback
        ? `Install: \`${install.argv.join(' ')}\` failed, \`${install.fallback.argv.join(' ')}\` ` +
            `succeeded (${install.fallback.reason}).`
        : `Install: \`${install.argv.join(' ')}\` succeeded on a clean checkout.`;
    case 'failed':
      return `Install: \`${install.argv.join(' ')}\` FAILED on a clean checkout (CI cannot install this tree).`;
  }
}
