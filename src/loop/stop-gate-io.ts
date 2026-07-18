/**
 * Stop-gate I/O — the hook-boundary plumbing split from `stop-gate.ts` so
 * the gate module stays the DECISION logic: reading the Claude Code Stop
 * payload from stdin, and running the operator-configured postflight test
 * command. Both are pure of gate policy.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { resolveLoopTestCommand } from './policy';
import type { CheckStatus } from './ledger';

/** Subset of the Claude Code Stop-hook stdin payload we consume. */
export interface StopHookPayload {
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

/** Read and parse the stdin hook payload; {} on any problem. */
export function readStdinPayload(): StopHookPayload {
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
export function runConfiguredTests(repoDir: string): { status: CheckStatus; tail: string } {
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
