/**
 * `vyuh-dxkit hook stop-gate` — the CLI entry wrapper around the pure gate
 * (`stop-gate.ts:computeStopGate`). Split from the gate at the module-size
 * bar (the `stop-gate-io` precedent): this side owns the process I/O —
 * loop-scoped activation, the verdict cache fast path, running the
 * guardrail in-process, ledger writes, and the exit-code protocol.
 */
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import { appendLedgerEvent, buildLedgerEvent, LEDGER_DIR } from './ledger';
import * as fs from 'fs';
import * as path from 'path';
import {
  loopGateActive,
  workingTreeSignature,
  environmentSignature,
  readStateCache,
  writeStateCache,
} from './gate-cache';
import { buildFloorGate } from './floor-gate';
import { readStdinPayload } from './stop-gate-io';
import { orderScopePresent } from './order-scope';
import { trustedLocalContext } from '../analysis-trust';
import { computeStopGate } from './stop-gate';

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
  // ANY order-scope file on disk bypasses the verdict cache entirely: the
  // tree signature deliberately excludes dxkit's own runtime state, so it
  // cannot see `.dxkit/loop/order.json` appear, change, or clear — a cached
  // ALLOW from an unscoped stop must never replay over a pending order, and
  // a malformed or foreign file still means "something is scoping stops
  // here": re-derive (which discloses the problem) rather than replay.
  const orderScoped = orderScopePresent(repoDir);
  const signature =
    process.env.DXKIT_LOOP_NO_CACHE === '1' || orderScoped ? null : workingTreeSignature(repoDir);
  // The environment half of the cache key (T1.3): same tree + DIFFERENT
  // observer (dxkit / policy / test command / scanner binaries) must MISS,
  // or a scanner upgrade between sessions replays a stale ALLOW.
  const envSignature = signature
    ? environmentSignature(repoDir, {
        preset,
        policy,
        modes: { flowMode, schemaMode, duplicationMode },
      })
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
      trust: trustedLocalContext(),
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
