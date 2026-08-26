/**
 * The ONE I/O adapter that assembles planner inputs from a repo (Rule 2.30:
 * one concept, one code path). Every surface that wants a work-order plan
 * for a repo (the plan CLI today; the executor in a later unit) calls
 * `gatherWorkOrderInputs` / `planRepoWorkOrders`, so no surface can forget a
 * source or join it differently. Every degraded read is DISCLOSED
 * (`disclosures`): a corrupt baseline, capped dependency roots, which scan
 * source answered the deferral join. The GateFailure discipline: fail open,
 * always say why.
 *
 * Sources, each through its canonical entry point:
 *   - the entry floor, CHEAP by default: the baseline's recorded floor-debt
 *     envelope, else the loop's floor snapshot; the live floor only behind
 *     `withFloor` (bounded by `timeoutMs`). Which source was used is
 *     disclosed (`floorSource`). A live floor is attributed against the
 *     envelope through the one comparator (`attributeFloorFailures` over
 *     `floorDebtToBaseChecks`); a stored source is by definition
 *     pre-existing.
 *   - active deferrals (`activeDeferredEntries`, the same selector `debt`
 *     reads), joined by fingerprint to a dependency scan (the deferral
 *     producers keep the finding OUT of the baseline), with the baseline
 *     entry as a fallback. The scan prefers a fresh persisted BoM artifact
 *     (`.dxkit/bom.json`) and pays a live audit only when none exists; it
 *     runs at all only when a dep-vuln deferral exists.
 *   - grandfathered debt: ALL baseline entries not under any active
 *     allowlist entry (`partitionByActiveAllowlist`); the planner
 *     classifies kinds and discloses the classless ones.
 *   - repo facts from the packs: per-pack `provision` commands (an order
 *     resolves its own ecosystem's; none = disclosed) and the dependency
 *     roots (the ONE per-pack derivation `discoverPackDepRoots`, shared
 *     with the audit, dropped roots disclosed), with the manifest files
 *     matched through the canonical glob-aware `matchesManifestPattern`.
 *
 * Guardrail blocking pairs are NOT gathered here: they exist only inside a
 * verify step (post-agent). The executor unit passes them in from the verify
 * result it already holds.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../../analyzers/correctness/run';
import { attributeFloorFailures } from '../../analyzers/correctness/attribution';
import {
  allDependencyManifestPatterns,
  detectActiveLanguages,
  matchesManifestPattern,
} from '../../languages';
import { LOCKFILE_SYNC_LABEL } from '../../languages/capabilities/correctness';
import type { LanguageSupport } from '../../languages/types';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
  type BaselineFile,
} from '../../baseline/baseline-file';
import { failingFloorDebt, floorDebtToBaseChecks, type FloorDebt } from '../../baseline/floor-debt';
import { readFloorBaseline } from '../../loop/floor-state';
import { isSanitized } from '../../baseline/sanitize';
import type { RichBaselineEntry } from '../../baseline/types';
import { tryLoadAllowlist } from '../../allowlist/file';
import { partitionByActiveAllowlist } from '../../baseline/allowlist-match';
import { discoverPackDepRoots } from '../../analyzers/security/nested-dep-roots';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import { budgetForTask, type RemediateConfig } from '../config';
import {
  planWorkOrders,
  type FloorFailureInput,
  type ManifestRoot,
  type PlannerInput,
} from './planner';
import type { InstallFor } from './shared';
import { WORK_ORDER_CLASSES, isBuiltinWorkOrderClass, type WorkOrderPlan } from './types';
import type { RemediateTaskId } from '../tasks';
import {
  orderHistory,
  orderLedgerPath,
  type OrderBranchSource,
  type OrderLedgerExec,
  type OrderOutcomeRow,
} from '../../lanes/order-ledger';
import { remediateBranchFor } from '../../lanes/branches';
import {
  applyClassPauses,
  evaluateClassPauses,
  remediateStamp,
  type ClassPause,
  type RemediateStamp,
} from './breaker';

export type FloorSource = 'live' | 'baseline-envelope' | 'loop-snapshot' | 'none';

// The deferral join (deferred allowlist entries joined to a dependency
// scan) lives in `./deferrals` (module-size split); its public shapes are
// re-exported here so consumers keep one import surface.
export { BOM_FRESHNESS_DAYS, type DepScanSource } from './deferrals';
import { joinDeferrals, type DepScanSource } from './deferrals';
import { advisoryDetailMap } from './fix-versions';
import type { OsvFetcher } from '../../analyzers/tools/osv';

export interface GatherWorkOrderOptions {
  /** Run the live floor (default: read a stored envelope). */
  readonly withFloor?: boolean;
  /** Per-command timeout for the live floor. */
  readonly timeoutMs?: number;
  /** Injected floor run (tests); implies `withFloor`. */
  readonly runFloor?: (cwd: string) => CorrectnessFloorResult;
  /** Injected dependency scan (tests / the executor's already-run scan). */
  readonly scanDepVulns?: (cwd: string) => Promise<readonly DepVulnFinding[] | null>;
  /** The clock for deferral expiry + artifact freshness (injectable). */
  readonly now?: Date;
  readonly baselineName?: string;
  /** Injected active packs (tests). */
  readonly packs?: readonly LanguageSupport[];
  /** Injected OSV fetch for the advisory fix-version join (tests). */
  readonly osvFetcher?: OsvFetcher;
  /** Injected order-outcome history rows for the circuit breaker (tests /
   *  a caller that already read them). Default: the ONE ledger reader over
   *  the local checkout plus the standing branches. */
  readonly history?: readonly OrderOutcomeRow[];
  /** Injected exec for the default history read's branch fetches (tests). */
  readonly historyExec?: OrderLedgerExec;
  /** Injected environment stamps for the breaker's unpause comparison
   *  (tests). Default: `remediateStamp(cwd)`. */
  readonly stamp?: RemediateStamp;
  /** A task a human explicitly dispatched: its classes bypass any pause,
   *  disclosed (never silent). */
  readonly dispatchedTask?: string;
}

export interface GatheredWorkOrderInputs {
  readonly input: PlannerInput;
  readonly floorSource: FloorSource;
  readonly depScanSource: DepScanSource;
  /** Degraded reads, phrased for humans; empty when nothing degraded. */
  readonly disclosures: readonly string[];
  /** STRUCTURAL evidence degradation (an unreadable baseline, no floor
   *  evidence at all): a zero-order plan built on this cannot claim
   *  "nothing to do" — the scheduled matrix falls back to the static task
   *  list instead of silently spawning nothing. Null = evidence healthy. */
  readonly evidenceDegraded: string | null;
}

function readBaseline(
  cwd: string,
  name: string,
  disclosures: string[],
): { baseline: BaselineFile | null; unreadable: boolean } {
  const p = pathForBaseline(cwd, name);
  try {
    return { baseline: fs.existsSync(p) ? readBaselineFile(p) : null, unreadable: false };
  } catch (err) {
    disclosures.push(
      `baseline '${name}' exists but could not be read (${err instanceof Error ? err.message : String(err)}); ` +
        'the plan proceeds WITHOUT the recorded backlog: floor attribution and debt are incomplete',
    );
    return { baseline: null, unreadable: true };
  }
}

/** Per producing pack, its declared install command. A finding that does not
 *  name its pack falls back to the single unambiguous declared command when
 *  exactly one active pack declares any. */
export function installResolver(cwd: string, packs: readonly LanguageSupport[]): InstallFor {
  const byPack = new Map<string, { bin: string; args: readonly string[] }>();
  for (const pack of packs) {
    const cmd = pack.provision?.(cwd);
    // The order carries the PRIMARY only: the pack's fallback (`a || b`) is
    // the verification's disclosed retry, not a second command an agent may
    // reach for.
    if (cmd) byPack.set(pack.id, { bin: cmd.bin, args: cmd.args });
  }
  const single = byPack.size === 1 ? [...byPack.values()][0] : undefined;
  return (pack) => (pack !== undefined ? byPack.get(pack) : single);
}

/** Dependency roots: the repo root plus every nested root the ONE per-pack
 *  discovery (`discoverPackDepRoots`, shared with the audit) finds; each
 *  root lists the files the pack-declared manifest patterns match, through
 *  the canonical glob-aware matcher. Dropped (capped) roots are disclosed. */
export function manifestRoots(
  cwd: string,
  packs: readonly LanguageSupport[],
  disclosures: string[],
): ManifestRoot[] {
  // The ONE manifest + lockfile union (manifests AND root-marker lockfiles
  // such as bun.lock), so an envelope never excludes a file the fix edits.
  const patterns = allDependencyManifestPatterns(packs);
  const dirs = new Set<string>(['']);
  for (const pack of packs) {
    const discovery = discoverPackDepRoots(cwd, pack);
    for (const r of discovery.roots) dirs.add(r);
    if (discovery.dropped.length > 0) {
      disclosures.push(
        `dependency-root discovery (${pack.id}) capped: not auditing ${discovery.dropped.join(', ')}`,
      );
    }
  }
  return [...dirs].sort().map((dir) => {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(path.join(cwd, dir), { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
        .filter((name) => patterns.some((p) => matchesManifestPattern(name, p)))
        .sort();
    } catch {
      /* unreadable root: empty file list, the envelope falls back to others */
    }
    return { dir, files };
  });
}

/** Stored floor envelope -> failing checks, attributed pre-existing. */
function storedFloorFailures(debt: FloorDebt): FloorFailureInput[] {
  return failingFloorDebt(debt).map((c) => ({
    pack: c.pack,
    label: c.label,
    command: c.command,
    ...(c.output !== undefined ? { output: c.output } : {}),
    attribution: 'pre-existing' as const,
  }));
}

function liveFloorFailures(
  floor: CorrectnessFloorResult,
  baseline: BaselineFile | null,
): FloorFailureInput[] {
  const base = baseline?.floorDebt ? floorDebtToBaseChecks(baseline.floorDebt) : null;
  // attributeFloorFailures returns only the FAILING checks.
  return attributeFloorFailures(floor, base, { absentMeans: 'unattributed' }).map((a) => ({
    pack: a.check.pack,
    label: a.check.label,
    command: [a.check.bin, ...(a.check.args ?? [])].filter(Boolean).join(' ').trim(),
    ...(a.check.output !== undefined ? { output: a.check.output } : {}),
    attribution: a.attribution,
    ...(a.precision !== undefined ? { precision: a.precision } : {}),
    ...(a.netNewFindings !== undefined ? { netNewFindings: a.netNewFindings } : {}),
    ...(a.check.findings !== undefined ? { findings: a.check.findings } : {}),
    ...(a.check.unresolved !== undefined ? { unresolved: a.check.unresolved } : {}),
  }));
}

function gatherFloor(
  cwd: string,
  baseline: BaselineFile | null,
  packs: readonly LanguageSupport[],
  opts: GatherWorkOrderOptions,
): { failures: FloorFailureInput[]; source: FloorSource } {
  if (opts.withFloor || opts.runFloor) {
    const run =
      opts.runFloor ??
      ((dir: string) =>
        runCorrectnessFloor({
          cwd: dir,
          changedFiles: [],
          scope: 'full',
          packs,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        }));
    return { failures: liveFloorFailures(run(cwd), baseline), source: 'live' };
  }
  if (baseline?.floorDebt) {
    return { failures: storedFloorFailures(baseline.floorDebt), source: 'baseline-envelope' };
  }
  const snapshot = readFloorBaseline(cwd);
  if (snapshot) {
    return {
      failures: failingFloorDebt(snapshot).map((c) => ({
        pack: c.pack,
        label: c.label,
        command: '',
        attribution: 'pre-existing' as const,
        ...(c.findings !== undefined ? { findings: c.findings } : {}),
      })),
      source: 'loop-snapshot',
    };
  }
  return { failures: [], source: 'none' };
}

/** Per class, the selecting task's effective budget (one budget per concept). */
function budgetResolver(config: RemediateConfig): PlannerInput['policy']['budgetFor'] {
  return (cls) => {
    const task = isBuiltinWorkOrderClass(cls) ? WORK_ORDER_CLASSES[cls].task : undefined;
    return task ? budgetForTask(config, task as RemediateTaskId) : config.agent.budget;
  };
}

export async function gatherWorkOrderInputs(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): Promise<GatheredWorkOrderInputs> {
  const disclosures: string[] = [];
  const packs = opts.packs ?? detectActiveLanguages(cwd);
  const { baseline, unreadable } = readBaseline(
    cwd,
    opts.baselineName ?? DEFAULT_BASELINE_NAME,
    disclosures,
  );
  const floor = gatherFloor(cwd, baseline, packs, opts);
  // Evidence health for the scheduled matrix (never for the plan itself:
  // partial orders are still shown). A stored-floor default with no floor
  // evidence anywhere ('none'), or a baseline that exists but cannot be
  // read, means a zero-order plan proves nothing.
  const evidenceDegraded = unreadable
    ? 'the baseline exists but could not be read'
    : floor.source === 'none'
      ? 'no floor evidence is available (no baseline floor envelope, no loop snapshot; pass --with-floor to measure live)'
      : null;

  const rich = (baseline?.findings ?? []).filter((e): e is RichBaselineEntry => !isSanitized(e));
  const byId = new Map(rich.map((e) => [e.id, e]));
  const allowlist = tryLoadAllowlist(cwd);
  const now = opts.now ?? new Date();
  const { deferred, depScanSource, scanned } = await joinDeferrals(
    cwd,
    allowlist,
    byId,
    opts,
    disclosures,
  );
  const debt = partitionByActiveAllowlist(rich, allowlist, now).live;
  // The advisory-detail join (fix-versions.ts): thread the paid scan's
  // fixed versions into baseline debt, and resolve the still-missing ones
  // through the ONE OSV client; an advisory without a knowable fix
  // honestly stays agent-tier, disclosed.
  const advisoryDetails = await advisoryDetailMap({
    deferred,
    debt,
    scanned,
    ...(opts.osvFetcher ? { osvFetcher: opts.osvFetcher } : {}),
    disclosures,
  });

  // Manifest roots are consulted only by dependency-shaped orders; skip the
  // walk entirely when nothing will read them.
  const needsManifests =
    deferred.some((d) => d.kind === 'dep-vuln') ||
    debt.some((e) => e.kind === 'dep-vuln') ||
    floor.failures.some((f) => (f.unresolved?.length ?? 0) > 0 || f.label === LOCKFILE_SYNC_LABEL);
  const manifests: ManifestRoot[] = needsManifests
    ? manifestRoots(cwd, packs, disclosures)
    : [{ dir: '', files: [] }];

  return {
    floorSource: floor.source,
    depScanSource,
    disclosures,
    evidenceDegraded,
    input: {
      floorFailures: floor.failures,
      blocking: [],
      deferred,
      advisoryDetails,
      debt,
      manifests,
      installFor: installResolver(cwd, packs),
      policy: { maxSliceSize: config.workOrders.maxSliceSize, budgetFor: budgetResolver(config) },
    },
  };
}

/** The standing branches where unmerged order-outcome rows can live: one
 *  per task that owns a work-order class (derived from the ONE class spine,
 *  never a hand-kept list — a new class's task is covered automatically). */
export function orderHistoryBranchSources(): OrderBranchSource[] {
  const tasks = [...new Set(Object.values(WORK_ORDER_CLASSES).map((c) => c.task))].sort();
  return tasks.map((task) => ({
    branch: remediateBranchFor(task),
    file: orderLedgerPath('remediate', task),
  }));
}

/** Gather + plan in one call: the surface entry point. Applies the circuit
 *  breaker here (Rule 2.30: the plan CLI and the recipe phase both call
 *  this, so neither can see a different pause set). */
export async function planRepoWorkOrders(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): Promise<{
  plan: WorkOrderPlan;
  floorSource: FloorSource;
  depScanSource: DepScanSource;
  disclosures: readonly string[];
  /** Structural evidence degradation (see `GatheredWorkOrderInputs`). */
  evidenceDegraded: string | null;
  /** Classes the circuit breaker paused (orders carry the per-order mark). */
  pauses: readonly ClassPause[];
}> {
  const gathered = await gatherWorkOrderInputs(cwd, config, opts);
  const disclosures = [...gathered.disclosures];
  let plan = planWorkOrders(gathered.input);

  // The circuit breaker (section 3F): evaluated only when the plan has
  // orders and the knob is armed — a zero-order plan never pays the
  // history read.
  let pauses: readonly ClassPause[] = [];
  if (plan.orders.length > 0 && config.pauseAfterFailures > 0) {
    let rows = opts.history;
    if (rows === undefined) {
      const history = orderHistory(cwd, {
        branches: orderHistoryBranchSources(),
        ...(opts.historyExec ? { exec: opts.historyExec } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      rows = history.rows;
      disclosures.push(...history.disclosures);
    }
    const evaluated = evaluateClassPauses(rows, {
      threshold: config.pauseAfterFailures,
      current: opts.stamp ?? remediateStamp(cwd),
      ...(opts.dispatchedTask ? { dispatchedTask: opts.dispatchedTask } : {}),
    });
    disclosures.push(...evaluated.disclosures);
    plan = applyClassPauses(plan, evaluated.pauses);
    pauses = [...evaluated.pauses.values()];
  }

  return {
    plan,
    floorSource: gathered.floorSource,
    depScanSource: gathered.depScanSource,
    disclosures,
    evidenceDegraded: gathered.evidenceDegraded,
    pauses,
  };
}
