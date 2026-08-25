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
 *   2. the diff vs `baseHead` — computed BEFORE the install, so install
 *      artifacts (a rewritten lockfile, an unignored node_modules) can never
 *      read as the agent's changed files;
 *   3. the repo's frozen install with the repo's own fallback
 *      (`frozenInstallFor`, the same table the CI templates render from).
 *      A failed install is ATTRIBUTED like a floor failure: the same install
 *      is probed at `baseHead`, and a failure that predates the change is
 *      PRE-EXISTING — disclosed, never blamed on the candidate;
 *   4. the correctness floor DIFF-SCOPED (the runner escalates to full on a
 *      manifest change and runs the lockfile-sync check there);
 *   5. attribution vs the entry floor through the ONE comparator;
 *   6. the guardrail.
 *
 * SECURITY (Rule 17): the install runs the repo's lifecycle scripts and the
 * floor runs repo-declared commands, so the seam gates on the REQUIRED trust
 * context itself — an untrusted tree yields a disclosed `skipped-untrusted`
 * verdict before anything spawns, by design rather than caller convention.
 *
 * Fail-open discipline, the `GateFailure` shape: every infrastructure
 * failure (a ref that cannot be checked out, a package manager not on PATH,
 * an install that timed out or overflowed the capture buffer, a throw
 * anywhere) is a DISCLOSED step failure with the step named, never a silent
 * pass and never a false block. An install that RAN TO COMPLETION and failed
 * is not infrastructure: it is the exact defect this module exists to catch,
 * so it is its own verdict (`install-failed`) — once the base probe rules
 * out a pre-existing break. The consumer decides what an unverifiable tree
 * means for landing (the agent lane: nothing lands).
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
  | {
      readonly status: 'failed';
      readonly argv: readonly string[];
      readonly output: string;
      /** True when the SAME frozen install also fails at `baseHead`: the
       *  break predates the candidate. Disclosed, never blamed on the change
       *  — verification proceeds (the floor's pre-existing doctrine applied
       *  to the install). */
      readonly preExisting?: boolean;
    }
  /** The repo has no package.json: nothing to install, nothing claimed. */
  | { readonly status: 'nothing-to-install' };

export type VerifyTreeVerdict =
  /** Clean worktree installs, the floor has no net-new failure, the guardrail passes. */
  | 'verified'
  /** The frozen install of the candidate tree FAILED where the base's did
   *  not: CI could not install this tree, and the change is the cause. */
  | 'install-failed'
  /** The floor has a NET-NEW failure vs the entry floor. */
  | 'floor-red'
  /** The guardrail ran and did not pass (BLOCKED or the CANNOT-GATE tier). */
  | 'guardrail-red'
  /** The trust context does not allow repo execution here: nothing spawned,
   *  nothing verified. `failure` carries the disclosure (step `trust`). */
  | 'skipped-untrusted'
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
  /** Present on `error` (the step that failed and why) and on
   *  `skipped-untrusted` (the trust disclosure, step `trust`). */
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

/** The steps, in order; also the `GateFailure.step` vocabulary (plus `trust`,
 *  the pre-spawn refusal that precedes them all). `base-install` runs only
 *  when the candidate install failed — the attribution probe. */
export type VerifyTreeStep =
  | 'worktree'
  | 'changed-files'
  | 'install'
  | 'base-install'
  | 'floor'
  | 'attribution'
  | 'guardrail';

/** Phrase an infrastructure-shaped exec end (timeout / capture overflow), or
 *  null when the command ran to completion. */
function infraEnd(timedOut?: boolean, overflowed?: boolean): string | null {
  if (timedOut) return 'timed out';
  if (overflowed) return 'overflowed the capture buffer';
  return null;
}

/**
 * Run the repo's frozen install in a worktree: the primary, then the declared
 * fallback when the primary fails (the CI template's `a || b`). Infrastructure
 * THROWS — a package manager missing from PATH, a timeout, a capture overflow
 * (on the primary or the fallback alike) say nothing about the tree, so the
 * caller's catch turns them into a disclosed step failure, never an install
 * verdict (the bounded-exec fail-open doctrine).
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
  const primaryInfra = infraEnd(primary.timedOut, primary.overflowed);
  if (primaryInfra !== null) {
    throw new Error(
      `frozen install (\`${plan.argv.join(' ')}\`) ${primaryInfra} — infrastructure, not a verdict on the tree`,
    );
  }
  if (primary.code === 0) return { status: 'installed', argv: plan.argv };
  if (plan.fallback) {
    const [fbin, ...fargs] = plan.fallback.argv;
    const fallback = exec({ bin: fbin, args: fargs }, worktreePath);
    if (!fallback.available) {
      throw new Error(
        `${plan.pm} is not available in the verification environment` +
          (fallback.output ? `: ${fallback.output}` : ''),
      );
    }
    const fallbackInfra = infraEnd(fallback.timedOut, fallback.overflowed);
    if (fallbackInfra !== null) {
      throw new Error(
        `frozen install fallback (\`${plan.fallback.argv.join(' ')}\`) ${fallbackInfra} — ` +
          'infrastructure, not a verdict on the tree',
      );
    }
    if (fallback.code === 0) {
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
  return { status: 'failed', argv: plan.argv, output: tail(primary.output) };
}

/** Verify a candidate head the way CI would. Never throws. */
export async function verifyTree(opts: VerifyTreeOptions): Promise<VerifyTreeResult> {
  // Rule 17, decided by the seam itself: the install runs lifecycle scripts
  // and the floor runs repo-declared commands, so an untrusted tree gets a
  // disclosed refusal BEFORE any worktree exists or any command spawns.
  if (!opts.trust.repoExecutionAllowed) {
    return {
      verdict: 'skipped-untrusted',
      failure: {
        step: 'trust',
        message:
          `repo execution is not allowed under this trust context (${opts.trust.source}) — ` +
          'the frozen install and the correctness floor execute repo-declared commands, so ' +
          'an untrusted tree is never verified here',
      },
    };
  }
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
      // The diff FIRST, on the pristine checkout: an install can rewrite the
      // lockfile or drop node_modules into an unignored tree, and those
      // artifacts must never read as the agent's changed files (they would
      // force a manifest escalation and misattribute the diff).
      enter('changed-files');
      const changedFiles = changed(wt, opts.baseHead) ?? [];

      enter('install');
      let installed = install(wt);
      if (installed.status === 'failed') {
        // Attribute before blaming (the floor's doctrine applied to the
        // install): probe the SAME frozen install at baseHead. A lockfile
        // already drifted at the base fails there too — pre-existing debt,
        // disclosed, never pinned on the candidate; verification proceeds.
        enter('base-install');
        const baseOutcome = await worktree({ cwd: opts.cwd, ref: opts.baseHead }, async (bwt) =>
          install(bwt),
        );
        if (baseOutcome.status === 'failed') {
          installed = { ...installed, preExisting: true };
        } else {
          return { verdict: 'install-failed', install: installed, changedFiles };
        }
      }

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
      return install.preExisting
        ? `Install: \`${install.argv.join(' ')}\` fails on a clean checkout of the BASE too — ` +
            'pre-existing (not caused by this change), disclosed. CI installs will keep failing ' +
            'until the lockfile is repaired on the default branch.'
        : `Install: \`${install.argv.join(' ')}\` FAILED on a clean checkout (CI cannot install this tree).`;
  }
}
