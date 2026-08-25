/**
 * The ONE I/O adapter that assembles planner inputs from a repo (Rule 2.30:
 * one concept, one code path). Every surface that wants a work-order plan
 * for a repo (the plan CLI today; the executor in a later unit) calls
 * `gatherWorkOrderInputs` / `planRepoWorkOrders`, so no surface can forget a
 * source or join it differently.
 *
 * Sources it reads:
 *   - the entry floor: `runCorrectnessFloor` on the pristine tree, attributed
 *     against the baseline's recorded floor-debt envelope through the one
 *     comparator (`attributeFloorFailures`; an absent envelope reads as
 *     unattributed, never as net-new);
 *   - the committed baseline's custom-check entries (the lint backlog);
 *   - active allowlist deferrals joined by fingerprint to baseline entries;
 *   - repo facts: the package manager's provision command and the root
 *     dependency root (manifest + lockfile).
 *
 * Guardrail blocking pairs are NOT gathered here: they exist only inside a
 * verify step (post-agent). The executor unit passes them into the planner
 * from the verify result it already holds.
 */
import * as fs from 'fs';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../../analyzers/correctness/run';
import {
  attributeFloorFailures,
  type FloorBaseCheck,
} from '../../analyzers/correctness/attribution';
import { detectActiveLanguages } from '../../languages';
import { pathForBaseline, readBaselineFile, type BaselineFile } from '../../baseline/baseline-file';
import { isSanitized } from '../../baseline/sanitize';
import type { RichBaselineEntry } from '../../baseline/types';
import { daysUntilDate, tryLoadAllowlist } from '../../allowlist/file';
import { detectLockfile, detectPackageManager, provisionCommand } from '../../package-manager';
import type { RemediateConfig } from '../config';
import { planWorkOrders, type ManifestRoot, type PlannerInput } from './planner';
import type { WorkOrderPlan } from './types';

export interface GatherWorkOrderOptions {
  /** Injected floor run (tests); defaults to the real full-scope floor. */
  readonly runFloor?: (cwd: string) => CorrectnessFloorResult;
  /** The clock for deferral expiry (injectable for tests). */
  readonly now?: Date;
  readonly baselineName?: string;
}

/** The baseline's recorded floor envelope as the comparator's base side. The
 *  envelope records check status only (no finding-level identities), so the
 *  comparator works at CHECK precision and says so. */
function baseChecksFrom(baseline: BaselineFile | null): FloorBaseCheck[] | null {
  const debt = baseline?.floorDebt;
  if (!debt) return null;
  return debt.checks.map((c) => ({
    pack: c.pack,
    label: c.label,
    status: c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'skipped',
  }));
}

function readBaseline(cwd: string, name: string): BaselineFile | null {
  try {
    const p = pathForBaseline(cwd, name);
    return fs.existsSync(p) ? readBaselineFile(p) : null;
  } catch {
    return null; // unreadable baseline: the plan proceeds without it, disclosed by emptiness
  }
}

/** The pm's provision command as `{ bin, args }` (the frame execFiles it). */
export function installCommandFor(cwd: string): { bin: string; args: string[] } {
  const [bin, ...args] = provisionCommand(detectPackageManager(cwd)).split(' ');
  return { bin, args };
}

/** The root dependency root: manifest + lockfile when a lockfile is present,
 *  else the manifest alone. */
export function rootManifest(cwd: string): ManifestRoot {
  const lock = detectLockfile(cwd);
  const files = ['package.json'];
  if (lock) files.push(lock.lockfile);
  return { dir: '', files: files.filter((f) => fs.existsSync(`${cwd}/${f}`)) };
}

export function gatherWorkOrderInputs(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): PlannerInput {
  const baseline = readBaseline(cwd, opts.baselineName ?? 'main');
  const runFloor =
    opts.runFloor ??
    ((dir: string) =>
      runCorrectnessFloor({
        cwd: dir,
        changedFiles: [],
        scope: 'full',
        packs: detectActiveLanguages(dir),
      }));
  const floor = runFloor(cwd);
  const entryFloor =
    floor.checks.length > 0
      ? {
          result: floor,
          attributed: attributeFloorFailures(floor, baseChecksFrom(baseline), {
            absentMeans: 'unattributed',
          }),
        }
      : null;

  const rich = (baseline?.findings ?? []).filter((e): e is RichBaselineEntry => !isSanitized(e));
  const byId = new Map(rich.map((e) => [e.id, e]));
  const now = opts.now ?? new Date();
  const allowlist = tryLoadAllowlist(cwd);
  const deferred = (allowlist?.entries ?? [])
    .filter(
      (e) =>
        e.category === 'deferred' &&
        typeof e.expiresAt === 'string' &&
        daysUntilDate(e.expiresAt, now) >= 0,
    )
    .map((allow) => ({ allow, entry: byId.get(allow.fingerprint) ?? null }));
  const deferredIds = new Set(deferred.map((d) => d.allow.fingerprint));
  const debt = rich.filter((e) => e.kind === 'custom-check' && !deferredIds.has(e.id));

  return {
    entryFloor,
    blocking: [],
    deferred,
    debt,
    manifests: [rootManifest(cwd)],
    install: installCommandFor(cwd),
    policy: { maxSliceSize: config.workOrders.maxSliceSize, budget: config.agent.budget },
  };
}

/** Gather + plan in one call: the surface entry point. */
export function planRepoWorkOrders(
  cwd: string,
  config: RemediateConfig,
  opts: GatherWorkOrderOptions = {},
): WorkOrderPlan {
  return planWorkOrders(gatherWorkOrderInputs(cwd, config, opts));
}
