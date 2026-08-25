/**
 * The remediate lane's call into the ONE tree verification
 * (`lanes/verify-tree.ts`), split from the runner for module size. It maps
 * the verification's steps onto the lane's phases and folds a verification
 * that could not run into the fail-closed guardrail shape the runner already
 * handles: an unrunnable verification IS an unrunnable guardrail, with the
 * failing step named in the verdict.
 */
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import type { GuardrailGateResult } from '../lanes/verify';
import { verifyTree, type VerifyTreeResult, type VerifyTreeStep } from '../lanes/verify-tree';
import type { RemediatePhase, RemediateRunOptions } from './outcome';

const PHASE_OF: Partial<Record<VerifyTreeStep, RemediatePhase>> = {
  install: 'verify-install',
  floor: 'verify-floor',
  guardrail: 'guardrail',
};

export async function verifyCommittedHead(
  opts: RemediateRunOptions,
  args: {
    readonly head: string;
    readonly baseHead: string;
    readonly entryFloor: CorrectnessFloorResult;
    readonly runFloor: () => CorrectnessFloorResult;
  },
): Promise<{ verified: VerifyTreeResult; guardrail: GuardrailGateResult }> {
  const verified = await verifyTree({
    cwd: opts.cwd,
    head: args.head,
    baseHead: args.baseHead,
    trust: opts.trust,
    entryFloor: args.entryFloor,
    // The entry floor always ran: an absent base check is a check the
    // agent's change introduced, net-new (conservative).
    absentMeans: 'net-new',
    onStep: (step) => {
      const phase = PHASE_OF[step];
      if (phase) opts.onPhase?.(phase);
    },
    seams: {
      ...opts.verifySeams,
      ...(opts.runFloor ? { runFloor: () => args.runFloor() } : {}),
      ...(opts.runGuardrail ? { runGuardrail: () => opts.runGuardrail!() } : {}),
    },
  });
  const guardrail: GuardrailGateResult = verified.guardrail ?? {
    verdict:
      `unavailable (verification failed at step '${verified.failure?.step ?? 'unknown'}': ` +
      `${verified.failure?.message ?? 'unknown'})`,
    ran: false,
    passesGate: false,
  };
  return { verified, guardrail };
}

/** The install-failed outcome's note: what failed, why it matters, the
 *  usual cause, and the install output as evidence. */
export function installFailedNote(verified: VerifyTreeResult): string {
  const failed = verified.install?.status === 'failed' ? verified.install : undefined;
  return (
    "a clean checkout of the agent's commits cannot be installed the way CI installs it " +
    `(\`${failed ? failed.argv.join(' ') : 'frozen install'}\` failed) — nothing lands. CI would ` +
    'have died before any gate ran, so the draft would read "NOT gated"; the usual cause is a ' +
    'manifest edited without re-running the install so the lockfile records it.' +
    (failed ? `\n\nInstall output:\n\`\`\`\n${failed.output}\n\`\`\`` : '')
  );
}
