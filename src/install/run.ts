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
      /** The class of the PRIMARY's failure per the pack's classifiers. A
       *  class whose fallback was NOT authorized is still named, so the
       *  disclosure can say "a peer conflict the repo does not tolerate". */
      readonly classification: InstallFailureClass;
      /** The declared fallback that would have answered this failure but is
       *  not authorized for the repo, when that is the case. */
      readonly unauthorized?: InstallFallback;
      readonly attempts: readonly InstallAttempt[];
    }
  | {
      readonly status: 'infrastructure';
      readonly command: InstallCommand;
      readonly reason: 'unavailable' | 'timed-out' | 'overflowed';
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

/**
 * Run one plan at `cwd`. The primary first; on a real (ran-to-completion)
 * failure, the ONE declared fallback whose class the repo tolerates and
 * whose classifier recognizes the output; on a fallback failure, the
 * fallback's own output is the evidence (with the primary's kept in
 * `attempts`).
 */
export function runInstall(
  plan: InstallPlan,
  cwd: string,
  exec: CommandExec,
  tolerances: ResolvedTolerances,
): InstallRunResult {
  const attempts: InstallAttempt[] = [];
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
  return {
    status: 'failed',
    command: fallback.command,
    output: tail(
      `${primary.output}\n--- fallback (${installCommandText(fallback.command)}) ---\n${second.output}`,
    ),
    classification,
    attempts,
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
