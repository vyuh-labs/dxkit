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
 *   - base `no-tests` → `net-new`      — the base ran its test command and
 *     it found ZERO tests (bases always run at full scope), so every failing
 *     test now arrived with the change. BLOCKS. (4.5.0)
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
import type { CorrectnessCheckResult, CorrectnessFloorResult, CorrectnessStatus } from './run';

/** The durable identity of one floor check across runs. */
export function checkKey(pack: string, label: string): string {
  return `${pack}:${label}`;
}

/** One base-side check, statuses collapsed to what attribution needs. */
export interface FloorBaseCheck {
  readonly pack: string;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'no-tests' | 'skipped';
  /** Finding-level identities recorded for a failing base check (today: the
   *  import-resolution check's unresolved specifiers). Lets the comparator
   *  diff the SET below instead of grandfathering the whole check. */
  readonly findings?: readonly string[];
}

/**
 * The ONE projection of a floor check (a live run's, or a stored envelope's)
 * onto the comparator's base shape. Every base side routes through it: the
 * loop snapshot, the CI merge-base run, the tree gate's baseline tree, the
 * lanes' entry floor and the committed floor-debt envelope. Four hand-rolled
 * copies of this ternary once lived in four files; a status added to the
 * runner (4.5.0 `no-tests`) would have been collapsed to `skipped` by each,
 * reading "the base had zero tests" as "the base was not observed".
 */
export function floorBaseStatus(status: CorrectnessStatus | string): FloorBaseCheck['status'] {
  return status === 'pass' || status === 'fail' || status === 'no-tests' ? status : 'skipped';
}

/** A floor check → the comparator's base-check shape (see `floorBaseStatus`). */
export function toFloorBaseCheck(c: {
  readonly pack: string;
  readonly label: string;
  readonly status: CorrectnessStatus | string;
  readonly findings?: readonly string[];
}): FloorBaseCheck {
  return {
    pack: c.pack,
    label: c.label,
    status: floorBaseStatus(c.status),
    ...(c.findings !== undefined ? { findings: c.findings } : {}),
  };
}

export type FloorAttribution = 'net-new' | 'pre-existing' | 'unattributed';

export interface AttributedFloorFailure {
  readonly check: CorrectnessCheckResult;
  readonly attribution: FloorAttribution;
  /** Present when the comparator worked at FINDING level (both sides carried
   *  findings for this check): the current findings absent from the base —
   *  i.e. exactly what the change introduced. `net-new` with this field means
   *  "these specific findings are new"; the check's other findings are
   *  pre-existing debt. */
  readonly netNewFindings?: readonly string[];
  /** Set on a FAIL-vs-FAIL comparison (4.2): 'finding' — both sides carried
   *  failure identities and the set was diffed; 'check' — at least one side
   *  did not, so additional failures piled onto the already-red check are NOT
   *  distinguishable from the pre-existing one. The check-level lane must be
   *  DISCLOSED by renderers (Rule 19: grandfathering by inability to observe
   *  is stated, never silent). Absent on the other lattice outcomes, where
   *  the question does not arise. */
  readonly precision?: 'finding' | 'check';
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
  const byKey = new Map<string, FloorBaseCheck>();
  for (const c of base ?? []) byKey.set(checkKey(c.pack, c.label), c);
  const out: AttributedFloorFailure[] = [];
  for (const check of current.checks) {
    if (check.status !== 'fail') continue;
    const baseCheck = byKey.get(checkKey(check.pack, check.label));
    const baseStatus = baseCheck?.status;
    // FINDING-level path: when BOTH sides recorded finding identities for a
    // failing check, the unit of attribution is the finding, not the check —
    // otherwise a repo whose base was already red in this check grandfathers
    // every future break of the same kind (the class the import-resolution
    // check exists to catch would sail through on any repo with pre-existing
    // unresolved-import debt). A base that recorded NO findings for its
    // failure stays check-level — never fabricate precision the snapshot
    // does not have (Rule 19).
    if (baseStatus === 'fail' && check.findings && baseCheck?.findings) {
      const known = new Set(baseCheck.findings);
      const netNewFindings = check.findings.filter((f) => !known.has(f));
      out.push(
        netNewFindings.length > 0
          ? { check, attribution: 'net-new', netNewFindings, precision: 'finding' }
          : { check, attribution: 'pre-existing', precision: 'finding' },
      );
      continue;
    }
    const attribution: FloorAttribution =
      baseStatus === 'fail'
        ? 'pre-existing'
        : baseStatus === 'pass' || baseStatus === 'no-tests'
          ? 'net-new'
          : baseStatus === 'skipped'
            ? 'unattributed'
            : opts.absentMeans;
    out.push({
      check,
      attribution,
      // FAIL-vs-FAIL without failure identities on both sides: the comparator
      // cannot see a NEW failure piled onto the already-red check — disclosed
      // check-level precision, never a silent grandfather (Rule 19).
      ...(baseStatus === 'fail' ? { precision: 'check' as const } : {}),
    });
  }
  return out;
}

/**
 * What a current-side `no-tests` check means against the base side (4.5.0).
 * The sibling question to failure attribution, same keying, same base shape:
 *
 *   - `tests-vanished`   — tests RAN at the base (pass or fail) and the
 *     current FULL-scope run executed none: the change removed the suite or
 *     broke its discovery. Disclosed loudly, never read as a pass and never
 *     as a fix of a red base (deleting failing tests is not repairing them).
 *     It does not block by itself: an empty suite is not a failure the
 *     change introduced.
 *   - `none-at-base`     — the base found zero tests too. Still disclosed as
 *     "no tests ran"; nothing changed.
 *   - `base-unobserved`  — the base side skipped the check or lacks it.
 *
 * Only a FULL-scope current run can claim `tests-vanished`: an affected run
 * that selected zero tests for a change says "no tests ran for this change",
 * which a full-scope base that ran the whole suite cannot contradict. Bases
 * always run at full scope (loop snapshot, CI merge-base, entry floors,
 * floor-debt capture).
 */
export type NoTestsTransition = 'tests-vanished' | 'none-at-base' | 'base-unobserved';

export interface AttributedNoTests {
  readonly check: CorrectnessCheckResult;
  readonly transition: NoTestsTransition;
  /** The base status behind `tests-vanished` (`pass` or `fail`). */
  readonly baseStatus?: 'pass' | 'fail';
}

export function attributeNoTests(
  current: CorrectnessFloorResult,
  base: readonly FloorBaseCheck[] | null,
): AttributedNoTests[] {
  const byKey = new Map<string, FloorBaseCheck>();
  for (const c of base ?? []) byKey.set(checkKey(c.pack, c.label), c);
  const out: AttributedNoTests[] = [];
  for (const check of current.checks) {
    if (check.status !== 'no-tests') continue;
    const baseStatus = byKey.get(checkKey(check.pack, check.label))?.status;
    if (baseStatus === 'no-tests') {
      out.push({ check, transition: 'none-at-base' });
    } else if ((baseStatus === 'pass' || baseStatus === 'fail') && current.scope !== 'affected') {
      out.push({ check, transition: 'tests-vanished', baseStatus });
    } else {
      out.push({ check, transition: 'base-unobserved' });
    }
  }
  return out;
}

/** The ONE phrasing of a vanished suite, for every surface that names it. */
export function describeTestsVanished(a: AttributedNoTests): string {
  return (
    `${a.check.pack} ${a.check.label}: tests ran at the base (${a.baseStatus ?? 'pass'}) and NONE ran ` +
    `now — this change removed the tests or broke their discovery (not a pass` +
    (a.baseStatus === 'fail' ? ', and not a fix of the failing tests' : '') +
    ')'
  );
}
