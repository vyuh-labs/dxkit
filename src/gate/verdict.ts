/**
 * The `verdict.v1` emitter (4.4.0 WP3 / P0-2) — projects a gate outcome
 * onto the SDK's frozen wire schema. ONE projection: `gate --json`
 * emits exactly this document, and the fleet verification-receipt
 * (4.6, signed) wraps this same core. Everything here is derivation
 * from already-computed values — no verdict logic lives in this file
 * (the ONE derivation stays `verdictCounts` + the gate's floor fold).
 *
 * Honesty invariants carried onto the wire:
 *   - a skipped check ALWAYS carries its cause (never bare `skipped`);
 *   - `cannot_gate` carries the refusals that forced it;
 *   - the policy is named by hash always, id@version when declared (WP4);
 *   - the prior mode rides along — attribution semantics differ by
 *     prior, and a receipt that hides that is not reproducible.
 */

import type {
  WireVerdictCheck,
  WireVerdictDoc,
  WireVerdictFinding,
  WireVerdictStatus,
} from '@vyuhlabs/dxkit-sdk';
import { VERSION } from '../constants';
import { policyContentHash } from '../baseline/policy';
import { describeAttributionGap, attributionGapRemedy } from '../baseline/attribution-gap';
import { pairBlocks } from './context';
import type { GateCommandOutcome } from '../gate-cli';

/** Map a floor/check runner status onto the wire's three-way status. */
function wireStatus(status: string): WireVerdictCheck['status'] {
  if (status === 'pass') return 'passed';
  if (status === 'fail') return 'failed';
  return 'skipped';
}

/** Build the `verdict.v1` document for a gate outcome. Pure. */
export function buildWireVerdict(outcome: GateCommandOutcome, receipt: string): WireVerdictDoc {
  const { result, counts } = outcome;

  const status: WireVerdictStatus =
    outcome.verdict === 'BLOCKED'
      ? 'blocked'
      : outcome.verdict === 'CANNOT GATE'
        ? 'cannot_gate'
        : 'passed';

  // Findings: every pair that counts toward the verdict (blocking or
  // warning), each flagged. Suppressed pairs stay out — they do not
  // count, and the allowlist delta is the surface that audits them.
  const findings: WireVerdictFinding[] = result.pairs
    .filter(
      (p) =>
        p.suppressedByAllowlist === undefined &&
        (p.classification.blocks || p.classification.warns),
    )
    .map((p) => ({
      kind: p.kind as string,
      ...(p.severity !== undefined ? { severity: p.severity } : {}),
      ...(p.file !== undefined ? { file: p.file } : {}),
      ...(p.line !== undefined ? { line: p.line } : {}),
      ...(p.locator ? { message: p.locator } : {}),
      fingerprint: (p.pair.currentId ?? p.pair.priorId ?? '') as string,
      blocking: pairBlocks(p),
    }));

  // Checks: the named non-finding outcomes a consumer must see to trust
  // the verdict — scanner availability, unobserved custom checks, the
  // additive gates. Every skip carries its cause.
  const checks: WireVerdictCheck[] = [];
  if (result.depVulnsUnmeasured) {
    checks.push({
      id: 'deps.vulnerabilities',
      status: 'skipped',
      cause: result.depVulnsUnmeasured.reason,
    });
  } else {
    checks.push({
      id: 'deps.vulnerabilities',
      status: result.current.aggregate.provenance.depVulns.available ? 'passed' : 'skipped',
      ...(result.current.aggregate.provenance.depVulns.available
        ? {}
        : { cause: 'dependency audit not requested this run' }),
    });
  }
  const cc = result.current.customChecksUnobserved;
  if (cc.gathered) {
    for (const check of cc.checks) {
      checks.push({
        id: `custom:${check.name}`,
        status: 'skipped',
        cause: check.reason ?? check.status,
      });
    }
  } else {
    checks.push({ id: 'custom-checks', status: 'skipped', cause: cc.reason });
  }
  const gateChecks: Array<
    [string, { ran: boolean; skipped?: string; blocks: boolean; warns: boolean } | undefined]
  > = [
    ['gate.flow', result.flowGate],
    ['gate.schema-drift', result.schemaDriftGate],
    ['gate.duplication', result.dupGate],
    ['gate.paired-change', result.pairedGate],
  ];
  for (const [id, g] of gateChecks) {
    if (!g) continue;
    checks.push(
      g.ran
        ? { id, status: g.blocks ? 'failed' : 'passed' }
        : { id, status: 'skipped', cause: g.skipped ?? 'did not run' },
    );
  }

  // The floor slice: per-command outcomes when it ran, the declared
  // cause when it did not.
  const floor = outcome.floor
    ? {
        ran: true,
        checks: outcome.floor.checks.map((c) => ({
          id: `floor.${c.pack}:${c.label}`,
          status: wireStatus(c.status),
          ...(c.status.startsWith('skipped') ? { cause: c.output ?? c.status } : {}),
        })),
      }
    : {
        ran: false,
        skippedWithCause: outcome.floorSkipped?.detail ?? 'floor did not run',
      };

  // Every refusal source feeds the ONE wire array: attribution gaps (Rule
  // 19), required custom checks not observed, and the required floor's own
  // gap (WP1, §7.1) — a cannot_gate verdict always names its evidence.
  const refusalRows = [
    ...result.attributionGaps.map((gap) => ({
      reason: describeAttributionGap(gap),
      remedy: attributionGapRemedy(result.envelopeDrift.refreshLaneInstalled),
    })),
    ...result.requiredNotObserved.map((gap) => ({
      reason: gap.reason,
      remedy: gap.remedy,
    })),
    ...(outcome.floorRequiredGap !== undefined
      ? [{ reason: outcome.floorRequiredGap.reason, remedy: outcome.floorRequiredGap.remedy }]
      : []),
  ];
  const refusals = refusalRows.length > 0 ? refusalRows : undefined;

  return {
    schema: 'verdict.v1',
    engine: { name: 'dxkit', version: VERSION },
    policy: {
      // The naming hash of the RESOLVED policy the engine actually used
      // (--policy override included) — NOT the envelope's drift-detection
      // policyHash, which hashes a different concept. id@version when the
      // document declares them (P0-3).
      hash: policyContentHash(result.policy),
      ...(result.policy.id !== undefined ? { id: result.policy.id } : {}),
      ...(result.policy.version !== undefined ? { version: result.policy.version } : {}),
    },
    status,
    exitCode: outcome.exitCode,
    mode: result.mode.mode,
    findings,
    checks,
    floor,
    ...(refusals !== undefined ? { refusals } : {}),
    receipt,
    meta: {
      warningCount: counts.warning,
      blockingCount: counts.blocking,
      floorNetNew: outcome.floorNetNew.length,
      // Scanner provenance (P2-7): every tool that observed this tree,
      // name → version — the "scanner@version named in the verdict" ask,
      // extension engines included (the recall seam collected them).
      tools: result.current.tools,
      // Snapshot mode (P1-4): the feed state that observed the tree —
      // "snapshot version named in the verdict" is this field plus the
      // recall input it mirrors.
      ...(result.current.aggregate.provenance.depVulns.advisoryDbVersion !== undefined
        ? { advisoryDb: result.current.aggregate.provenance.depVulns.advisoryDbVersion }
        : {}),
    },
  };
}
