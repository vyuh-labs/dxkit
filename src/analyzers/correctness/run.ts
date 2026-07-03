/**
 * The correctness-floor runner — executes each active pack's syntax + affected-
 * test commands and folds them into one pass/fail signal.
 *
 * Policy, in one place so every surface behaves the same:
 *   - fail-CLOSED on a real failure — a non-zero exit from a check that ran is a
 *     genuine syntax error / failing test, and it BLOCKS.
 *   - fail-OPEN on infrastructure — a missing binary (the toolchain isn't
 *     installed here) skips the check rather than failing it. A hook must not
 *     block a developer who simply hasn't installed a linter locally; CI, where
 *     the toolchain is present, is the backstop.
 *
 * Commands come from `LanguageSupport.correctness` via the registry helper
 * (Rule 6); this module never hardcodes a per-language command. Command
 * execution is injected so tests exercise the policy without a real toolchain.
 */

import { execFileSync } from 'child_process';
import { commandExists } from '../tools/runner';
import { activeCorrectnessProviders } from '../../languages';
import type { LanguageId, LanguageSupport } from '../../languages/types';
import type {
  CorrectnessCommand,
  CorrectnessScope,
} from '../../languages/capabilities/correctness';

export type CorrectnessStatus = 'pass' | 'fail' | 'skipped-unavailable' | 'skipped-none';

export interface CorrectnessCheckResult {
  readonly pack: LanguageId;
  readonly label: string;
  readonly bin: string;
  readonly status: CorrectnessStatus;
  /** Captured output tail — present only on `fail`, for the block message. */
  readonly output?: string;
}

export interface CorrectnessFloorResult {
  /** True when at least one check actually executed (not all skipped). */
  readonly ran: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  /** True when any check that ran failed — the floor blocks. */
  readonly blocks: boolean;
}

/** Outcome of running one command: `available:false` → the binary isn't on PATH
 *  (fail-open skip); otherwise `code` is the exit status and `output` its tail. */
export interface CommandOutcome {
  readonly available: boolean;
  readonly code: number;
  readonly output: string;
}

export type CommandExec = (cmd: CorrectnessCommand, cwd: string) => CommandOutcome;

const OUTPUT_TAIL = 4000; // cap captured output so a block message stays readable

/** Default exec: resolve on PATH, run, capture combined output tail. */
export const defaultCommandExec: CommandExec = (cmd, cwd) => {
  if (!commandExists(cmd.bin)) return { available: false, code: -1, output: '' };
  try {
    const out = execFileSync(cmd.bin, [...cmd.args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { available: true, code: 0, output: tail(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // A non-numeric status (spawn error, signal) is treated as a failure with
    // code 1 — the binary existed (commandExists passed) but the run broke.
    return {
      available: true,
      code: typeof err.status === 'number' ? err.status : 1,
      output: tail(combined),
    };
  }
};

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}

export interface CorrectnessFloorOptions {
  readonly cwd: string;
  readonly changedFiles: readonly string[];
  readonly scope: CorrectnessScope;
  /** Active language packs (from `activeLanguagesFromStack` / `-Flags`). */
  readonly packs: readonly LanguageSupport[];
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
}

/**
 * Run the correctness floor across the active packs. Never throws — an exec
 * error surfaces as a `fail` check (fail-closed), a missing binary as
 * `skipped-unavailable` (fail-open). `blocks` is true iff a check that ran
 * failed.
 */
export function runCorrectnessFloor(opts: CorrectnessFloorOptions): CorrectnessFloorResult {
  const exec = opts.exec ?? defaultCommandExec;
  const ctx = { cwd: opts.cwd, changedFiles: opts.changedFiles, scope: opts.scope };
  const checks: CorrectnessCheckResult[] = [];

  for (const { id, provider } of activeCorrectnessProviders(opts.packs)) {
    const commands = [provider.syntaxCheck(ctx), provider.affectedTests(ctx)];
    for (const cmd of commands) {
      if (cmd === null) continue; // pack declined this check for this change
      const outcome = exec(cmd, opts.cwd);
      if (!outcome.available) {
        checks.push({ pack: id, label: cmd.label, bin: cmd.bin, status: 'skipped-unavailable' });
        continue;
      }
      checks.push({
        pack: id,
        label: cmd.label,
        bin: cmd.bin,
        status: outcome.code === 0 ? 'pass' : 'fail',
        ...(outcome.code === 0 ? {} : { output: outcome.output }),
      });
    }
  }

  const ran = checks.some((c) => c.status === 'pass' || c.status === 'fail');
  const blocks = checks.some((c) => c.status === 'fail');
  return { ran, checks, blocks };
}

/** One-line human summary of a floor result (for the Stop-gate / hook block). */
export function describeCorrectnessFloor(result: CorrectnessFloorResult): string {
  const failed = result.checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) return 'correctness floor: all checks passed';
  const which = failed.map((c) => `${c.pack} ${c.label}`).join(', ');
  return `correctness floor: ${failed.length} check(s) failed — ${which}`;
}
