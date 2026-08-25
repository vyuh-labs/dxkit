/**
 * The lockfile-sync floor check executor (4.4.5), split from the runner for
 * module size. Policy lives here exactly as for the other checks: a real
 * failure blocks, infrastructure is a disclosed skip, a pack-declared
 * tolerated failure is a PASS that carries its disclosure.
 */
import type { LanguageId } from '../../languages/types';
import {
  LOCKFILE_SYNC_LABEL,
  type CorrectnessContext,
  type CorrectnessProvider,
} from '../../languages/capabilities/correctness';
import { tail, type CommandExec } from '../tools/bounded-exec';
import type { CorrectnessCheckResult } from './run';

/**
 * Execute a pack's optional lockfile-sync check (4.4.5): the ecosystem's
 * non-installing frozen-install dry-run. A non-zero exit the pack declared
 * `tolerated` (npm's peer conflict, which CI's install retries under
 * `--legacy-peer-deps`) is a PASS carrying the disclosure as `note`; any
 * other non-zero exit (an out-of-sync lockfile) is a real failure, the exact
 * shape that killed CI's install before the gate ran. A pack skip and an
 * unavailable binary are fail-open, disclosed. Returns null when the pack
 * declined (no lockfile).
 */
export function runLockfileCheck(
  id: LanguageId,
  provider: CorrectnessProvider,
  ctx: CorrectnessContext,
  exec: CommandExec,
): CorrectnessCheckResult | null {
  let check;
  try {
    check = provider.lockfileCheck!(ctx);
  } catch (err) {
    return {
      pack: id,
      label: LOCKFILE_SYNC_LABEL,
      bin: '',
      status: 'skipped-unavailable',
      output: `lockfile-sync check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (check === null) return null;
  if (check.kind === 'skipped') {
    return {
      pack: id,
      label: LOCKFILE_SYNC_LABEL,
      bin: '',
      status: 'skipped-unavailable',
      output: check.reason,
    };
  }
  const cmd = check.command;
  const base = { pack: id, label: cmd.label, bin: cmd.bin, args: cmd.args };
  const outcome = exec(cmd, ctx.cwd);
  if (!outcome.available) {
    return {
      ...base,
      status: 'skipped-unavailable',
      ...(outcome.output ? { output: outcome.output } : {}),
    };
  }
  if (outcome.timedOut) return { ...base, status: 'skipped-timeout' };
  if (outcome.overflowed) return { ...base, status: 'skipped-overflow' };
  if (outcome.code === 0) return { ...base, status: 'pass' };
  if (check.tolerated && check.tolerated.matches(outcome.output)) {
    return { ...base, status: 'pass', note: check.tolerated.disclosure };
  }
  return {
    ...base,
    status: 'fail',
    output:
      tail(outcome.output) +
      '\nThe lockfile does not satisfy the manifest: a frozen install (what CI runs before ' +
      'any gate) fails on this tree. Re-run the package manager install so the lockfile ' +
      'records the manifest, and commit both.',
  };
}
