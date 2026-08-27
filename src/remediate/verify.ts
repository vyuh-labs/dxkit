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
import {
  describeInstall,
  verifyTree,
  type VerifyTreeResult,
  type VerifyTreeStep,
} from '../lanes/verify-tree';
import { resolveTolerances, toleranceWarnings } from '../install/tolerances';
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
    /** Per-order verification (4.4.6): install + floor for THIS order's
     *  commits, the guardrail deferred to the one final pass. */
    readonly deferGuardrail?: string;
  },
): Promise<{ verified: VerifyTreeResult; guardrail: GuardrailGateResult }> {
  const verified = await verifyTree({
    cwd: opts.cwd,
    head: args.head,
    baseHead: args.baseHead,
    trust: opts.trust,
    // Resolved ONCE at the lane's checkout root; the same set reaches the
    // ledger's warnings below, so what gated and what is disclosed cannot
    // diverge.
    tolerances: resolveTolerances(opts.cwd),
    entryFloor: args.entryFloor,
    // The entry floor always ran: an absent base check is a check the
    // agent's change introduced, net-new (conservative).
    absentMeans: 'net-new',
    ...(args.deferGuardrail !== undefined ? { deferGuardrail: args.deferGuardrail } : {}),
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
  if (verified.verdict === 'floor-verified') {
    return {
      verdict: `deferred (${verified.guardrailDeferred ?? 'to the final pass over the landed head'})`,
      ran: false,
      passesGate: false,
    };
  }
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
  cwd?: string,
): {
  floor?: VerifyTreeResult['floor'];
  floorAttribution?: VerifyTreeResult['floorAttribution'];
  floorSkipped?: VerifyTreeResult['floorSkipped'];
  install?: VerifyTreeResult['install'];
  installToleranceWarnings?: readonly string[];
  changedFiles?: VerifyTreeResult['changedFiles'];
  guardrailVerdict: string;
  guardrailRan: boolean;
} {
  // The tolerance-resolution warnings (unknown policy entries, a policy
  // opt-out conflicting with observed repo config): the disclosure home the
  // resolver promises. Same resolution the verification ran under.
  const warnings = cwd !== undefined ? toleranceWarnings(resolveTolerances(cwd)) : [];
  return {
    ...(verified.floor ? { floor: verified.floor } : {}),
    ...(verified.floorAttribution ? { floorAttribution: verified.floorAttribution } : {}),
    ...(verified.floorSkipped ? { floorSkipped: verified.floorSkipped } : {}),
    ...(verified.install ? { install: verified.install } : {}),
    ...(warnings.length > 0 ? { installToleranceWarnings: warnings } : {}),
    ...(verified.changedFiles ? { changedFiles: verified.changedFiles } : {}),
    guardrailVerdict: guardrail.verdict,
    guardrailRan: guardrail.ran,
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
  const cause =
    failed?.classification === 'lockfile-drift'
      ? 'the lockfile does not record the manifest (a manifest or lockfile edited without ' +
        're-running the install)'
      : failed?.unauthorizedRemedy
        ? failed.unauthorizedRemedy
        : 'the usual cause is a manifest edited without re-running the install so the lockfile ' +
          'records it';
  return (
    "a clean checkout of the agent's commits cannot be installed the way CI installs it " +
    `(\`${failed ? failed.argv.join(' ') : 'frozen install'}\` failed` +
    `${failed ? `, ${failed.classification}` : ''}) — nothing lands. CI would ` +
    `have died before any gate ran, so the draft would read "NOT gated"; ${cause}.` +
    (failed ? `\n\n${describeInstall(failed)}` : '') +
    (failed ? `\n\nInstall output:\n\`\`\`\n${failed.output}\n\`\`\`` : '')
  );
}

/** The guardrail-deferral reason every per-order verification carries. */
export const PER_ORDER_GUARDRAIL_DEFERRED =
  'per-order verification runs the install and the floor; the guardrail arbitrates once over ' +
  'the landed head';

/** How one order's verification came out: KEPT (verified, lands), DROPPED
 *  (a real verdict against the tree: the commits are reverted, the order
 *  stays open), or UNVERIFIABLE (verification INFRASTRUCTURE failed: the
 *  commits STAY on the branch, nothing lands, the run completes
 *  `verification-unavailable`). Infrastructure is never a verdict on the
 *  work, so it must never destroy it. */
export type OrderHeadVerdict =
  | { readonly kind: 'kept'; readonly verified: VerifyTreeResult }
  | {
      readonly kind: 'dropped';
      readonly step: 'install' | 'floor';
      readonly reason: string;
      readonly verified: VerifyTreeResult;
    }
  | { readonly kind: 'unverifiable'; readonly reason: string; readonly verified: VerifyTreeResult };

/**
 * The ONE per-order verdict projection (4.4.6): verify ONE order's commits
 * (install + floor, guardrail deferred) and place them. Both consumers
 * (the recipe group before the agent tier, each agent order) read it.
 */
export async function verifyOrderHead(
  opts: RemediateRunOptions,
  args: {
    readonly head: string;
    readonly baseHead: string;
    readonly entryFloor: CorrectnessFloorResult;
    readonly runFloor: () => CorrectnessFloorResult;
  },
): Promise<OrderHeadVerdict> {
  const { verified } = await verifyCommittedHead(opts, {
    ...args,
    deferGuardrail: PER_ORDER_GUARDRAIL_DEFERRED,
  });
  switch (verified.verdict) {
    case 'floor-verified':
      return { kind: 'kept', verified };
    case 'install-failed':
      return { kind: 'dropped', step: 'install', reason: installFailedNote(verified), verified };
    case 'floor-red': {
      const failing = (verified.floorAttribution ?? [])
        .filter((a) => a.attribution === 'net-new')
        .map((a) => `${a.check.pack} ${a.check.label}`);
      return {
        kind: 'dropped',
        step: 'floor',
        reason:
          'the correctness floor has NET-NEW failures after this order' +
          (failing.length > 0 ? ` (${failing.join(', ')})` : ''),
        verified,
      };
    }
    default:
      // 'error' and 'skipped-untrusted': verification itself could not run.
      // A transient worktree or disk failure says NOTHING about the work,
      // so the commits are preserved, never reset (fix 1 of the review).
      return {
        kind: 'unverifiable',
        reason: verified.failure
          ? `verification infrastructure failed at step '${verified.failure.step}': ${verified.failure.message}`
          : `verification ended '${verified.verdict}' without reaching a verdict on the tree`,
        verified,
      };
  }
}
