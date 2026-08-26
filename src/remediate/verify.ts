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
  return { verified, guardrail: guardrailShapeFor(verified) };
}

/**
 * The guardrail shape for a verification that carries no guardrail result.
 * Two honest cases, never conflated (and never a fabricated failure): the
 * verification BROKE (a `failure` names the step), or it STOPPED on its own
 * verdict before the guardrail was due (install-failed / floor-red) — the
 * gate was deliberately not consulted, and the ledger says so.
 */
function guardrailShapeFor(verified: VerifyTreeResult): GuardrailGateResult {
  if (verified.guardrail) return verified.guardrail;
  if (verified.failure) {
    return {
      verdict:
        `unavailable (verification failed at step '${verified.failure.step}': ` +
        `${verified.failure.message})`,
      ran: false,
      passesGate: false,
    };
  }
  const stoppedAt =
    verified.verdict === 'install-failed'
      ? 'install'
      : verified.verdict === 'floor-red'
        ? 'floor'
        : 'an earlier step';
  return {
    verdict: `not consulted (verification stopped at ${stoppedAt})`,
    ran: false,
    passesGate: false,
  };
}

/** The verification-fact fields every post-verify outcome carries — ONE
 *  projection (run.ts's agent tail, the recipe-only completion, and the
 *  orders phase all spread it, so the three ledgers cannot drift). */
export function verificationDisclosures(
  verified: VerifyTreeResult,
  guardrail: GuardrailGateResult,
): {
  floor?: VerifyTreeResult['floor'];
  floorAttribution?: VerifyTreeResult['floorAttribution'];
  install?: VerifyTreeResult['install'];
  changedFiles?: VerifyTreeResult['changedFiles'];
  guardrailVerdict: string;
} {
  return {
    ...(verified.floor ? { floor: verified.floor } : {}),
    ...(verified.floorAttribution ? { floorAttribution: verified.floorAttribution } : {}),
    ...(verified.install ? { install: verified.install } : {}),
    ...(verified.changedFiles ? { changedFiles: verified.changedFiles } : {}),
    guardrailVerdict: guardrail.verdict,
  };
}

/**
 * The guardrail-red note, phrased once for the agent-diff surfaces (the
 * legacy task path and the orders phase): the verdict, the blocking
 * findings as evidence (an ephemeral runner's diff evaporates with the
 * job), and the salvage disposition for a RAN-and-BLOCKED verdict.
 */
export function guardrailRedNote(
  guardrail: GuardrailGateResult,
  effectiveSalvage: 'discard' | 'draft-pr',
): string {
  const evidence =
    guardrail.blocking && guardrail.blocking.length > 0
      ? `\n\nBlocking findings:\n${guardrail.blocking.map((b) => `- ${b}`).join('\n')}`
      : '';
  const salvageNote =
    guardrail.ran && effectiveSalvage === 'draft-pr'
      ? ' Salvage policy: draft-pr — the BLOCKED attempt may be pushed as a red DRAFT ' +
        '(unmergeable while the guardrail check is red) so the work and the exact blocking ' +
        'findings survive the ephemeral runner. A blocked draft is not a resume anchor: the ' +
        'next run starts fresh, with these findings as a negative constraint.'
      : '';
  return (
    (guardrail.ran
      ? `the guardrail did not pass (${guardrail.verdict}) — nothing merges. The attempt ` +
        'diff is uploaded as a run artifact when this ran under Actions; locally the ' +
        'branch stays for inspection.'
      : `the guardrail could not run (${guardrail.verdict}) — nothing lands. An ` +
        'agent-authored diff is never pushed unverified.') +
    salvageNote +
    evidence
  );
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
