/**
 * Shared shapes and helpers for the planner's per-source builders: the draft
 * order (everything but tier), the ranked wrapper the planner sorts, the
 * done-criterion builder, the budget derivation, the one `undispatch`
 * helper, and the single definitions of the install-forbidden line, the
 * manifest-path projection, and the binary-custom-check reason. Kept beside
 * the builders so each stays small.
 */
import { dxkitCli } from '../../self-invocation';
import type { RemediateBudget } from '../config';
import type {
  DoneCriterion,
  UndispatchableGroup,
  WorkOrder,
  WorkOrderBudget,
  WorkOrderClass,
  WorkOrderFinding,
} from './types';

export type Draft = Omit<WorkOrder, 'tier' | 'recipe'>;

/** Value bands (lower sorts first): net-new floor, expiring deferrals,
 *  reachable high/critical advisories, other blocking, pre-existing floor,
 *  debt. The within-band key breaks ties deterministically (byte order). */
export const VALUE_BAND = {
  netNewFloor: 0,
  expiringDeferral: 1,
  reachableSevere: 2,
  otherBlocking: 3,
  preExistingFloor: 4,
  debt: 5,
} as const;

export interface Ranked {
  readonly draft: Draft;
  readonly rank: readonly [number, number | string];
}

export function compareRank(a: Ranked, b: Ranked): number {
  if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0];
  const x = a.rank[1];
  const y = b.rank[1];
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return byteOrder(String(x), String(y));
}

/** Byte-order string comparison (deterministic across locales). */
export function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The ONE phrasing of the install ban every order carries (the frame runs
 *  the install; the agent never does). */
export const INSTALL_FORBIDDEN =
  'installing, adding, or removing packages yourself (the frame runs the install command)';

/** The ONE reason a binary custom-check finding cannot be ordered. */
export const BINARY_CUSTOM_CHECK_REASON =
  'binary (whole-command) custom-check findings carry no file to scope an order to';

/** A dependency root: the manifest and lockfile files a dependency fix
 *  touches. `dir` is repo-relative (`''` for the root), files are relative
 *  to `dir`. */
export interface ManifestRoot {
  readonly dir: string;
  readonly files: readonly string[];
}

/** The ONE ManifestRoot -> repo-relative-paths projection. */
export function manifestPaths(root: ManifestRoot): string[] {
  return root.files.map((f) => (root.dir ? `${root.dir}/${f}` : f));
}

/** Every discovered root's manifest paths, deduplicated, byte-ordered. */
export function allManifestPaths(roots: readonly ManifestRoot[]): string[] {
  return [...new Set(roots.flatMap(manifestPaths))].sort(byteOrder);
}

/** Resolve an install command per producing ecosystem: the owning pack's
 *  declared provision command when the finding names its pack; the single
 *  unambiguous one when exactly one active pack declares any; else
 *  undefined (disclosed at render, never guessed). */
export type InstallFor = (
  pack: string | undefined,
) => { readonly bin: string; readonly args: readonly string[] } | undefined;

export function doneFor(
  verifier: DoneCriterion['verifier'],
  findings: readonly WorkOrderFinding[],
): DoneCriterion {
  return {
    absentIds: findings.map((f) => f.id),
    verifier,
    command: dxkitCli(verifier === 'floor' ? 'floor check' : 'guardrail check'),
  };
}

/** Default `remediate.workOrders.maxSliceSize`. */
export const DEFAULT_MAX_SLICE_SIZE = 25;

/** Budget derivation constants, declared once (section 3C). */
export const BUDGET_DERIVATION = {
  baseTurns: 8,
  perFindingTurns: 4,
  minTurns: 10,
  baseMinutes: 5,
  perFindingMinutes: 2,
  minMinutes: 5,
} as const;

/** `min(cap, max(floor, value))`: the policy cap always wins, even when it
 *  sits below the derivation's own minimum. */
function bounded(value: number, floor: number, cap: number): number {
  return Math.min(cap, Math.max(floor, value));
}

/**
 * `turns = min(cap.maxTurns, max(min, base + perFinding * n))`, same shape
 * for minutes; usd scales with the turn fraction of the cap and is capped
 * by it. `cap` is the SELECTING TASK's effective budget (`budgetForTask`),
 * so one plan never shows two budgets for one concept.
 */
export function deriveBudget(findingCount: number, cap: RemediateBudget): WorkOrderBudget {
  const d = BUDGET_DERIVATION;
  const turns = bounded(d.baseTurns + d.perFindingTurns * findingCount, d.minTurns, cap.maxTurns);
  const minutes = bounded(
    d.baseMinutes + d.perFindingMinutes * findingCount,
    d.minMinutes,
    cap.maxMinutes,
  );
  const usd = Math.min(cap.maxUsd, Math.max(1, Math.round((cap.maxUsd * turns) / cap.maxTurns)));
  return {
    turns,
    minutes,
    usd,
    derivation:
      `turns = min(${cap.maxTurns}, max(${d.minTurns}, ${d.baseTurns} + ${d.perFindingTurns} * ` +
      `${findingCount})) = ${turns}; minutes = min(${cap.maxMinutes}, max(${d.minMinutes}, ` +
      `${d.baseMinutes} + ${d.perFindingMinutes} * ${findingCount})) = ${minutes}; ` +
      `usd = min(${cap.maxUsd}, round(${cap.maxUsd} * ${turns} / ${cap.maxTurns})) = ${usd}`,
  };
}

/** The one way a builder records findings it cannot place. */
export function undispatch(
  into: UndispatchableGroup[],
  reason: string,
  findings: readonly WorkOrderFinding[],
): void {
  if (findings.length > 0) into.push({ reason, findings });
}

/** A finding carrying only an identity (no class, or nothing to join). */
export function identityOnly(
  kind: string,
  id: string,
  attribution: WorkOrderFinding['attribution'],
): WorkOrderFinding {
  return { kind, id, attribution, evidence: { type: 'none' } };
}

/** The budget cap resolver every builder receives: per class, the selecting
 *  task's effective budget. */
export type BudgetCapFor = (cls: WorkOrderClass) => RemediateBudget;

/** Distinct kinds among findings, byte-ordered, for reason strings. */
export function kindsOf(findings: readonly WorkOrderFinding[]): string {
  return [...new Set(findings.map((f) => f.kind))].sort(byteOrder).join(', ');
}
