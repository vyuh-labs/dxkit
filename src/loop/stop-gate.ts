/**
 * `vyuh-dxkit hook stop-gate` — the Claude Code **Stop hook** body.
 *
 * Purpose: stop an autonomous loop from declaring "done" while the
 * deterministic guardrail still reports net-new findings. When the gate
 * blocks, it feeds the exact net-new findings back to the model so the
 * loop can repair them and try to stop again.
 *
 * Claude Code Stop-hook contract used here:
 *   - The hook receives a JSON payload on stdin (session_id, cwd,
 *     stop_hook_active, optional agent fields).
 *   - To BLOCK the stop AND have the model read an actionable message,
 *     the hook prints `{"decision":"block","reason":"..."}` on stdout and
 *     exits 0. (Exit code 2 also blocks, but its stderr reaches only the
 *     operator, not the model — wrong for a repair loop, so it's reserved
 *     here for operator-facing config failures.)
 *   - `stop_hook_active` is true when the model is already continuing
 *     because a prior Stop-gate blocked this turn. Claude Code caps
 *     consecutive blocks, so an un-fixable failure can't loop forever;
 *     we still keep blocking on net-new findings (the safety guarantee)
 *     and rely on that cap as the backstop.
 *
 * Posture:
 *   - Net-new findings → block every time (the model CAN fix these).
 *   - Guardrail could not run (no baseline, dxkit error) → an operator/
 *     preflight problem the model can't fix. Fail closed by surfacing it
 *     once (exit 2, operator-visible) then allow on the next attempt to
 *     avoid thrashing to the block cap. `DXKIT_LOOP_FAIL_OPEN=1` allows
 *     immediately with a loud warning instead. Never a silent skip.
 */
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import { blockingPairs, findingBreakdown, buildRepairMessage } from './repair-message';
export { buildRepairMessage };
// The CLI entry (`runStopGate`) lives in `stop-gate-cli.ts` (module-size
// split; it imports this module's `computeStopGate`, so no re-export here —
// that would be an import cycle).
import { buildLedgerEvent, type CheckStatus, type LedgerEvent } from './ledger';
import { dxkitCli } from '../self-invocation';
import { buildFloorRepairMessage, floorLedgerStatuses, type FloorGateOutcome } from './floor-gate';
import { runConfiguredTests, type StopHookPayload } from './stop-gate-io';
import { buildOrderRepairMessage, readOrderScope, unresolvedOrderIds } from './order-scope';

/** What the gate decided, before any process I/O. */
export interface StopGateDecision {
  /** 'allow' → exit 0 silent; 'block-model' → exit 0 + decision JSON;
   *  'block-operator' → exit 2 + stderr. */
  readonly outcome: 'allow' | 'block-model' | 'block-operator';
  /** Message fed to the model (block-model) or operator (block-operator). */
  readonly message: string;
  /** Ledger event recorded for this decision. */
  readonly event: LedgerEvent;
}

/**
 * Run the gate. Pure of stdout/exit — returns a decision the CLI wrapper
 * turns into process output + exit code. `runCheck` is injected so tests
 * can drive the gate without a real repo + baseline.
 */
export async function computeStopGate(
  cwd: string,
  payload: StopHookPayload,
  runCheck: (repoDir: string) => Promise<GuardrailJsonPayload>,
  runFloor: (repoDir: string) => FloorGateOutcome = () => ({
    kind: 'unavailable',
    reason: 'floor not wired for this gate run',
  }),
  // The remediate lane's order scope (section 3C): read from
  // `.dxkit/loop/order.json` via the ONE order-scope module; injectable so
  // tests drive the order arm without touching the filesystem. The check
  // EXECUTES nothing — it post-processes the guardrail payload and floor
  // outcome already computed above, so a hostile order file can never widen
  // execution on any tree.
  readScope: (repoDir: string) => ReturnType<typeof readOrderScope> = readOrderScope,
): Promise<StopGateDecision> {
  const start = Date.now();
  const repoDir = payload.cwd || cwd;
  const stopActive = !!payload.stop_hook_active;
  const failOpen = process.env.DXKIT_LOOP_FAIL_OPEN === '1';
  const session = payload.session_id || '';
  const agentFields = {
    ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
    ...(payload.agent_type ? { agent_type: payload.agent_type } : {}),
  };

  let json: GuardrailJsonPayload;
  try {
    json = await runCheck(repoDir);
  } catch (err) {
    // Guardrail could not run — a preflight/config problem (no baseline,
    // dxkit error) the model cannot repair.
    const msg = (err as Error).message || String(err);
    const allow = failOpen || stopActive;
    const event = buildLedgerEvent(repoDir, {
      session_id: session,
      ...agentFields,
      cwd: repoDir,
      guardrail_status: 'error',
      net_new_findings: 0,
      baseline_findings: 0,
      files_changed: 0,
      allowed: allow,
      stop_hook_active: stopActive,
      tests_status: 'skipped',
      lint_status: 'not_configured',
      typecheck_status: 'not_configured',
      duration_ms: Date.now() - start,
    });
    if (allow) {
      return {
        outcome: 'allow',
        event,
        message:
          `dxkit Stop-gate could not run the guardrail (${msg}). Allowing stop. ` +
          `Fix the loop preflight (run \`${dxkitCli('baseline create')}\` / ` +
          `\`${dxkitCli('loop doctor')}\`) before trusting unattended runs.`,
      };
    }
    return {
      outcome: 'block-operator',
      event,
      message:
        `dxkit Stop-gate could not run the guardrail: ${msg}\n` +
        `This is a loop preflight problem, not something the agent can fix. ` +
        `Run \`${dxkitCli('loop doctor')}\` / \`${dxkitCli('baseline create')}\`, or set ` +
        `DXKIT_LOOP_FAIL_OPEN=1 to allow stops when the gate can't run.`,
    };
  }

  const blocking = blockingPairs(json);
  const guardrailBlocks = blocking.length > 0;
  // Per-category interception detail, recorded on every event from here down
  // (all have the guardrail payload in scope) so `metrics` can attribute
  // blocked/warned findings to a kind. See findingBreakdown.
  const breakdown = findingBreakdown(json);

  // Guardrail decides first. If it blocks, don't bother running tests —
  // the model must fix the findings regardless.
  if (guardrailBlocks) {
    const event = buildLedgerEvent(repoDir, {
      session_id: session,
      ...agentFields,
      cwd: repoDir,
      branch: json.current.branch,
      commit: json.current.commitSha,
      guardrail_status: 'fail',
      net_new_findings: blocking.length,
      ...breakdown,
      baseline_findings: json.baseline.findingsCount,
      files_changed: 0,
      allowed: false,
      stop_hook_active: stopActive,
      tests_status: 'skipped',
      lint_status: 'not_configured',
      typecheck_status: 'not_configured',
      duration_ms: Date.now() - start,
    });
    return { outcome: 'block-model', event, message: buildRepairMessage(json) };
  }

  // The guardrail REFUSED to gate: block-rule-class findings exist that recall
  // drift made unattributable (`CANNOT GATE`). Not agent-repairable — the
  // remedy is re-baselining, which an unattended loop must never do to clear a
  // gate (that would grandfather whatever the drift is hiding). Fail CLOSED to
  // the operator: allowing the stop would certify "no net-new secrets" over a
  // gap dxkit just said it cannot see across.
  if (json.verdict.refused) {
    const gaps = json.attributionGaps
      .map((g) => `${g.kind} (rules: ${g.rules.join(', ')}, findings: ${g.findingCount})`)
      .join('; ');
    const event = buildLedgerEvent(repoDir, {
      session_id: session,
      ...agentFields,
      cwd: repoDir,
      branch: json.current.branch,
      commit: json.current.commitSha,
      guardrail_status: 'error',
      net_new_findings: 0,
      ...breakdown,
      baseline_findings: json.baseline.findingsCount,
      files_changed: 0,
      allowed: false,
      stop_hook_active: stopActive,
      tests_status: 'skipped',
      lint_status: 'not_configured',
      typecheck_status: 'not_configured',
      duration_ms: Date.now() - start,
    });
    return {
      outcome: 'block-operator',
      event,
      message:
        `dxkit guardrail CANNOT GATE: findings covered by block rules cannot be attributed ` +
        `(recall drift) — ${gaps}. This is a baseline problem, not something the agent can ` +
        `fix: re-baseline via \`${dxkitCli('update')}\` or ` +
        `\`${dxkitCli('baseline create --force')}\` and re-run the loop. Do NOT re-baseline ` +
        `just to clear this if the drifted findings are unreviewed.`,
    };
  }

  // Guardrail passed — run the correctness FLOOR (liveness) before the optional
  // configured test command. The floor asks "does this code compile + do the
  // tests it affects pass", and blocks only on failures that are NET-NEW vs the
  // loop's entry snapshot — a pre-existing compile error / failing test recorded
  // on the pristine base never blocks (that would be punishing the agent for
  // debt it did not introduce). A skipped floor (no active pack provides one,
  // or the toolchain isn't installed) is a no-op.
  const floor = runFloor(repoDir);
  // Floor availability is recorded on every subsequent ledger event — an
  // internal floor error or an unavailable floor is fail-open (never blocks)
  // but DISCLOSED, so a floor that silently stopped enforcing is visible in
  // the ledger instead of reading as "no floor configured".
  const floorDisclosure =
    floor.kind === 'ran'
      ? { floor_status: 'ran' as const }
      : {
          floor_status: floor.kind,
          floor_detail: floor.kind === 'unavailable' ? floor.reason : floor.message,
        };
  if (floor.kind === 'ran' && floor.netNew.length > 0) {
    const floorStatuses = floorLedgerStatuses(floor.result);
    const event = buildLedgerEvent(repoDir, {
      session_id: session,
      ...agentFields,
      cwd: repoDir,
      branch: json.current.branch,
      commit: json.current.commitSha,
      guardrail_status: 'pass',
      net_new_findings: 0,
      ...breakdown,
      baseline_findings: json.baseline.findingsCount,
      files_changed: 0,
      allowed: false,
      stop_hook_active: stopActive,
      tests_status: floorStatuses.tests_status,
      lint_status: 'not_configured',
      typecheck_status: floorStatuses.typecheck_status,
      ...floorDisclosure,
      duration_ms: Date.now() - start,
    });
    return {
      outcome: 'block-model',
      event,
      message: buildFloorRepairMessage(floor.netNew, floor.result),
    };
  }
  const floorStatuses =
    floor.kind === 'ran'
      ? floorLedgerStatuses(floor.result)
      : {
          typecheck_status: 'not_configured' as CheckStatus,
          tests_status: 'not_configured' as CheckStatus,
        };

  // The remediate lane's ORDER SCOPE (one-order-per-run dispatch): when the
  // lane declared the current order's done criterion, "done" is verified
  // in-session — the stop blocks while any of the order's target findings is
  // still present, and the block reason hands back exactly the ids left to
  // close. Judged only from the guardrail payload + floor outcome already
  // computed above (nothing executes); an absent file keeps every
  // pre-existing behavior exactly, and a malformed one is a DISCLOSED skip.
  const orderRead = readScope(repoDir);
  let orderNote = orderRead.problem ? `dxkit Stop-gate: ${orderRead.problem}` : '';
  if (orderRead.scope) {
    const verdict = unresolvedOrderIds(orderRead.scope, json, floor);
    if (verdict.unresolved.length > 0) {
      const event = buildLedgerEvent(repoDir, {
        session_id: session,
        ...agentFields,
        cwd: repoDir,
        branch: json.current.branch,
        commit: json.current.commitSha,
        guardrail_status: 'pass',
        net_new_findings: 0,
        ...breakdown,
        baseline_findings: json.baseline.findingsCount,
        files_changed: 0,
        allowed: false,
        stop_hook_active: stopActive,
        tests_status: 'skipped',
        lint_status: 'not_configured',
        typecheck_status: floorStatuses.typecheck_status,
        ...floorDisclosure,
        duration_ms: Date.now() - start,
      });
      return {
        outcome: 'block-model',
        event,
        message: buildOrderRepairMessage(orderRead.scope, verdict.unresolved),
      };
    }
    if (verdict.undecidable) {
      // Fail-open, disclosed: the gate cannot answer the order's done
      // question here — the frame's post-run tree verification arbitrates.
      orderNote =
        `dxkit Stop-gate: could not verify work order ${orderRead.scope.orderId} in-session ` +
        `(${verdict.undecidable}); the frame's post-run verification decides.`;
    } else if (verdict.disclosure) {
      // Done with a fact worth seeing (sibling findings keep the shared
      // check red) — rides the allow's stderr, never a block.
      orderNote = `dxkit Stop-gate: ${verdict.disclosure}`;
    }
  }

  // Guardrail + floor passed — run the optional configured test command.
  const tests = runConfiguredTests(repoDir);
  if (tests.status === 'fail') {
    const event = buildLedgerEvent(repoDir, {
      session_id: session,
      ...agentFields,
      cwd: repoDir,
      branch: json.current.branch,
      commit: json.current.commitSha,
      guardrail_status: 'pass',
      net_new_findings: 0,
      ...breakdown,
      baseline_findings: json.baseline.findingsCount,
      files_changed: 0,
      allowed: false,
      stop_hook_active: stopActive,
      tests_status: 'fail',
      lint_status: 'not_configured',
      typecheck_status: floorStatuses.typecheck_status,
      ...floorDisclosure,
      duration_ms: Date.now() - start,
    });
    return {
      outcome: 'block-model',
      event,
      message:
        `dxkit allowed the guardrail but the configured test command failed.\n` +
        `Fix the failure below, then try to stop again.\n\n${tests.tail}`,
    };
  }

  // Clean stop.
  const event = buildLedgerEvent(repoDir, {
    session_id: session,
    ...agentFields,
    cwd: repoDir,
    branch: json.current.branch,
    commit: json.current.commitSha,
    guardrail_status: 'pass',
    net_new_findings: 0,
    ...breakdown,
    baseline_findings: json.baseline.findingsCount,
    files_changed: 0,
    allowed: true,
    stop_hook_active: stopActive,
    // Prefer the explicit configured-test status; otherwise report what the
    // correctness floor's affected-test stage saw.
    tests_status: tests.status !== 'not_configured' ? tests.status : floorStatuses.tests_status,
    lint_status: 'not_configured',
    typecheck_status: floorStatuses.typecheck_status,
    ...floorDisclosure,
    duration_ms: Date.now() - start,
  });
  // An allow's message reaches the operator on stderr — a disclosed
  // order-scope skip (malformed file, undecidable verifier) rides it so
  // the skip is never silent.
  return { outcome: 'allow', event, message: orderNote };
}
