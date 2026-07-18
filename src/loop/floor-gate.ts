/**
 * The loop's correctness-floor integration — how a Stop-gate runs the liveness
 * floor and diffs it against the loop's entry snapshot. Split out of
 * `stop-gate.ts` so that file stays focused on the guardrail/ledger flow (and
 * under the large-file threshold).
 *
 * The gate blocks only on failures that are NET-NEW versus the entry snapshot
 * captured at loop activation, so a pre-existing compile error / failing test
 * never blocks (that would punish the agent for debt it did not introduce). The
 * pre-push and CI surfaces have their own runner (`analyzers/correctness/
 * surface-run.ts`); this module is the loop-stop surface alone.
 */

import { execFileSync } from 'child_process';

import { detectActiveLanguages } from '../languages';
import { computeChangedFiles } from '../baseline/changed-files';
import {
  runCorrectnessFloor,
  type CorrectnessCheckResult,
  type CorrectnessFloorResult,
} from '../analyzers/correctness/run';
import { resolveCorrectnessSurface } from '../analyzers/correctness/surface';
import { readFloorBaseline, writeFloorBaseline, netNewFloorFailures } from './floor-state';
import { clearStateCache } from './gate-cache';
import { type CheckStatus } from './ledger';

/**
 * The correctness-floor outcome for one Stop: the full run plus the failures
 * that are net-new vs the loop's entry snapshot. `runFloor` (injected into
 * `computeStopGate`) returns this, or null when no active pack provides a
 * correctness floor. The gate blocks only on `netNew` — a pre-existing failure
 * recorded in the entry snapshot never blocks.
 */
export interface FloorGateOutcome {
  readonly result: CorrectnessFloorResult;
  readonly netNew: readonly CorrectnessCheckResult[];
}

/** Derive the ledger's typecheck / tests status from a floor run. A failing
 *  check dominates; else a check that ran is `pass`; else `not_configured`. */
export function floorLedgerStatuses(result: CorrectnessFloorResult): {
  typecheck_status: CheckStatus;
  tests_status: CheckStatus;
} {
  const statusFor = (match: (label: string) => boolean): CheckStatus => {
    const relevant = result.checks.filter((c) => match(c.label));
    if (relevant.some((c) => c.status === 'fail')) return 'fail';
    if (relevant.some((c) => c.status === 'pass')) return 'pass';
    return 'not_configured';
  };
  return {
    typecheck_status: statusFor((l) => /typecheck|compile|build|syntax/.test(l)),
    tests_status: statusFor((l) => /test/.test(l)),
  };
}

/**
 * The repair message shown to the model when the correctness floor blocks.
 * Lists each net-new failing check with the captured output tail so the model
 * can fix it, and is explicit that the fix is the code, not the snapshot.
 */
export function buildFloorRepairMessage(netNew: readonly CorrectnessCheckResult[]): string {
  const lines: string[] = [];
  lines.push(
    `dxkit blocked completion because this change introduces ${netNew.length} net-new ` +
      `correctness failure${netNew.length === 1 ? '' : 's'} (code that does not compile or ` +
      `whose tests fail).`,
  );
  lines.push('');
  lines.push('Do not refresh the floor snapshot.');
  lines.push('Fix the failing check(s) below, then try to stop again.');
  lines.push('');
  netNew.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.pack} ${c.label} (${c.bin})`);
    if (c.output) {
      const tail = c.output.split('\n').slice(-12).join('\n');
      lines.push(tail.replace(/^/gm, '   '));
    }
  });
  return lines.join('\n');
}

/** Per-check wall-clock budget for the floor on the fast surface (ms).
 *  DXKIT_FLOOR_TIMEOUT_MS overrides; default 120s. A non-positive value
 *  disables the timeout (unbounded, e.g. to match CI locally). */
function floorTimeoutMs(): number {
  const raw = process.env.DXKIT_FLOOR_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 120_000;
}

/** Best-effort git stdout for a fixed arg vector; '' on any failure. */
function gitOut(repoDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** The comparison base for the floor's affected scope — the merge-base with
 *  `origin/main` (the guardrail's default base), falling back to the ref tip,
 *  then '' (→ full scope). */
function resolveFloorBase(repoDir: string): string {
  return (
    gitOut(repoDir, ['merge-base', 'HEAD', 'origin/main']) ||
    gitOut(repoDir, ['rev-parse', 'origin/main'])
  );
}

/**
 * The production correctness-floor gate for one Stop: resolve the active packs,
 * scope to the files changed vs the loop base, run the AFFECTED floor, and diff
 * it against the loop's entry snapshot. Returns null when no active pack
 * provides a floor (nothing to run) or when nothing actually executed. Best-
 * effort — any error returns null so the floor can never break the gate; the
 * finding guardrail still runs regardless.
 */
export function buildFloorGate(repoDir: string): FloorGateOutcome | null {
  try {
    // The loop Stop-gate is default-on, but an explicit flag / DXKIT_FLOOR_LOOP /
    // policy can disable the floor here — resolve through the one canonical
    // surface resolver so this default never drifts from the other surfaces.
    if (!resolveCorrectnessSurface({ surface: 'loop-stop', cwd: repoDir }).enabled) return null;
    const packs = detectActiveLanguages(repoDir).filter((p) => p.correctness);
    if (packs.length === 0) return null;
    const base = resolveFloorBase(repoDir);
    // Empty changedFiles (no base, or diff undeterminable) → the packs treat
    // the scope as full, per the CorrectnessContext contract.
    const changed = base ? (computeChangedFiles(repoDir, base) ?? []) : [];
    const result = runCorrectnessFloor({
      cwd: repoDir,
      changedFiles: changed,
      scope: 'affected',
      // Bound each check on the fast surface: a change to a widely-imported
      // "hub" file can make `related` select most of the suite, and a Stop hook
      // must not hang for minutes. A command that exceeds the budget is a
      // fail-OPEN skip (CI is the backstop), never a block. Tune with
      // DXKIT_FLOOR_TIMEOUT_MS; default 120s per check.
      timeoutMs: floorTimeoutMs(),
      packs,
    });
    if (!result.ran) return null; // every check skipped (toolchain absent) → no-op
    return { result, netNew: netNewFloorFailures(result, readFloorBaseline(repoDir)) };
  } catch {
    return null; // fail-open: the floor must never break the gate
  }
}

/**
 * Capture the loop's entry snapshot — the FULL floor on the current (pristine)
 * tree. Called at loop activation, before the agent has changed anything, so
 * the recorded failing set is genuinely pre-existing. Returns the run for
 * reporting, or null when no active pack provides a floor. Best-effort write.
 */
export function captureFloorSnapshot(repoDir: string): CorrectnessFloorResult | null {
  // A new loop session must never replay a previous session's verdict:
  // activation clears the Stop-gate verdict cache regardless of whether a
  // floor is available below (T1.3 session-scope belt).
  clearStateCache(repoDir);
  const packs = detectActiveLanguages(repoDir).filter((p) => p.correctness);
  if (packs.length === 0) return null;
  const result = runCorrectnessFloor({
    cwd: repoDir,
    changedFiles: [],
    scope: 'full',
    packs,
  });
  writeFloorBaseline(repoDir, result, gitOut(repoDir, ['rev-parse', 'HEAD']) || null);
  return result;
}
