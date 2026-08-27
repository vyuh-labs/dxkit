/**
 * The ONE install executor: walks a plan's fallback ladder, classifies a
 * failure against the pack's declared classifiers, and discloses which
 * fallback fired and why. Every in-process install dxkit runs (the lane's
 * tree verification at the candidate AND the base, the recipe tier's
 * lock-writing resync, the floor's lockfile-sync check) goes through here,
 * so "retry under X on Y" is decided in one place with one vocabulary.
 *
 * Policy, owned here and nowhere else:
 *   - a fallback runs ONLY when its class is authorized for this repo AND
 *     the primary's output has the shape the pack's classifier recognizes;
 *     never a blanket retry (the shipped shape: a blanket `a || b` ran the
 *     fallback into the same lockfile-drift failure and the ledger named
 *     the fallback as the failing command);
 *   - a failure is reported against the LAST command that ran with the
 *     classification the pack gave it (`peer-conflict`, `lockfile-drift`,
 *     `unclassified`), and every attempt is kept for the evidence;
 *   - infrastructure (a manager missing from PATH, a timeout, a capture
 *     overflow) is its own outcome, never a verdict on the tree: the caller
 *     decides how to disclose it (the bounded-exec fail-open doctrine).
 */
import { tail, type CommandExec, type CommandOutcome } from '../analyzers/tools/bounded-exec';
// exec-requirement-ok: the executor is a declared Rule 20 consumer — it gates
// every install spawn on the strategy's execution requirement.
import {
  currentEnvironment,
  describeUnmetRequirement,
  unmetRequirement,
  type ExecutionEnvironment,
  type ExecutionRequirement,
} from '../execution';
import {
  installCommandText,
  type InstallCommand,
  type InstallFallback,
  type InstallPlan,
  type ToleranceClass,
} from '../languages/capabilities/install-strategy';
import type { ResolvedTolerances } from './tolerances';

/** One command the executor ran, with how it ended. */
export interface InstallAttempt {
  readonly command: InstallCommand;
  readonly code: number;
  readonly output: string;
}

/** A fallback that fired, as disclosed. */
export interface FallbackTaken {
  readonly command: InstallCommand;
  readonly when: ToleranceClass;
  readonly disclosure: string;
}

/** `unclassified` when no declared classifier recognized the output. */
export type InstallFailureClass = ToleranceClass | 'unclassified' | (string & {});

export type InstallRunResult =
  | {
      readonly status: 'ok';
      readonly command: InstallCommand;
      /** Present when the primary failed and this fallback succeeded. */
      readonly fallback?: FallbackTaken;
      readonly attempts: readonly InstallAttempt[];
    }
  | {
      readonly status: 'failed';
      /** The last command that ran (the primary, or the fallback that also failed). */
      readonly command: InstallCommand;
      readonly output: string;
      /** The class of the FINAL failing output per the pack's classifiers
       *  (when a fallback ran and also failed, the fallback's own failure is
       *  re-classified — the two runs can fail differently, and attribution
       *  compares what actually stopped the install). A class whose fallback
       *  was NOT authorized is still named, so the disclosure can say "a
       *  peer conflict the repo does not tolerate". */
      readonly classification: InstallFailureClass;
      /** The PRIMARY's classification, kept as history when a fallback ran
       *  and failed with a different class (both disclosed). */
      readonly primaryClassification?: InstallFailureClass;
      /** The declared fallback that would have answered this failure but is
       *  not authorized for the repo, when that is the case. */
      readonly unauthorized?: InstallFallback;
      readonly attempts: readonly InstallAttempt[];
    }
  | {
      readonly status: 'infrastructure';
      readonly command: InstallCommand;
      /** `environment`: the strategy's declared execution requirement is
       *  unmet here (Rule 20) — decided BEFORE any spawn. */
      readonly reason: 'unavailable' | 'timed-out' | 'overflowed' | 'environment';
      readonly output: string;
      readonly attempts: readonly InstallAttempt[];
    };

function infrastructureOf(
  command: InstallCommand,
  r: CommandOutcome,
  attempts: readonly InstallAttempt[],
): Extract<InstallRunResult, { status: 'infrastructure' }> | null {
  if (!r.available)
    return { status: 'infrastructure', command, reason: 'unavailable', output: r.output, attempts };
  if (r.timedOut)
    return { status: 'infrastructure', command, reason: 'timed-out', output: r.output, attempts };
  if (r.overflowed)
    return { status: 'infrastructure', command, reason: 'overflowed', output: r.output, attempts };
  return null;
}

/** Classify a failed primary's output: the first declared fallback whose
 *  classifier matches names the class, else the plan's own extra
 *  classifier, else `unclassified`. */
export function classifyInstallFailure(
  plan: InstallPlan,
  output: string,
): { readonly classification: InstallFailureClass; readonly fallback: InstallFallback | null } {
  for (const fb of plan.fallbacks) {
    if (fb.matches(output)) return { classification: fb.when, fallback: fb };
  }
  return { classification: plan.classifyFailure?.(output) ?? 'unclassified', fallback: null };
}

/** Optional executor gates: the strategy's Rule 20 execution requirement
 *  (checked against `env` — the real host by default — BEFORE any spawn),
 *  injected for tests. */
export interface RunInstallOptions {
  readonly execution?: ExecutionRequirement;
  readonly env?: ExecutionEnvironment;
}

/**
 * Run one plan at `cwd`. The declared execution requirement first (an unmet
 * environment is infrastructure, decided before any spawn); then the
 * primary; on a real (ran-to-completion) failure, the ONE declared fallback
 * whose class the repo tolerates and whose classifier recognizes the
 * output; on a fallback failure, the fallback's own output is re-classified
 * and is the evidence (with the primary's attempt and classification kept).
 */
export function runInstall(
  plan: InstallPlan,
  cwd: string,
  exec: CommandExec,
  tolerances: ResolvedTolerances,
  opts?: RunInstallOptions,
): InstallRunResult {
  const attempts: InstallAttempt[] = [];
  if (opts?.execution) {
    const unmet = unmetRequirement(opts.execution, opts.env ?? currentEnvironment());
    if (unmet) {
      return {
        status: 'infrastructure',
        command: plan.primary,
        reason: 'environment',
        output: describeUnmetRequirement(unmet),
        attempts,
      };
    }
  }
  const run = (command: InstallCommand): CommandOutcome => {
    const r = exec({ bin: command.bin, args: command.args }, cwd);
    attempts.push({ command, code: r.code, output: r.output });
    return r;
  };

  const primary = run(plan.primary);
  const infra = infrastructureOf(plan.primary, primary, attempts);
  if (infra) return infra;
  if (primary.code === 0) return { status: 'ok', command: plan.primary, attempts };

  const { classification, fallback } = classifyInstallFailure(plan, primary.output);
  if (fallback === null) {
    return {
      status: 'failed',
      command: plan.primary,
      output: tail(primary.output),
      classification,
      attempts,
    };
  }
  if (!tolerances.tolerated.has(fallback.when)) {
    return {
      status: 'failed',
      command: plan.primary,
      output: tail(primary.output),
      classification,
      unauthorized: fallback,
      attempts,
    };
  }
  const second = run(fallback.command);
  const infra2 = infrastructureOf(fallback.command, second, attempts);
  if (infra2) return infra2;
  if (second.code === 0) {
    return {
      status: 'ok',
      command: plan.primary,
      fallback: { command: fallback.command, when: fallback.when, disclosure: fallback.disclosure },
      attempts,
    };
  }
  // The fallback ran and ALSO failed: classify what actually stopped the
  // install (the two runs can fail differently — e.g. the peer conflict the
  // fallback answered gives way to a registry error), keep the primary's
  // class as history, and disclose both when they differ.
  const final = classifyInstallFailure(plan, second.output).classification;
  return {
    status: 'failed',
    command: fallback.command,
    output: tail(
      `${primary.output}\n--- fallback (${installCommandText(fallback.command)}) ---\n${second.output}`,
    ),
    classification: final,
    ...(final !== classification ? { primaryClassification: classification } : {}),
    attempts,
  };
}

/**
 * Re-base a plan's COMPOSABLE fallbacks (those declaring `viaFlags`) onto a
 * caller-built primary — the one helper for a consumer that composes its own
 * lock-writing argv (the dep-bump lane's `<pm> add pkg@ver`) yet must apply
 * the SAME declared fallback doctrine, classifiers and disclosures, never a
 * re-implemented ladder.
 */
export function composePlan(base: InstallPlan, primary: InstallCommand): InstallPlan {
  return {
    primary,
    fallbacks: base.fallbacks
      .filter((f) => f.viaFlags !== undefined)
      .map((f) => ({
        ...f,
        command: { bin: primary.bin, args: [...primary.args, ...(f.viaFlags ?? [])] },
      })),
    ...(base.classifyFailure ? { classifyFailure: base.classifyFailure } : {}),
  };
}

/** Phrase an infrastructure end for a disclosure. */
export function describeInfrastructure(
  r: Extract<InstallRunResult, { status: 'infrastructure' }>,
): string {
  const what = installCommandText(r.command);
  switch (r.reason) {
    case 'unavailable':
      return (
        `${r.command.bin} is not available in this environment` + (r.output ? `: ${r.output}` : '')
      );
    case 'timed-out':
      return `\`${what}\` timed out: infrastructure, not a verdict on the tree`;
    case 'overflowed':
      return `\`${what}\` overflowed the capture buffer: infrastructure, not a verdict on the tree`;
    case 'environment':
      return `\`${what}\` cannot run in this environment: ${r.output}`;
  }
}

/** Phrase an unauthorized-fallback failure's remedy, when one applies. */
export function describeUnauthorizedFallback(
  r: Extract<InstallRunResult, { status: 'failed' }>,
  policyPath: string,
): string | null {
  if (!r.unauthorized) return null;
  return (
    `the failure is a ${r.classification} that \`${installCommandText(r.unauthorized.command)}\` ` +
    `would answer, but this repo does not tolerate it; declare it in ${policyPath} ` +
    'if the repo installs that way'
  );
}
