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
import {
  appendLedgerEvent,
  buildLedgerEvent,
  LEDGER_DIR,
  type CheckStatus,
  type LedgerEvent,
} from './ledger';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dxkitCli } from '../self-invocation';
import {
  loopGateActive,
  workingTreeSignature,
  environmentSignature,
  readStateCache,
  writeStateCache,
} from './gate-cache';
import {
  buildFloorGate,
  buildFloorRepairMessage,
  floorLedgerStatuses,
  type FloorGateOutcome,
} from './floor-gate';
import { resolveLoopTestCommand } from './policy';

/** Subset of the Claude Code Stop-hook stdin payload we consume. */
interface StopHookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly stop_hook_active?: boolean;
  readonly agent_id?: string;
  readonly agent_type?: string;
  /**
   * Active permission mode, when Claude Code includes it
   * (`default` | `plan` | `acceptEdits` | `auto` | `dontAsk` |
   * `bypassPermissions`). `bypassPermissions` is the canonical
   * unattended/headless mode (`--dangerously-skip-permissions` /
   * `--permission-mode bypassPermissions`), so it auto-activates the gate.
   * Not guaranteed present on every event, so the env / sentinel remain the
   * reliable override for guaranteed gating.
   */
  readonly permission_mode?: string;
}

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

/** Read and parse the stdin hook payload; {} on any problem. */
function readStdinPayload(): StopHookPayload {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as StopHookPayload;
  } catch {
    return {};
  }
}

/**
 * Optional configured test command (DXKIT_LOOP_TEST_COMMAND). Runs only
 * after the guardrail passes. Returns the status plus a short failure
 * tail to surface in the block message. `not_configured` when unset.
 */
function runConfiguredTests(repoDir: string): { status: CheckStatus; tail: string } {
  const cmd = resolveLoopTestCommand(repoDir);
  if (!cmd || !cmd.trim()) return { status: 'not_configured', tail: '' };
  try {
    execSync(cmd, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 'pass', tail: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    const tail = out.split('\n').slice(-15).join('\n');
    return { status: 'fail', tail };
  }
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
  runFloor: (repoDir: string) => FloorGateOutcome | null = () => null,
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
  if (floor && floor.netNew.length > 0) {
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
      duration_ms: Date.now() - start,
    });
    return { outcome: 'block-model', event, message: buildFloorRepairMessage(floor.netNew) };
  }
  const floorStatuses = floor
    ? floorLedgerStatuses(floor.result)
    : {
        typecheck_status: 'not_configured' as CheckStatus,
        tests_status: 'not_configured' as CheckStatus,
      };

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
    duration_ms: Date.now() - start,
  });
  return { outcome: 'allow', event, message: '' };
}

/**
 * CLI entry for `vyuh-dxkit hook stop-gate`. Reads the hook payload from
 * stdin, runs the guardrail in-process, writes the ledger + last-guardrail
 * snapshot, then emits the Stop-hook decision and exits.
 */
export async function runStopGate(cwd: string): Promise<void> {
  const payload = readStdinPayload();
  const repoDir = payload.cwd || cwd;

  // ── Loop-scoped activation. The Stop-gate is for UNATTENDED loops, where
  // no human is reviewing each stop. An interactive turn — a person present,
  // the agent stopping to ask a question — must not pay the guardrail cost.
  // So the hook is an instant no-op allow unless the loop marks itself
  // active (DXKIT_LOOP_ACTIVE=1, or a `.dxkit/loop/active` sentinel the loop
  // runner drops). The CI guardrail still gates the branch either way.
  if (!loopGateActive(repoDir, payload)) {
    process.exit(0);
  }

  // Resolve the loop-scoped posture ONCE (preset → policy). This is the
  // only place the loop preset is read; the CI guardrail never sees it.
  const { resolveLoopPolicy } = await import('./policy');
  const { policy, preset, flowMode, schemaMode, duplicationMode } = resolveLoopPolicy(repoDir);

  // ── Fast path: replay the last verdict when the working tree is
  // byte-identical to what was last gathered (a no-change stop — an
  // interactive Q&A turn, or a re-stop after a block with no edit). Skips
  // the full guardrail gather + tests entirely. Safe by construction: the
  // signature captures every file the gather would see, so a cache hit is
  // only ever a genuinely-identical tree and the cache can never skip a
  // real net-new finding. Bypass with DXKIT_LOOP_NO_CACHE=1.
  const signature = process.env.DXKIT_LOOP_NO_CACHE === '1' ? null : workingTreeSignature(repoDir);
  // The environment half of the cache key (T1.3): same tree + DIFFERENT
  // observer (dxkit / policy / test command / scanner binaries) must MISS,
  // or a scanner upgrade between sessions replays a stale ALLOW.
  const envSignature = signature
    ? environmentSignature(repoDir, { preset, policy, modes: { flowMode, schemaMode, duplicationMode } })
    : null;
  const agentFields = {
    ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
    ...(payload.agent_type ? { agent_type: payload.agent_type } : {}),
  };
  if (signature && envSignature) {
    const cached = readStateCache(repoDir);
    if (cached && cached.signature === signature && cached.envSignature === envSignature) {
      const event = buildLedgerEvent(repoDir, {
        session_id: payload.session_id || '',
        ...agentFields,
        cwd: repoDir,
        guardrail_status: cached.outcome === 'allow' ? 'pass' : 'fail',
        net_new_findings: cached.netNew,
        baseline_findings: cached.baselineFindings,
        files_changed: 0,
        allowed: cached.outcome === 'allow',
        stop_hook_active: !!payload.stop_hook_active,
        tests_status: 'skipped',
        lint_status: 'not_configured',
        typecheck_status: 'not_configured',
        duration_ms: 0,
        cached: true,
      });
      appendLedgerEvent(repoDir, { ...event, preset });
      if (cached.outcome === 'block-model') {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: cached.message }) + '\n');
        process.exit(0);
      }
      process.exit(0); // allow — clean stop replayed from cache
    }
  }

  // Scope the gather to the analyzers this posture can actually block on.
  // A `security-only` loop skips jscpd / lint / coverage / cloc / test-gaps /
  // graphify — they feed only kinds the policy can't act on, so skipping them
  // cannot change the verdict (see src/baseline/gather-scope.ts). Both sides
  // of the diff are scoped identically. `full-debt` derives FULL_SCOPE.
  const { scopeForPolicy } = await import('../baseline/gather-scope');
  const scope = scopeForPolicy(policy);

  const runCheck = async (dir: string): Promise<GuardrailJsonPayload> => {
    const { runGuardrailCheck } = await import('../baseline/check');
    const { renderJson } = await import('../baseline/check-renderers');
    // `incremental: true` scopes the current side's semgrep to changed
    // files (opt 3). Verdict-safe: semgrep is intraprocedural, so a net-new
    // code finding only appears in a file the diff touched, and the scan
    // falls back to full whenever the changed set can't be computed.
    const result = await runGuardrailCheck({
      cwd: dir,
      policy,
      scope,
      incremental: true,
      flowMode,
      schemaMode,
      duplicationMode,
    });
    const json = renderJson(result);
    // Persist the full machine-readable verdict so the model (and a human)
    // can read the exact net-new findings the block message points to.
    try {
      const dir2 = path.join(dir, LEDGER_DIR);
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(
        path.join(dir2, 'last-guardrail.json'),
        JSON.stringify(json, null, 2) + '\n',
        'utf8',
      );
    } catch {
      /* best-effort snapshot */
    }
    return json;
  };

  const decision = await computeStopGate(cwd, payload, runCheck, buildFloorGate);
  // Stamp the active preset onto the ledger line so the audit trail shows
  // which posture was in force when the gate allowed/blocked.
  appendLedgerEvent(repoDir, { ...decision.event, preset });

  // Persist the verdict keyed on the tree signature so the next stop with
  // an unchanged tree replays it instead of re-gathering. Only the
  // tree-deterministic outcomes are cached; an operator/preflight failure
  // is environment-dependent and must be re-tried.
  if (
    signature &&
    envSignature &&
    (decision.outcome === 'allow' || decision.outcome === 'block-model')
  ) {
    writeStateCache(repoDir, {
      signature,
      envSignature,
      outcome: decision.outcome,
      message: decision.message,
      netNew: decision.event.net_new_findings,
      baselineFindings: decision.event.baseline_findings,
    });
  }

  if (decision.outcome === 'block-model') {
    // Exit 0 + decision JSON on stdout → blocks the stop and feeds the
    // reason to the model so it repairs.
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.message }) + '\n');
    process.exit(0);
  }
  if (decision.outcome === 'block-operator') {
    // Exit 2 → blocks the stop; stderr reaches the operator (the model
    // can't fix a preflight problem).
    process.stderr.write(decision.message + '\n');
    process.exit(2);
  }
  // allow: exit 0 lets the stop proceed. Surface any warning (config
  // fail-open) on stderr so it isn't a silent skip.
  if (decision.message) process.stderr.write(decision.message + '\n');
  process.exit(0);
}
