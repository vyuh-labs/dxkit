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
 *   3. the FROZEN install every active pack DECLARES
 *      (`LanguageSupport.installStrategy`, the same declaration the CI
 *      templates render and a work order is handed), through the ONE
 *      install executor: the primary, then a declared fallback only when
 *      the repo tolerates its class and the failure has its shape. One
 *      definition of "install this repo", so a lane cannot verify a Python
 *      or Ruby tree on an unprovisioned worktree while its order was told
 *      `bundle install`; a pack that declares none is a DISCLOSED skip. A
 *      failed install is ATTRIBUTED like a floor failure: the same install
 *      is probed at `baseHead`; an IDENTICAL classification there is
 *      PRE-EXISTING, disclosed, never blamed on the candidate, and the
 *      probe's evidence travels with the verdict either way;
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
import { makeCommandExec, type CommandExec } from '../analyzers/tools/bounded-exec';
import {
  attributeFloorFailures,
  type AttributedFloorFailure,
  type FloorBaseCheck,
} from '../analyzers/correctness/attribution';
import { computeChangedFiles } from '../baseline/changed-files';
import { captureGateFailure, type GateFailure } from '../baseline/gate-failopen';
import { withRefWorktree, type RefWorktreeOptions } from '../baseline/ref-baseline';
import { activeInstallStrategies, detectActiveLanguages } from '../languages';
import type { LanguageSupport } from '../languages/types';
import type { ToleranceClass } from '../languages/capabilities/install-strategy';
import {
  describeInfrastructure,
  describeUnauthorizedFallback,
  runInstall,
  type InstallFailureClass,
} from '../install/run';
import {
  resolveTolerances,
  TOLERATE_POLICY_PATH,
  type ResolvedTolerances,
} from '../install/tolerances';
import { guardrailVerdictFor, toFloorBaseChecks, type GuardrailGateResult } from './verify';

/** One pack's declared install, as it ran on the worktree. */
export interface InstallStep {
  readonly pack: string;
  readonly argv: readonly string[];
  /** Present when the primary failed and a declared fallback (the one CI
   *  mirrors) succeeded, with the class it answered and the reason it
   *  exists. Disclosed. */
  readonly fallback?: {
    readonly argv: readonly string[];
    readonly when: ToleranceClass;
    readonly reason: string;
  };
}

/** The attribution probe's answer: the SAME declared install at `baseHead`. */
export type BaseInstallProbe =
  | { readonly status: 'installed'; readonly steps: readonly InstallStep[] }
  | {
      readonly status: 'failed';
      readonly argv: readonly string[];
      readonly classification: InstallFailureClass;
    }
  | { readonly status: 'no-provision-declared' };

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
      /** The last command that ran (the primary, or the fallback that also failed). */
      readonly argv: readonly string[];
      readonly output: string;
      /** The pack's classification of the FINAL failing output
       *  (`peer-conflict`, `lockfile-drift`, `unclassified`, ...). */
      readonly classification: InstallFailureClass;
      /** The PRIMARY's classification, when a fallback ran and failed with
       *  a different class (both disclosed). */
      readonly primaryClassification?: InstallFailureClass;
      /** Present when a declared fallback would have answered the failure
       *  but the repo does not authorize its class: the remedy, named. */
      readonly unauthorizedRemedy?: string;
      /** The base probe, once it ran, and the attribution it decided.
       *
       *  The equality rule, for NAMED classes: the classifiers are
       *  shape-specific (`peer-conflict` = the peer check rejected a
       *  recorded tree; `lockfile-drift` = the lockfile does not record the
       *  manifest), so the same named class on both sides is the same
       *  break: `pre-existing`, disclosed, never blamed, and verification
       *  proceeds without the floor (see `FloorSkip`). DIFFERENT named
       *  classes mean the change altered how the install fails — the base's
       *  break did not survive into the candidate, so the candidate's
       *  failure is `net-new` with both classes disclosed. `unclassified`
       *  names NO shape, so two unclassified failures cannot be verified
       *  identical: `undetermined` — treated like pre-existing operationally
       *  (a base that cannot install is not the change's fault either way;
       *  the guardrail still arbitrates) but never ASSERTED pre-existing. */
      readonly base?: BaseInstallProbe;
      readonly attribution?: 'net-new' | 'pre-existing' | 'undetermined';
    }
  /** No active pack declares an install for this tree (a pack without an
   *  install strategy, or a repo with nothing to provision from): nothing
   *  ran, nothing is claimed, and the floor runs on the tree as checked out. */
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
  /** The repo's install tolerances, resolved ONCE (at the lane's checkout
   *  root) and applied to BOTH the candidate and the base install, so the
   *  two sides of the attribution probe can never run under different
   *  authorizations. Default: `resolveTolerances(opts.cwd)`. */
  readonly tolerances?: ResolvedTolerances;
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

/**
 * Run every active pack's DECLARED frozen install in a worktree (the
 * install strategy, the one definition a work order is handed too) through
 * the ONE install executor: the primary, then a declared fallback when the
 * repo tolerates its class AND the primary's failure has that class's shape
 * (the same ladder the CI template renders). Packs run in registry order;
 * the first failure is the outcome. Infrastructure THROWS: a package manager
 * missing from PATH, a timeout, a capture overflow (on the primary or the
 * fallback alike) say nothing about the tree, so the caller's catch turns
 * them into a disclosed step failure, never an install verdict (the
 * bounded-exec fail-open doctrine). No declared install at all is its own
 * disclosed outcome, never a silent "installed".
 */
export function runDeclaredInstall(
  worktreePath: string,
  exec: CommandExec,
  packs: readonly LanguageSupport[] = detectActiveLanguages(worktreePath),
  tolerances: ResolvedTolerances = resolveTolerances(worktreePath),
): InstallOutcome {
  const strategies = activeInstallStrategies(packs, worktreePath);
  if (strategies.length === 0) {
    return { status: 'no-provision-declared', packs: packs.map((p) => p.id) };
  }
  const steps: InstallStep[] = [];
  for (const { id, strategy } of strategies) {
    const plan = strategy.modes.frozen;
    // The strategy's Rule 20 requirement gates the spawn: an environment
    // that cannot run this install is infrastructure (a disclosed error
    // step), never an install verdict.
    const r = runInstall(plan, worktreePath, exec, tolerances, {
      execution: strategy.execution,
    });
    const argvOf = (c: { bin: string; args: readonly string[] }) => [c.bin, ...c.args];
    switch (r.status) {
      case 'infrastructure':
        throw new Error(describeInfrastructure(r));
      case 'ok':
        steps.push({
          pack: id,
          argv: argvOf(plan.primary),
          ...(r.fallback
            ? {
                fallback: {
                  argv: argvOf(r.fallback.command),
                  when: r.fallback.when,
                  reason: r.fallback.disclosure,
                },
              }
            : {}),
        });
        continue;
      case 'failed': {
        const remedy = describeUnauthorizedFallback(r, TOLERATE_POLICY_PATH);
        return {
          status: 'failed',
          pack: id,
          argv: argvOf(r.command),
          output: r.output,
          classification: r.classification,
          ...(r.primaryClassification !== undefined
            ? { primaryClassification: r.primaryClassification }
            : {}),
          ...(remedy !== null ? { unauthorizedRemedy: remedy } : {}),
        };
      }
    }
  }
  return { status: 'installed', steps };
}

/** Project a base-side install outcome onto the probe record. */
function probeOf(outcome: InstallOutcome): BaseInstallProbe {
  switch (outcome.status) {
    case 'installed':
      return { status: 'installed', steps: outcome.steps };
    case 'failed':
      return { status: 'failed', argv: outcome.argv, classification: outcome.classification };
    case 'no-provision-declared':
      return { status: 'no-provision-declared' };
  }
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
  // Resolved ONCE, at the lane's checkout root (where the committed policy
  // and .npmrc live), for both sides of the attribution probe.
  const tolerances = opts.tolerances ?? resolveTolerances(opts.cwd);
  const worktree = seams.worktree ?? withRefWorktree;
  const install =
    seams.install ??
    ((wt: string) => runDeclaredInstall(wt, exec, detectActiveLanguages(wt), tolerances));
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
        // install): probe the SAME declared install at baseHead. A failure
        // with the IDENTICAL classification at the base (a lockfile already
        // drifted there, a peer conflict the repo does not tolerate) is
        // pre-existing debt: disclosed, never pinned on the candidate, and
        // verification proceeds. A base that installs (through a fallback or
        // not) or fails DIFFERENTLY makes the candidate's failure net-new.
        // The probe's answer is recorded either way, so the ledger shows the
        // evidence behind the attribution rather than asserting it.
        enter('base-install');
        const baseOutcome = await worktree({ cwd: opts.cwd, ref: opts.baseHead }, async (bwt) =>
          install(bwt),
        );
        const base = probeOf(baseOutcome);
        // See `InstallOutcome.attribution` for the equality rule: identical
        // NAMED classes = pre-existing; both unclassified = undetermined
        // (never verified identical, never blamed); anything else = net-new.
        const sameClass =
          base.status === 'failed' && base.classification === installed.classification;
        const attribution =
          sameClass && installed.classification === 'unclassified'
            ? 'undetermined'
            : sameClass
              ? 'pre-existing'
              : 'net-new';
        installed = { ...installed, base, attribution };
        if (attribution !== 'net-new') {
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

export { describeInstall, describeFloorSkip } from './verify-tree-render';
