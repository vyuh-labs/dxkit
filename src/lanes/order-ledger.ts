/**
 * The work-order OUTCOME ledger (remediate rethink, section 3F) — the
 * scheduler's memory. The delivery ledger beside this module (`ledger.ts`)
 * answers "what did the lanes LAND"; this one answers "what happened to
 * each work ORDER the remediate lane dispatched", including the outcomes
 * that never land (a guardrail-red discard, a failed recipe), because those
 * are exactly the rows the circuit breaker needs to stop re-buying the same
 * failure every firing.
 *
 * Same mechanism, same directory (`.dxkit/lanes/`), one JSONL file per
 * standing-PR identity (`remediate-<task>.orders.jsonl`) so concurrent
 * matrix tasks never touch one file. Rows reach durability on two existing
 * channels, no new trust surface:
 *
 *   - a LANDING commits the file into the standing PR's own diff (the
 *     delivery-ledger doctrine), so rows reach the default branch on merge;
 *   - a NON-landing outcome rides a frame-authored metadata commit pushed
 *     to the task's standing branch (the resume-marker precedent: zero
 *     agent content, only the lane's own record), written by the remediate
 *     executor — see `src/remediate/order-outcomes.ts`.
 *
 * ONE reader (`orderHistory`) merges both channels — the local checkout's
 * committed files plus each standing branch's copy, fetched fail-open —
 * dedupes, and bounds the window (old rows age out, which also gives a
 * paused class a natural retry horizon instead of a forever-pause).
 *
 * Timestamps are written by the RUNNER at row-append time (the delivery
 * ledger's convention); the planner only ever reads.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readJsonlFile } from '../jsonl';
import { LANES_DIR } from './ledger';

/** Bump only on a breaking change to the row shape. */
export const ORDER_LEDGER_SCHEMA_VERSION = 1;

/**
 * Per-order outcome vocabulary. Committed-work rows carry the RUN verdict
 * (one tree verification arbitrates every order that contributed commits);
 * refusals and infrastructure keep their own words so the breaker can tell
 * "the work failed" from "nothing was tried".
 */
export type OrderRowOutcome =
  | 'verified'
  | 'budget-exhausted-verified'
  | 'guardrail-red'
  | 'floor-red'
  | 'install-failed'
  | 'failed-recipe'
  | 'refused'
  | 'agent-failed'
  | 'never-ran'
  | 'not-dispatched'
  | 'sweep-failed'
  | 'no-op'
  | 'paused';

/**
 * The breaker's failure set: outcomes where work was ATTEMPTED and the
 * verification (or the recipe's own verify) said no. Deliberately narrow —
 * infrastructure ('never-ran'), refusals ('refused', $0 by design), and
 * plumbing failures ('sweep-failed') never count: pausing a class because
 * credits ran out would punish the code for the environment.
 */
export const ORDER_FAILURE_OUTCOMES: ReadonlySet<OrderRowOutcome> = new Set([
  'guardrail-red',
  'floor-red',
  'install-failed',
  'failed-recipe',
]);

/** The breaker's success set: outcomes that RESET a failure streak — the
 *  class produced verified work (a budget-cut verified partial counts:
 *  progress is progress). Everything not in either set is neutral: it
 *  neither counts as a failure nor resets the streak. */
export const ORDER_SUCCESS_OUTCOMES: ReadonlySet<OrderRowOutcome> = new Set([
  'verified',
  'budget-exhausted-verified',
]);

export interface OrderOutcomeRow {
  readonly schema_version: number;
  /** ISO timestamp, written by the runner at append time. */
  readonly timestamp: string;
  readonly lane: 'remediate' | string;
  readonly task: string;
  readonly orderId: string;
  /** The order's work-order class — the breaker's grouping key. */
  readonly class: string;
  readonly tier: 'recipe' | 'agent';
  readonly outcome: OrderRowOutcome;
  readonly spend?: { readonly turns?: number; readonly costUsd?: number };
  /** Failure/refusal reason, bounded (evidence pointer, not a transcript). */
  readonly detail?: string;
  /** Environment stamps the breaker's unpause conditions compare against:
   *  a dxkit upgrade or a remediate-policy change lifts a pause. */
  readonly dxkitVersion: string;
  readonly policyHash: string;
}

/** Orders-ledger file for a standing-PR identity, repo-relative POSIX.
 *  Distinct from the delivery ledger's file so `readLaneEvents` (which
 *  accepts only landed delivery events) and this reader never mix rows. */
export function orderLedgerPath(lane: string, task: string): string {
  return `${LANES_DIR.replace(/\\/g, '/')}/${lane}-${task}.orders.jsonl`;
}

function isOrderRow(raw: unknown): raw is OrderOutcomeRow {
  const r = raw as OrderOutcomeRow;
  return (
    typeof r?.schema_version === 'number' &&
    r.schema_version <= ORDER_LEDGER_SCHEMA_VERSION &&
    typeof r.timestamp === 'string' &&
    typeof r.lane === 'string' &&
    typeof r.task === 'string' &&
    typeof r.orderId === 'string' &&
    typeof r.class === 'string' &&
    typeof r.outcome === 'string'
  );
}

/** Parse JSONL text into validated rows — fail-open per line, and a row
 *  from a NEWER schema is skipped (this dxkit cannot interpret it). */
export function parseOrderRows(text: string): OrderOutcomeRow[] {
  const rows: OrderOutcomeRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw: unknown = JSON.parse(trimmed);
      if (isOrderRow(raw)) rows.push(raw);
    } catch {
      // a corrupt line is skipped, never a crash
    }
  }
  return rows;
}

/** Every order row committed in the local checkout's lanes directory. */
export function readLocalOrderRows(cwd: string): OrderOutcomeRow[] {
  const dir = path.join(cwd, LANES_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.orders.jsonl'));
  } catch {
    return [];
  }
  const rows: OrderOutcomeRow[] = [];
  for (const file of files) {
    for (const raw of readJsonlFile(path.join(dir, file))) {
      if (isOrderRow(raw)) rows.push(raw);
    }
  }
  return rows;
}

function rowKey(r: OrderOutcomeRow): string {
  return `${r.task}\0${r.orderId}\0${r.timestamp}`;
}

/** Union row lists (a row can arrive via both the merged default branch and
 *  a standing branch), deduped, oldest first. */
export function mergeOrderRows(
  ...lists: ReadonlyArray<readonly OrderOutcomeRow[]>
): OrderOutcomeRow[] {
  const byKey = new Map<string, OrderOutcomeRow>();
  for (const list of lists) {
    for (const row of list) {
      if (!byKey.has(rowKey(row))) byKey.set(rowKey(row), row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Serialize rows back to the JSONL wire shape (one row per line). */
export function serializeOrderRows(rows: readonly OrderOutcomeRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/** Default reading window: rows older than this age out of the breaker's
 *  view, so a pause is a retry horizon, never a forever-off switch. */
export const ORDER_HISTORY_WINDOW_DAYS = 60;

/** Per-class row cap inside the window (newest kept). */
export const ORDER_HISTORY_MAX_PER_CLASS = 50;

export interface OrderWindowOptions {
  readonly now?: Date;
  readonly windowDays?: number;
  readonly maxPerClass?: number;
}

/** Apply the bounded window: drop rows older than `windowDays`, keep the
 *  newest `maxPerClass` rows per class, return oldest first. */
export function boundOrderWindow(
  rows: readonly OrderOutcomeRow[],
  opts: OrderWindowOptions = {},
): OrderOutcomeRow[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? ORDER_HISTORY_WINDOW_DAYS;
  const maxPerClass = opts.maxPerClass ?? ORDER_HISTORY_MAX_PER_CLASS;
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = rows.filter((r) => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
  const byClass = new Map<string, OrderOutcomeRow[]>();
  for (const row of inWindow) {
    const list = byClass.get(row.class) ?? [];
    list.push(row);
    byClass.set(row.class, list);
  }
  const kept: OrderOutcomeRow[] = [];
  for (const list of byClass.values()) {
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    kept.push(...sorted.slice(Math.max(0, sorted.length - maxPerClass)));
  }
  return kept.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Injectable exec for the branch reads (tests; the writer shares it). */
export type OrderLedgerExec = (bin: string, args: readonly string[]) => string;

export function realOrderLedgerExec(cwd: string): OrderLedgerExec {
  return (bin, args) =>
    execFileSync(bin, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).toString();
}

/** One standing-branch source: the branch plus the repo-relative ledger
 *  file the lane writes on it. */
export interface OrderBranchSource {
  readonly branch: string;
  readonly file: string;
}

/** Rows currently on one standing branch, or null when the branch (or the
 *  file) is unreachable — the caller decides whether that is a disclosure
 *  (a fetch failure) or normal (the file simply does not exist yet). */
export function readBranchOrderRows(
  source: OrderBranchSource,
  exec: OrderLedgerExec,
): { rows: OrderOutcomeRow[]; head: string } | null {
  try {
    exec('git', ['fetch', 'origin', source.branch]);
    const head = exec('git', ['rev-parse', 'FETCH_HEAD']).trim();
    let text = '';
    try {
      text = exec('git', ['show', `FETCH_HEAD:${source.file}`]);
    } catch {
      // the branch exists but has no ledger file yet — an empty history
      return { rows: [], head };
    }
    return { rows: parseOrderRows(text), head };
  } catch {
    return null;
  }
}

export interface OrderHistoryOptions extends OrderWindowOptions {
  /** Standing-branch sources to merge in (unmerged rows live there).
   *  Empty/absent = local files only. */
  readonly branches?: readonly OrderBranchSource[];
  readonly exec?: OrderLedgerExec;
}

export interface OrderHistory {
  /** Deduped, window-bounded rows, oldest first. */
  readonly rows: readonly OrderOutcomeRow[];
  /** Degraded reads, phrased for humans (an unreachable branch is a
   *  disclosed absence, never a silent one). */
  readonly disclosures: readonly string[];
}

/** Which of the given branches exist on origin — ONE network probe (an
 *  absent branch is normal, not a degradation; only an unreachable remote
 *  is). Null = the probe itself failed (offline, no origin). */
export function existingRemoteBranches(
  branches: readonly string[],
  exec: OrderLedgerExec,
): Set<string> | null {
  if (branches.length === 0) return new Set();
  try {
    const out = exec('git', ['ls-remote', '--heads', 'origin', ...branches]);
    const present = new Set<string>();
    for (const line of out.split('\n')) {
      const ref = line.split('\t')[1]?.trim();
      if (ref?.startsWith('refs/heads/')) present.add(ref.slice('refs/heads/'.length));
    }
    return present;
  } catch {
    return null;
  }
}

/**
 * The ONE reader (Rule 2.30): local committed rows plus every standing
 * branch's copy, deduped and window-bounded. Fail-open — an offline plan
 * still reads its local history and says what it could not.
 */
export function orderHistory(cwd: string, opts: OrderHistoryOptions = {}): OrderHistory {
  const disclosures: string[] = [];
  const lists: Array<readonly OrderOutcomeRow[]> = [readLocalOrderRows(cwd)];
  const branches = opts.branches ?? [];
  if (branches.length > 0) {
    const exec = opts.exec ?? realOrderLedgerExec(cwd);
    const present = existingRemoteBranches(
      branches.map((b) => b.branch),
      exec,
    );
    if (present === null) {
      disclosures.push(
        'order history: no remote reachable to read the standing branches; unmerged ' +
          'outcome rows, if any, are not in view (local committed history only)',
      );
    } else {
      const unreadable: string[] = [];
      for (const source of branches) {
        if (!present.has(source.branch)) continue; // never written: empty history
        const read = readBranchOrderRows(source, exec);
        if (read === null) unreadable.push(source.branch);
        else lists.push(read.rows);
      }
      if (unreadable.length > 0) {
        disclosures.push(
          `order history: standing branch(es) ${unreadable.join(', ')} exist but could not ` +
            'be fetched; their unmerged outcome rows are not in view',
        );
      }
    }
  }
  return {
    rows: boundOrderWindow(mergeOrderRows(...lists), opts),
    disclosures,
  };
}
