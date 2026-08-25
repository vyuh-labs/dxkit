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
import { detectActiveLanguages, matchesManifestPattern } from '../../languages';
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
import { activeDeferredEntries, tryLoadAllowlist, type AllowlistFile } from '../../allowlist/file';
import { partitionByActiveAllowlist } from '../../baseline/allowlist-match';
import { discoverPackDepRoots } from '../../analyzers/security/nested-dep-roots';
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
import type { InstallFor } from './shared';
import { WORK_ORDER_CLASSES, isBuiltinWorkOrderClass, type WorkOrderPlan } from './types';
import type { RemediateTaskId } from '../tasks';

export type FloorSource = 'live' | 'baseline-envelope' | 'loop-snapshot' | 'none';

/** Which source answered the deferral join. */
export type DepScanSource = 'bom-artifact' | 'live-scan' | 'injected' | 'not-needed';

/** How long a persisted BoM artifact counts as fresh for the deferral join.
 *  Deferral windows are days; a week-old fixed-version fact is still the
 *  right starting point, and the disclosure names the age either way. */
export const BOM_FRESHNESS_DAYS = 7;

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
}

export interface GatheredWorkOrderInputs {
  readonly input: PlannerInput;
  readonly floorSource: FloorSource;
  readonly depScanSource: DepScanSource;
  /** Degraded reads, phrased for humans; empty when nothing degraded. */
  readonly disclosures: readonly string[];
}

function readBaseline(cwd: string, name: string, disclosures: string[]): BaselineFile | null {
  const p = pathForBaseline(cwd, name);
  try {
    return fs.existsSync(p) ? readBaselineFile(p) : null;
  } catch (err) {
    disclosures.push(
      `baseline '${name}' exists but could not be read (${err instanceof Error ? err.message : String(err)}); ` +
        'the plan proceeds WITHOUT the recorded backlog: floor attribution and debt are incomplete',
    );
    return null;
  }
}

/** Per producing pack, its declared install command. A finding that does not
 *  name its pack falls back to the single unambiguous declared command when
 *  exactly one active pack declares any. */
export function installResolver(cwd: string, packs: readonly LanguageSupport[]): InstallFor {
  const byPack = new Map<string, { bin: string; args: readonly string[] }>();
  for (const pack of packs) {
    const cmd = pack.provision?.(cwd);
    if (cmd) byPack.set(pack.id, cmd);
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
  const patterns = [
    ...new Set(packs.flatMap((p) => p.capabilities?.depVulns?.manifestPatterns ?? [])),
  ];
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

function advisoryFromLive(f: DepVulnFinding): AdvisoryInput {
  return {
    id: f.fingerprint!,
    package: f.package,
    ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    advisoryId: f.id,
    ...(f.severity !== undefined ? { severity: f.severity } : {}),
    ...(f.fixedVersion !== undefined ? { fixedVersion: f.fixedVersion } : {}),
    ...(f.reachable !== undefined ? { reachable: f.reachable } : {}),
    ...(f.packId !== undefined ? { pack: f.packId } : {}),
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

/** A fresh persisted BoM artifact's findings, when one exists (the scan the
 *  repo already paid for), else null. Defensive: any shape surprise reads as
 *  absent, never a crash. */
function bomArtifactFindings(
  cwd: string,
  now: Date,
): { findings: DepVulnFinding[]; ageDays: number } | null {
  try {
    const p = path.join(cwd, '.dxkit', 'bom.json');
    if (!fs.existsSync(p)) return null;
    const bom = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      analyzedAt?: string;
      entries?: ReadonlyArray<{ vulns?: DepVulnFinding[] }>;
    };
    if (typeof bom.analyzedAt !== 'string' || !Array.isArray(bom.entries)) return null;
    const ageDays = (now.getTime() - Date.parse(bom.analyzedAt)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > BOM_FRESHNESS_DAYS) return null;
    const findings = bom.entries.flatMap((e) => e.vulns ?? []).filter((v) => v && v.fingerprint);
    return { findings, ageDays };
  } catch {
    return null;
  }
}

async function joinDeferrals(
  cwd: string,
  allowlist: AllowlistFile | null,
  byId: ReadonlyMap<string, RichBaselineEntry>,
  opts: GatherWorkOrderOptions,
  disclosures: string[],
): Promise<{ deferred: DeferredInput[]; depScanSource: DepScanSource }> {
  const now = opts.now ?? new Date();
  const deferred = activeDeferredEntries(allowlist, now);
  const needsScan = deferred.some((d) => d.kind === 'dep-vuln');
  const scanned = new Map<string, DepVulnFinding>();
  let depScanSource: DepScanSource = 'not-needed';
  if (needsScan) {
    if (opts.scanDepVulns) {
      depScanSource = 'injected';
      for (const f of (await opts.scanDepVulns(cwd)) ?? []) {
        if (f.fingerprint) scanned.set(f.fingerprint, f);
      }
    } else {
      const bom = bomArtifactFindings(cwd, now);
      if (bom) {
        depScanSource = 'bom-artifact';
        disclosures.push(
          `deferral join read the persisted BoM artifact (.dxkit/bom.json, ` +
            `${bom.ageDays.toFixed(1)} day(s) old) instead of paying a live dependency audit`,
        );
        for (const f of bom.findings) scanned.set(f.fingerprint!, f);
      } else {
        depScanSource = 'live-scan';
        disclosures.push(
          'deferral join ran a live dependency audit (no fresh .dxkit/bom.json artifact to read)',
        );
        const result = await gatherDepVulnsWithAvailability(cwd);
        for (const f of result.envelope?.findings ?? []) {
          if (f.fingerprint) scanned.set(f.fingerprint, f);
        }
      }
    }
  }
  const joined = deferred.map((d): DeferredInput => {
    const base = { fingerprint: d.fingerprint, expiresAt: d.expiresAt! };
    const hit = scanned.get(d.fingerprint);
    if (hit) return { ...base, kind: 'dep-vuln', advisory: advisoryFromLive(hit) };
    const entry = byId.get(d.fingerprint);
    if (!entry) return { ...base, kind: 'unjoined', declaredKind: d.kind };
    if (entry.kind === 'dep-vuln')
      return { ...base, kind: 'dep-vuln', advisory: advisoryFromEntry(entry) };
    if (entry.kind === 'custom-check') return { ...base, kind: 'custom-check', entry };
    return { ...base, kind: 'other', entry };
  });
  return { deferred: joined, depScanSource };
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
  const baseline = readBaseline(cwd, opts.baselineName ?? DEFAULT_BASELINE_NAME, disclosures);
  const floor = gatherFloor(cwd, baseline, packs, opts);

  const rich = (baseline?.findings ?? []).filter((e): e is RichBaselineEntry => !isSanitized(e));
  const byId = new Map(rich.map((e) => [e.id, e]));
  const allowlist = tryLoadAllowlist(cwd);
  const now = opts.now ?? new Date();
  const { deferred, depScanSource } = await joinDeferrals(cwd, allowlist, byId, opts, disclosures);
  const debt = partitionByActiveAllowlist(rich, allowlist, now).live;

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
    input: {
      floorFailures: floor.failures,
      blocking: [],
      deferred,
      debt,
      manifests,
      installFor: installResolver(cwd, packs),
      policy: { maxSliceSize: config.workOrders.maxSliceSize, budgetFor: budgetResolver(config) },
    },
  };
}

/** Gather + plan in one call: the surface entry point. */
export async function planRepoWorkOrders(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): Promise<{
  plan: WorkOrderPlan;
  floorSource: FloorSource;
  depScanSource: DepScanSource;
  disclosures: readonly string[];
}> {
  const gathered = await gatherWorkOrderInputs(cwd, config, opts);
  return {
    plan: planWorkOrders(gathered.input),
    floorSource: gathered.floorSource,
    depScanSource: gathered.depScanSource,
    disclosures: gathered.disclosures,
  };
}
