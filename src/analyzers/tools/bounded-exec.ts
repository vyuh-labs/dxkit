/**
 * Bounded command execution — the ONE spawn + wall-clock-timeout + fail-open
 * primitive shared by every "run a repo command and fold its exit into a
 * pass/fail signal" surface (the correctness floor AND the custom-check gate
 * runner). Extracted so those two do not each carry their own copy of the
 * fail-open-on-missing-binary / fail-open-on-timeout dance (CLAUDE.md Rule 2 —
 * one concept, one code path).
 *
 * Policy, in one place. The through-line: dxkit only reports what it actually
 * OBSERVED. Every arm where observation failed is fail-OPEN, because a claim
 * dxkit cannot ground is worse than no claim at all.
 *   - a missing binary is fail-OPEN (`available: false`) — the toolchain isn't
 *     installed here, so the check is skipped, never failed. A hook must not
 *     block a developer who hasn't installed a linter locally; CI is the backstop.
 *   - a timeout is fail-OPEN (`timedOut: true`) — a SLOW command is not a BROKEN
 *     one; the run didn't finish, so it says nothing.
 *   - an output overflow is fail-OPEN (`overflowed: true`) — the output is a
 *     fragment, so any count derived from it would be fiction.
 *   - a non-zero exit from a command that RAN is a real signal — `code` carries it.
 *   - `output` is the COMPLETE stream. Renderers truncate for display; parsers
 *     get everything. This module never hands out a fragment it hasn't flagged.
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
  /**
   * Text piped to the child's stdin (the extension runner's config
   * payload). Absent → stdin is ignored, exactly as before this field
   * existed; the correctness floor and custom-check callers never set it.
   */
  readonly stdin?: string;
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
 *  - `available:false`  → the binary isn't on PATH (fail-open skip);
 *  - `timedOut:true`    → the command exceeded its wall-clock budget (fail-open);
 *  - `overflowed:true`  → the child outran the capture buffer, so `output` is a
 *    FRAGMENT (fail-open — see below);
 *  - otherwise `code` is the exit status and `output` is the command's COMPLETE
 *    combined output.
 *
 * `output` is always the WHOLE stream, never a tail. Truncation is a DISPLAY
 * concern and belongs to whoever renders a block message (`tail()` below); a
 * capture primitive that silently truncates hands its consumers a fragment they
 * cannot distinguish from the real thing. That shipped: the custom-check gate
 * regex-parsed the last 4 KB of a 2.6 MB eslint run and reported 20 of 18,615
 * findings, and because the baseline and the guardrail share this path the
 * window slid between runs and minted false net-new findings.
 */
export interface CommandOutcome {
  readonly available: boolean;
  readonly timedOut?: boolean;
  readonly overflowed?: boolean;
  readonly code: number;
  readonly output: string;
}

export type CommandExec = (cmd: RunnableCommand, cwd: string) => CommandOutcome;

/** Capture ceiling. Reaching it is `overflowed` (fail-open), never a silent cut:
 *  a fragment dxkit cannot measure is a fragment dxkit must not draw conclusions
 *  from. */
const MAX_CAPTURE = 64 * 1024 * 1024;

const OUTPUT_TAIL = 4000; // display cap — applied by RENDERERS, never at capture

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
        stdio: [cmd.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
        maxBuffer: MAX_CAPTURE,
        ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGTERM' } : {}),
      });
      return { available: true, code: 0, output: out };
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
        return { available: true, timedOut: true, code: -1, output: combined };
      }
      // ENOBUFS: the child outran MAX_CAPTURE, so `combined` is a FRAGMENT cut at
      // an arbitrary byte. Fail-OPEN, exactly like a timeout — dxkit did not read
      // the output, so it has nothing to say about it. Note `err.status` is null
      // here, so the fallthrough below would otherwise code this as exit 1: an
      // infrastructure limit reported as a real command failure, which is the
      // class of bug this module's own policy exists to prevent.
      if (err.code === 'ENOBUFS') {
        return { available: true, overflowed: true, code: -1, output: combined };
      }
      // A non-numeric status (spawn error, non-timeout signal) is treated as a
      // failure with code 1 — the binary existed (binaryAvailable passed) but the
      // run broke.
      return {
        available: true,
        code: typeof err.status === 'number' ? err.status : 1,
        output: combined,
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
