/**
 * Floor-failure ATTRIBUTION — the ONE comparator that decides whether a
 * failing correctness check is the change's fault (T2.3, Rule 2.30).
 *
 * Two surfaces diff a floor run against a "before" side and must agree:
 *
 *   - the loop Stop-gate, against its ENTRY SNAPSHOT (`src/loop/floor-state.ts`,
 *     captured on the pristine tree at activation, same environment);
 *   - the CI floor, against a MERGE-BASE worktree run (a different tree,
 *     same runner) — so an onboarding PR is not blocked by the repo's own
 *     pre-existing broken build, while a PR that bundles a breakage with the
 *     dxkit install still blocks (base green, PR red).
 *
 * Per current-side FAILURE, against the base side:
 *   - base `pass`     → `net-new`      — the change broke it. BLOCKS.
 *   - base `fail`     → `pre-existing` — grandfathered debt. Warns, named.
 *   - base `skipped`  → `unattributed` — dxkit could not OBSERVE the base
 *     side for this check (toolchain missing in the worktree, deps not
 *     provisioned). Blaming the developer would violate the Rule 19 law
 *     (rule out every other cause before attributing), so it warns with the
 *     reason disclosed, never blocks.
 *   - absent from base → `absentMeans`, declared by the caller, because the
 *     two base sides genuinely differ: the loop's snapshot deliberately DROPS
 *     skipped checks (same environment — a check that newly runs and fails
 *     was enabled by the change, so absent ⇒ `net-new`, failing toward
 *     blocking); a cross-tree CI base run keeps its skips, and a check absent
 *     there means the base run itself was incomplete ⇒ `unattributed`.
 *
 * An explicit option, not two functions — so the policy difference is a
 * declared argument at each call site instead of a semantic fork in a second
 * comparator (the divergence class the flow gate-vs-join bug shipped from).
 */
import type { CorrectnessCheckResult, CorrectnessFloorResult } from './run';

/** The durable identity of one floor check across runs. */
export function checkKey(pack: string, label: string): string {
  return `${pack}:${label}`;
}

/** One base-side check, statuses collapsed to what attribution needs. */
export interface FloorBaseCheck {
  readonly pack: string;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'skipped';
}

export type FloorAttribution = 'net-new' | 'pre-existing' | 'unattributed';

export interface AttributedFloorFailure {
  readonly check: CorrectnessCheckResult;
  readonly attribution: FloorAttribution;
}

/**
 * Attribute every current-side FAILURE against the base side. `base === null`
 * means no base side exists at all — every failure takes `absentMeans`
 * (loop: no snapshot → fail toward blocking; CI: base run crashed → cannot
 * attribute, disclosed).
 */
export function attributeFloorFailures(
  current: CorrectnessFloorResult,
  base: readonly FloorBaseCheck[] | null,
  opts: { readonly absentMeans: 'net-new' | 'unattributed' },
): AttributedFloorFailure[] {
  const byKey = new Map<string, FloorBaseCheck['status']>();
  for (const c of base ?? []) byKey.set(checkKey(c.pack, c.label), c.status);
  const out: AttributedFloorFailure[] = [];
  for (const check of current.checks) {
    if (check.status !== 'fail') continue;
    const baseStatus = byKey.get(checkKey(check.pack, check.label));
    const attribution: FloorAttribution =
      baseStatus === 'fail'
        ? 'pre-existing'
        : baseStatus === 'pass'
          ? 'net-new'
          : baseStatus === 'skipped'
            ? 'unattributed'
            : opts.absentMeans;
    out.push({ check, attribution });
  }
  return out;
}
