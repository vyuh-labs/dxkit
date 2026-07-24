/**
 * The correctness-floor state ledger for the loop Stop-gate.
 *
 * The floor is diff-scoped like the finding gate — a PRE-EXISTING compile
 * error or failing test must not block the loop — but it is deliberately NOT a
 * baseline artifact: no fingerprint, no identity scheme, no version to migrate.
 * A failing test is a pass/fail signal, not a grandfathered finding.
 *
 * Instead we capture the ALREADY-BROKEN set ONCE, at loop activation, when the
 * working tree is still the pristine base the agent has not yet touched, and
 * store it in `.dxkit/loop/` (gitignored, transient). Each Stop re-runs the
 * AFFECTED floor and blocks only on failures ABSENT from that entry snapshot
 * (net-new). This is testmon's insight — persist last-known state rather than
 * recompute it from a git ref — scoped to one loop, so a Stop never pays a
 * `git worktree add` + `npm install` + full re-run (minutes) to learn what was
 * already broken.
 *
 * Granularity: a check's identity is `pack:label` (e.g. `typescript:typecheck`,
 * `typescript:affected-tests`). This is EXACT in the dominant case — a green
 * base captures an empty failing set, so every failure at a later Stop is
 * net-new and blocks. It degrades gracefully when the base is ALREADY red in a
 * check: additional net-new failures piled onto that same already-red check are
 * not distinguished from the pre-existing one (the check stays reported, not
 * silently cleared). Per-test attribution is a future refinement; check-level
 * is the honest v1 because you do not normally start a loop on a red branch —
 * the snapshot exists for the exception, and there it is conservative about the
 * pre-existing failure rather than about the new one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LEDGER_DIR } from './ledger';
import type { CorrectnessCheckResult, CorrectnessFloorResult } from '../analyzers/correctness/run';
import { attributeFloorFailures } from '../analyzers/correctness/attribution';

/** File under `.dxkit/loop/` holding the entry snapshot. */
export const FLOOR_BASELINE_FILE = 'floor-baseline.json';

/** One check's outcome as recorded in the entry snapshot. Only `pass` / `fail`
 *  are stored — a skipped check (tool unavailable / nothing to run) carries no
 *  liveness signal and is omitted so it can never mask a later real failure. */
export interface FloorCheckState {
  readonly pack: string;
  readonly label: string;
  readonly status: 'pass' | 'fail';
  /** Finding-level identities of a failing check that decomposes into
   *  findings (the import-resolution check's unresolved specifiers).
   *  Persisted so the comparator can diff the SET at a later Stop — an
   *  already-red check still blocks on a NEW finding. */
  readonly findings?: readonly string[];
}

/** The entry snapshot: what the floor looked like on the pristine base. */
export interface FloorBaseline {
  /** HEAD at capture time, for staleness detection / auditing. Null when the
   *  repo had no commit (the floor still works; the field is informational). */
  readonly capturedAtCommit: string | null;
  readonly checks: readonly FloorCheckState[];
}

/** Stable per-check identity used to diff a Stop against the entry snapshot.
 *  Re-exported from the canonical attribution module (T2.3) so the loop and
 *  the CI floor share ONE key scheme. */
export { checkKey } from '../analyzers/correctness/attribution';

function floorBaselinePath(cwd: string): string {
  return path.join(cwd, LEDGER_DIR, FLOOR_BASELINE_FILE);
}

/** Keep only the pass/fail checks — skipped ones carry no liveness signal. */
function liveChecks(checks: readonly CorrectnessCheckResult[]): FloorCheckState[] {
  return checks
    .filter((c) => c.status === 'pass' || c.status === 'fail')
    .map((c) => ({
      pack: c.pack,
      label: c.label,
      status: c.status as 'pass' | 'fail',
      ...(c.findings ? { findings: c.findings } : {}),
    }));
}

/**
 * Persist the entry snapshot from a floor run on the pristine base. Best-effort
 * — a write failure leaves no snapshot, which the diff below treats as "assume
 * the base was green" (every later failure is then net-new, the safe default).
 */
export function writeFloorBaseline(
  cwd: string,
  result: CorrectnessFloorResult,
  capturedAtCommit: string | null,
): void {
  const baseline: FloorBaseline = { capturedAtCommit, checks: liveChecks(result.checks) };
  try {
    const dir = path.join(cwd, LEDGER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(floorBaselinePath(cwd), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort — absence is handled as a green base by the diff */
  }
}

/** Read the entry snapshot; null when absent or malformed (→ green base). */
export function readFloorBaseline(cwd: string): FloorBaseline | null {
  try {
    const raw = fs.readFileSync(floorBaselinePath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as FloorBaseline;
    if (!Array.isArray(parsed.checks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Delete the entry snapshot (loop teardown). Best-effort. */
export function clearFloorBaseline(cwd: string): void {
  try {
    fs.rmSync(floorBaselinePath(cwd), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The net-new failures at this Stop: checks failing now that were NOT already
 * failing in the entry snapshot. A null/absent baseline is treated as a green
 * base — every current failure is net-new — so a missing snapshot fails toward
 * blocking (broken code), never toward a silent pass.
 */
export function netNewFloorFailures(
  current: CorrectnessFloorResult,
  baseline: FloorBaseline | null,
): CorrectnessCheckResult[] {
  // ONE comparator with the CI floor (attributeFloorFailures — T2.3).
  // `absentMeans: 'net-new'` is the loop's declared policy: the snapshot is
  // captured in the SAME environment, and skipped checks are deliberately
  // dropped from it, so a check absent from the snapshot that fails now was
  // enabled by the change — fail toward blocking. A cross-tree CI base run
  // declares 'unattributed' instead; the difference is an argument, never a
  // second comparator.
  const base = baseline === null ? null : baseline.checks;
  return attributeFloorFailures(current, base, { absentMeans: 'net-new' })
    .filter((a) => a.attribution === 'net-new')
    .map((a) =>
      // Finding-level narrowing: when the comparator identified WHICH findings
      // are new, the repair message must lead with them — the pre-existing
      // findings in the same check are grandfathered debt, not the block.
      a.netNewFindings
        ? {
            ...a.check,
            findings: a.netNewFindings,
            output:
              `net-new (this change): ${a.netNewFindings.join(', ')}\n` + (a.check.output ?? ''),
          }
        : a.check,
    );
}
