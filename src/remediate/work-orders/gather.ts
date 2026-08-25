/**
 * The ONE I/O adapter that assembles planner inputs from a repo (Rule 2.30:
 * one concept, one code path). Every surface that wants a work-order plan
 * for a repo (the plan CLI today; the executor in a later unit) calls
 * `gatherWorkOrderInputs` / `planRepoWorkOrders`, so no surface can forget a
 * source or join it differently.
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
 *     reads), joined by fingerprint to the LIVE dependency scan first (the
 *     producers of a deferral keep its finding OUT of the baseline) and to
 *     the baseline entry as a fallback. The live scan runs only when a
 *     deferred dep-vuln exists.
 *   - grandfathered debt: baseline entries NOT under any active allowlist
 *     entry (`partitionByActiveAllowlist`).
 *   - repo facts from the packs: the first pack-declared `provision`
 *     command (undefined when none, disclosed) and the dependency roots
 *     (the root plus `discoverNestedDepRoots` over the packs' lockfile
 *     patterns, matched against the pack-declared manifest patterns).
 *
 * Guardrail blocking pairs are NOT gathered here: they exist only inside a
 * verify step (post-agent). The executor unit passes them in from the verify
 * result it already holds.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../../analyzers/correctness/run';
import { attributeFloorFailures } from '../../analyzers/correctness/attribution';
import { detectActiveLanguages, allDependencyManifestPatterns } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
  type BaselineFile,
} from '../../baseline/baseline-file';
import { floorDebtToBaseChecks, type FloorDebt } from '../../baseline/floor-debt';
import { readFloorBaseline } from '../../loop/floor-state';
import { isSanitized } from '../../baseline/sanitize';
import type { RichBaselineEntry } from '../../baseline/types';
import { activeDeferredEntries, tryLoadAllowlist, type AllowlistFile } from '../../allowlist/file';
import { partitionByActiveAllowlist } from '../../baseline/allowlist-match';
import { discoverNestedDepRoots } from '../../analyzers/security/nested-dep-roots';
import { gatherDepVulnsWithAvailability } from '../../analyzers/security/gather';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import { budgetForTask, type RemediateConfig } from '../config';
import {
  planWorkOrders,
  type AdvisoryInput,
  type DeferredInput,
  type FloorFailureInput,
  type ManifestRoot,
  type PlannerInput,
} from './planner';
import { WORK_ORDER_CLASSES, isBuiltinWorkOrderClass, type WorkOrderPlan } from './types';
import type { RemediateTaskId } from '../tasks';

export type FloorSource = 'live' | 'baseline-envelope' | 'loop-snapshot' | 'none';

export interface GatherWorkOrderOptions {
  /** Run the live floor (default: read a stored envelope). */
  readonly withFloor?: boolean;
  /** Per-command timeout for the live floor. */
  readonly timeoutMs?: number;
  /** Injected floor run (tests); implies `withFloor`. */
  readonly runFloor?: (cwd: string) => CorrectnessFloorResult;
  /** Injected live dependency scan (tests). */
  readonly scanDepVulns?: (cwd: string) => Promise<readonly DepVulnFinding[] | null>;
  /** The clock for deferral expiry (injectable for tests). */
  readonly now?: Date;
  readonly baselineName?: string;
  /** Injected active packs (tests). */
  readonly packs?: readonly LanguageSupport[];
}

export interface GatheredWorkOrderInputs {
  readonly input: PlannerInput;
  readonly floorSource: FloorSource;
}

function readBaseline(cwd: string, name: string): BaselineFile | null {
  try {
    const p = pathForBaseline(cwd, name);
    return fs.existsSync(p) ? readBaselineFile(p) : null;
  } catch {
    return null; // unreadable baseline: the plan proceeds without it, disclosed by emptiness
  }
}

/** The first pack-declared provision command, or undefined (disclosed). */
export function installCommandFor(
  cwd: string,
  packs: readonly LanguageSupport[],
): { bin: string; args: readonly string[] } | undefined {
  for (const pack of packs) {
    const cmd = pack.provision?.(cwd);
    if (cmd) return cmd;
  }
  return undefined;
}

/** Dependency roots: the repo root plus every nested lockfile root the ONE
 *  discovery primitive finds, each listing the pack-declared manifest files
 *  present in it. */
export function manifestRoots(cwd: string, packs: readonly LanguageSupport[]): ManifestRoot[] {
  const patterns = allDependencyManifestPatterns(packs);
  const lockfiles = [
    ...new Set(packs.flatMap((p) => p.capabilities?.depVulns?.lockfilePatterns ?? [])),
  ];
  const dirs = [
    '',
    ...discoverNestedDepRoots(cwd, lockfiles).roots.map((r) => r.replace(/\\/g, '/')),
  ];
  return dirs.map((dir) => ({
    dir,
    files: patterns.filter((f) => fs.existsSync(path.join(cwd, dir, f))).sort(),
  }));
}

/** Stored floor envelope -> failing checks, attributed pre-existing. */
function storedFloorFailures(debt: FloorDebt): FloorFailureInput[] {
  return debt.checks
    .filter((c) => c.status === 'fail')
    .map((c) => ({
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
  return attributeFloorFailures(floor, base, { absentMeans: 'unattributed' })
    .filter((a) => a.check.status === 'fail')
    .map((a) => ({
      pack: a.check.pack,
      label: a.check.label,
      command: [a.check.bin, ...(a.check.args ?? [])].filter(Boolean).join(' ').trim(),
      ...(a.check.output !== undefined ? { output: a.check.output } : {}),
      attribution: a.attribution,
      ...(a.precision !== undefined ? { precision: a.precision } : {}),
      ...(a.netNewFindings !== undefined ? { netNewFindings: a.netNewFindings } : {}),
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
      failures: snapshot.checks
        .filter((c) => c.status === 'fail')
        .map((c) => ({
          pack: c.pack,
          label: c.label,
          command: '',
          attribution: 'pre-existing' as const,
        })),
      source: 'loop-snapshot',
    };
  }
  return { failures: [], source: 'none' };
}

function advisoryFromLive(f: DepVulnFinding): AdvisoryInput {
  return {
    id: f.fingerprint!,
    package: f.package,
    ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    advisoryId: f.id,
    ...(f.severity !== undefined ? { severity: f.severity } : {}),
    ...(f.fixedVersion !== undefined ? { fixedVersion: f.fixedVersion } : {}),
    ...(f.reachable !== undefined ? { reachable: f.reachable } : {}),
  };
}

function advisoryFromEntry(e: Extract<RichBaselineEntry, { kind: 'dep-vuln' }>): AdvisoryInput {
  return {
    id: e.id,
    package: e.package,
    ...(e.installedVersion !== undefined ? { installedVersion: e.installedVersion } : {}),
    advisoryId: e.advisoryId,
    ...(e.severity !== undefined ? { severity: e.severity } : {}),
  };
}

async function joinDeferrals(
  cwd: string,
  allowlist: AllowlistFile | null,
  byId: ReadonlyMap<string, RichBaselineEntry>,
  opts: GatherWorkOrderOptions,
): Promise<DeferredInput[]> {
  const now = opts.now ?? new Date();
  const deferred = activeDeferredEntries(allowlist, now);
  const needsScan = deferred.some((d) => d.kind === 'dep-vuln');
  const live = new Map<string, DepVulnFinding>();
  if (needsScan) {
    const scan =
      opts.scanDepVulns ??
      (async (dir: string) =>
        (await gatherDepVulnsWithAvailability(dir)).envelope?.findings ?? null);
    for (const f of (await scan(cwd)) ?? []) if (f.fingerprint) live.set(f.fingerprint, f);
  }
  return deferred.map((d): DeferredInput => {
    const base = { fingerprint: d.fingerprint, expiresAt: d.expiresAt! };
    const liveHit = live.get(d.fingerprint);
    if (liveHit) return { ...base, kind: 'dep-vuln', advisory: advisoryFromLive(liveHit) };
    const entry = byId.get(d.fingerprint);
    if (!entry) return { ...base, kind: 'unjoined', declaredKind: d.kind };
    if (entry.kind === 'dep-vuln')
      return { ...base, kind: 'dep-vuln', advisory: advisoryFromEntry(entry) };
    if (entry.kind === 'custom-check') return { ...base, kind: 'custom-check', entry };
    return { ...base, kind: 'other', entry };
  });
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
  const packs = opts.packs ?? detectActiveLanguages(cwd);
  const baseline = readBaseline(cwd, opts.baselineName ?? DEFAULT_BASELINE_NAME);
  const floor = gatherFloor(cwd, baseline, packs, opts);

  const rich = (baseline?.findings ?? []).filter((e): e is RichBaselineEntry => !isSanitized(e));
  const byId = new Map(rich.map((e) => [e.id, e]));
  const allowlist = tryLoadAllowlist(cwd);
  const now = opts.now ?? new Date();
  const deferred = await joinDeferrals(cwd, allowlist, byId, opts);
  const debt = partitionByActiveAllowlist(rich, allowlist, now).live.filter(
    (e) => e.kind === 'custom-check',
  );
  const install = installCommandFor(cwd, packs);

  return {
    floorSource: floor.source,
    input: {
      floorFailures: floor.failures,
      blocking: [],
      deferred,
      debt,
      manifests: manifestRoots(cwd, packs),
      ...(install ? { install } : {}),
      policy: { maxSliceSize: config.workOrders.maxSliceSize, budgetFor: budgetResolver(config) },
    },
  };
}

/** Gather + plan in one call: the surface entry point. */
export async function planRepoWorkOrders(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): Promise<{ plan: WorkOrderPlan; floorSource: FloorSource }> {
  const gathered = await gatherWorkOrderInputs(cwd, config, opts);
  return { plan: planWorkOrders(gathered.input), floorSource: gathered.floorSource };
}
