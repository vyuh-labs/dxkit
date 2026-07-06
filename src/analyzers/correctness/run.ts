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

import { activeCorrectnessProviders } from '../../languages';
import type { LanguageId, LanguageSupport } from '../../languages/types';
import type { CorrectnessScope } from '../../languages/capabilities/correctness';
// The spawn + timeout + fail-open exec primitive is shared with the custom-check
// gate runner — one code path (Rule 2). Re-exported so existing callers (and
// tests) keep importing `CommandExec` / `makeCommandExec` from here.
import {
  makeCommandExec,
  defaultCommandExec,
  type CommandExec,
  type CommandOutcome,
} from '../tools/bounded-exec';

export { makeCommandExec, defaultCommandExec, type CommandExec, type CommandOutcome };

export type CorrectnessStatus =
  | 'pass'
  | 'fail'
  | 'skipped-unavailable'
  | 'skipped-timeout'
  | 'skipped-none';

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

export interface CorrectnessFloorOptions {
  readonly cwd: string;
  readonly changedFiles: readonly string[];
  readonly scope: CorrectnessScope;
  /** Active language packs (from `activeLanguagesFromStack` / `-Flags`). */
  readonly packs: readonly LanguageSupport[];
  /** Per-command wall-clock budget (ms). A command that exceeds it is a
   *  fail-OPEN skip, never a block — the fast surface stays fast, CI is the
   *  backstop. Undefined → no timeout. Ignored when `exec` is injected. */
  readonly timeoutMs?: number;
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
  const exec = opts.exec ?? makeCommandExec(opts.timeoutMs);
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
      if (outcome.timedOut) {
        // Exceeded the budget — fail-OPEN. The run didn't finish, so it says
        // nothing about correctness; CI (unbounded) is the backstop.
        checks.push({ pack: id, label: cmd.label, bin: cmd.bin, status: 'skipped-timeout' });
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
