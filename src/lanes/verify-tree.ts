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
 *   3. the install every active pack DECLARES (`LanguageSupport.provision`,
 *      the same command a work order is handed; the node pack's is the CI
 *      template's frozen install with its `a || b` fallback). One definition
 *      of "install this repo", so a lane cannot verify a Python or Ruby tree
 *      on an unprovisioned worktree while its order was told `bundle
 *      install`; a pack that declares none is a DISCLOSED skip. A failed
 *      install is ATTRIBUTED like a floor failure: the same install is probed
 *      at `baseHead`, and a failure that predates the change is PRE-EXISTING,
 *      disclosed, never blamed on the candidate;
 *   4. the correctness floor DIFF-SCOPED (the runner escalates to full on a
 *      manifest change and runs the lockfile-sync check there). NOT run when
 *      the install is pre-existing-broken: the worktree then has no
 *      dependency tree, so every floor command would exit "tsc: not found"
 *      and read as a NET-NEW failure of the change. Nothing about the change
 *      is observable there; the floor is skipped with the reason named
 *      (`floorSkipped`), never silently and never as a verdict;
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
import type { LanguageSupport } from '../languages/types';
import { guardrailVerdictFor, toFloorBaseChecks, type GuardrailGateResult } from './verify';

/** One pack's declared install, as it ran on the worktree. */
export interface InstallStep {
  readonly pack: string;
  readonly argv: readonly string[];
  /** Present when the primary failed and the fallback (the one CI mirrors)
   *  succeeded, with the reason the fallback exists. Disclosed. */
  readonly fallback?: { readonly argv: readonly string[]; readonly reason: string };
}

/** How the declared install of the candidate tree went. */
export type InstallOutcome =
  | {
      readonly status: 'installed';
      /** Every pack's install, in pack order; all succeeded. */
      readonly steps: readonly InstallStep[];
    }
  | {
      readonly status: 'failed';
      readonly pack: string;
      readonly argv: readonly string[];
      readonly output: string;
      /** True when the SAME install also fails at `baseHead`: the break
       *  predates the candidate. Disclosed, never blamed on the change;
       *  verification proceeds without the floor (the tree is unprovisioned,
       *  see `FloorSkip`). */
      readonly preExisting?: boolean;
    }
  /** No active pack declares an install for this tree (a pack without a
   *  `provision`, or a repo with nothing to provision from): nothing ran,
   *  nothing is claimed, and the floor runs on the tree as checked out. */
  | { readonly status: 'no-provision-declared'; readonly packs: readonly string[] };

/** Why the floor did not run on an otherwise verifiable tree. Disclosed on
 *  every surface that renders the floor; never a pass, never a block. */
export interface FloorSkip {
  readonly reason: 'unprovisioned';
  readonly detail: string;
}

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
  /** Present when the floor was deliberately not run (an unprovisioned
   *  worktree); `floor` and `floorAttribution` are then absent. */
  readonly floorSkipped?: FloorSkip;
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
    /** `null`: the diff was undeterminable (the runner treats it as unknown). */
    readonly changedFiles: readonly string[] | null;
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

/** The install each active pack declares for this tree, in pack order. */
function declaredInstalls(
  worktreePath: string,
  packs: readonly LanguageSupport[],
): { pack: string; argv: readonly string[]; fallback?: InstallStep['fallback'] }[] {
  const out: { pack: string; argv: readonly string[]; fallback?: InstallStep['fallback'] }[] = [];
  for (const pack of packs) {
    const cmd = pack.provision?.(worktreePath);
    if (!cmd) continue;
    out.push({
      pack: pack.id,
      argv: [cmd.bin, ...cmd.args],
      ...(cmd.fallback
        ? {
            fallback: {
              argv: [cmd.fallback.bin, ...cmd.fallback.args],
              reason: cmd.fallback.reason,
            },
          }
        : {}),
    });
  }
  return out;
}

/** Run one install argv; infrastructure (a manager not on PATH, a timeout, a
 *  capture overflow) THROWS with the argv named. */
function execInstall(
  exec: CommandExec,
  worktreePath: string,
  argv: readonly string[],
  what: string,
): { code: number; output: string } {
  const [bin, ...args] = argv;
  const r = exec({ bin, args }, worktreePath);
  if (!r.available) {
    throw new Error(
      `${bin} is not available in the verification environment` + (r.output ? `: ${r.output}` : ''),
    );
  }
  const infra = infraEnd(r.timedOut, r.overflowed);
  if (infra !== null) {
    throw new Error(
      `${what} (\`${argv.join(' ')}\`) ${infra}: infrastructure, not a verdict on the tree`,
    );
  }
  return { code: r.code, output: r.output };
}

/**
 * Run every active pack's DECLARED install in a worktree (`provision`, the
 * one definition a work order is handed too): the primary, then the pack's
 * fallback when the primary fails (the CI template's `a || b`). Packs run in
 * registry order; the first failure is the outcome. Infrastructure THROWS: a
 * package manager missing from PATH, a timeout, a capture overflow (on the
 * primary or the fallback alike) say nothing about the tree, so the caller's
 * catch turns them into a disclosed step failure, never an install verdict
 * (the bounded-exec fail-open doctrine). No declared install at all is its
 * own disclosed outcome, never a silent "installed".
 */
export function runDeclaredInstall(
  worktreePath: string,
  exec: CommandExec,
  packs: readonly LanguageSupport[] = detectActiveLanguages(worktreePath),
): InstallOutcome {
  const plans = declaredInstalls(worktreePath, packs);
  if (plans.length === 0) {
    return { status: 'no-provision-declared', packs: packs.map((p) => p.id) };
  }
  const steps: InstallStep[] = [];
  for (const plan of plans) {
    const primary = execInstall(exec, worktreePath, plan.argv, 'install');
    if (primary.code === 0) {
      steps.push({ pack: plan.pack, argv: plan.argv });
      continue;
    }
    if (!plan.fallback) {
      return { status: 'failed', pack: plan.pack, argv: plan.argv, output: tail(primary.output) };
    }
    const fallback = execInstall(exec, worktreePath, plan.fallback.argv, 'install fallback');
    if (fallback.code === 0) {
      steps.push({ pack: plan.pack, argv: plan.argv, fallback: plan.fallback });
      continue;
    }
    return {
      status: 'failed',
      pack: plan.pack,
      argv: plan.fallback.argv,
      output: tail(
        `${primary.output}\n--- fallback (${plan.fallback.argv.join(' ')}) ---\n${fallback.output}`,
      ),
    };
  }
  return { status: 'installed', steps };
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
  const install = seams.install ?? ((wt: string) => runDeclaredInstall(wt, exec));
  const changed = seams.changedFiles ?? computeChangedFiles;
  const runFloor =
    seams.runFloor ??
    ((args: { cwd: string; changedFiles: readonly string[] | null }) =>
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
      // Kept nullable for the floor: a null diff is UNKNOWN to the runner
      // (change-triggered checks still run), a known empty set is "nothing
      // changed". The result reports the empty projection either way.
      const changedDiff = changed(wt, opts.baseHead);
      const changedFiles = changedDiff ?? [];

      enter('install');
      let installed = install(wt);
      let floorSkipped: FloorSkip | undefined;
      if (installed.status === 'failed') {
        // Attribute before blaming (the floor's doctrine applied to the
        // install): probe the SAME declared install at baseHead. A lockfile
        // already drifted at the base fails there too: pre-existing debt,
        // disclosed, never pinned on the candidate; verification proceeds.
        enter('base-install');
        const baseOutcome = await worktree({ cwd: opts.cwd, ref: opts.baseHead }, async (bwt) =>
          install(bwt),
        );
        if (baseOutcome.status === 'failed') {
          installed = { ...installed, preExisting: true };
          // Neither tree can be provisioned, so neither side of the floor
          // can be observed: a run here would report the MISSING TOOLCHAIN
          // ("tsc: not found", exit 127) as failures the entry floor never
          // saw, and the comparator would attribute them net-new. The floor
          // is skipped with the reason named; the guardrail (which needs no
          // dependency tree for its own scanners) still runs.
          floorSkipped = {
            reason: 'unprovisioned',
            detail:
              `the install (\`${installed.argv.join(' ')}\`) fails on a clean checkout of the ` +
              'base as well, so the worktree has no dependency tree; a floor run there would ' +
              'report missing toolchains as failures that cannot be attributed to this change',
          };
        } else {
          return { verdict: 'install-failed', install: installed, changedFiles };
        }
      }

      let partial: Omit<VerifyTreeResult, 'verdict'>;
      if (floorSkipped) {
        partial = { install: installed, changedFiles, floorSkipped };
      } else {
        enter('floor');
        const floor = runFloor({ cwd: wt, changedFiles: changedDiff });
        enter('attribution');
        const floorAttribution = attributeFloorFailures(floor, baseChecks, {
          absentMeans: opts.absentMeans,
        });
        partial = { install: installed, changedFiles, floor, floorAttribution };
        if (floorAttribution.some((a) => a.attribution === 'net-new')) {
          return { verdict: 'floor-red', ...partial };
        }
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
    case 'no-provision-declared':
      return (
        'Install: no active pack declares an install for this tree ' +
        `(${install.packs.length > 0 ? install.packs.join(', ') : 'no pack detected'}); ` +
        'the floor ran on the tree as checked out, unprovisioned.'
      );
    case 'installed':
      return (
        'Install: ' +
        install.steps
          .map((s) =>
            s.fallback
              ? `\`${s.argv.join(' ')}\` failed, \`${s.fallback.argv.join(' ')}\` succeeded ` +
                `(${s.fallback.reason})`
              : `\`${s.argv.join(' ')}\` succeeded on a clean checkout`,
          )
          .join('; ') +
        '.'
      );
    case 'failed':
      return install.preExisting
        ? `Install: \`${install.argv.join(' ')}\` fails on a clean checkout of the BASE too: ` +
            'pre-existing (not caused by this change), disclosed. CI installs will keep failing ' +
            'until the lockfile is repaired on the default branch.'
        : `Install: \`${install.argv.join(' ')}\` FAILED on a clean checkout (CI cannot install this tree).`;
  }
}

/** One-line disclosure of a skipped floor for a ledger. */
export function describeFloorSkip(skip: FloorSkip | undefined): string | null {
  if (!skip) return null;
  return `Correctness floor: **not run** (${skip.reason}): ${skip.detail}.`;
}
