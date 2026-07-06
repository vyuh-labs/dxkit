/**
 * Bounded command execution — the ONE spawn + wall-clock-timeout + fail-open
 * primitive shared by every "run a repo command and fold its exit into a
 * pass/fail signal" surface (the correctness floor AND the custom-check gate
 * runner). Extracted so those two do not each carry their own copy of the
 * fail-open-on-missing-binary / fail-open-on-timeout / capture-output-tail
 * dance (CLAUDE.md Rule 2 — one concept, one code path).
 *
 * Policy, in one place:
 *   - a missing binary is fail-OPEN (`available: false`) — the toolchain isn't
 *     installed here, so the check is skipped, never failed. A hook must not
 *     block a developer who hasn't installed a linter locally; CI is the backstop.
 *   - a timeout is fail-OPEN (`timedOut: true`) — a SLOW command is not a BROKEN
 *     one; the run didn't finish, so it says nothing.
 *   - a non-zero exit from a command that RAN is a real signal — `code` carries it.
 *
 * Execution is injected into the runners (they accept a `CommandExec`), so tests
 * exercise the runner policy without a real toolchain; this module supplies the
 * real PATH-resolving + `execFileSync` implementation.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { commandExists } from './runner';

/** The minimum a runnable command needs: a binary + its args. Both the
 *  correctness floor's `CorrectnessCommand` and the custom-check runner's
 *  command shape structurally satisfy this. */
export interface RunnableCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * Is a command's `bin` runnable? A bare name is resolved on PATH (`tsc`,
 * `cargo`, `npx`, `eslint`); a path-like `bin` (a pack that resolved an
 * absolute interpreter — a project venv's `python`, a `findTool` path) is
 * accepted when the file exists. Without the latter, a resolved-path bin would
 * be wrongly treated as missing and the check skipped (fail-open on a tool that
 * IS present) — so this keeps the fail-open gate honest.
 */
export function binaryAvailable(bin: string): boolean {
  if (bin.includes('/') || bin.includes(path.sep)) {
    try {
      return fs.statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  return commandExists(bin);
}

/** Outcome of running one command:
 *  - `available:false` → the binary isn't on PATH (fail-open skip);
 *  - `timedOut:true`   → the command exceeded its wall-clock budget (fail-open);
 *  - otherwise `code` is the exit status and `output` its tail. */
export interface CommandOutcome {
  readonly available: boolean;
  readonly timedOut?: boolean;
  readonly code: number;
  readonly output: string;
}

export type CommandExec = (cmd: RunnableCommand, cwd: string) => CommandOutcome;

const OUTPUT_TAIL = 4000; // cap captured output so a block message stays readable

/**
 * Build a command exec bounded by an optional per-command wall-clock timeout.
 * On timeout the child is killed and the outcome is `timedOut` (fail-open),
 * distinct from a non-zero exit (a real failure, fail-closed). `timeoutMs`
 * undefined/0 → no timeout (CI, where the full suite is expected to run).
 */
export function makeCommandExec(timeoutMs?: number): CommandExec {
  return (cmd, cwd) => {
    if (!binaryAvailable(cmd.bin)) return { available: false, code: -1, output: '' };
    try {
      const out = execFileSync(cmd.bin, [...cmd.args], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGTERM' } : {}),
      });
      return { available: true, code: 0, output: tail(out) };
    } catch (e) {
      const err = e as {
        status?: number;
        code?: string;
        signal?: string;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      // execFileSync sets `code: 'ETIMEDOUT'` (and signal = killSignal) when it
      // fired the timeout kill. Treat that as a fail-OPEN skip, not a failure —
      // the run didn't finish, so it says nothing about the check.
      if (err.code === 'ETIMEDOUT') {
        return { available: true, timedOut: true, code: -1, output: tail(combined) };
      }
      // A non-numeric status (spawn error, non-timeout signal) is treated as a
      // failure with code 1 — the binary existed (binaryAvailable passed) but the
      // run broke.
      return {
        available: true,
        code: typeof err.status === 'number' ? err.status : 1,
        output: tail(combined),
      };
    }
  };
}

/** Default exec: resolve on PATH, run unbounded, capture combined output tail. */
export const defaultCommandExec: CommandExec = makeCommandExec();

/** Trim + tail-truncate captured output so a block message stays readable. */
export function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}
