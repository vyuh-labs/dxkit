/**
 * Order-outcome ROWS for the scheduler's memory (remediate rethink, 3F):
 * the projection from one remediate run's per-order records (the recipe
 * phase's, the orders phase's, and the circuit breaker's pause list) to
 * the lane order-ledger rows (`src/lanes/order-ledger.ts`), plus the two
 * durability channels the executor uses:
 *
 *   - `writeLocalOrderLedger` (a LANDING run): the composed file is written
 *     into the checkout and committed by the lander alongside the delivery
 *     ledger, so rows ride the standing PR's own diff and reach the default
 *     branch on merge. Composing merges the standing branch's unmerged rows
 *     first (fail-open), so a landing force-push never erases the failure
 *     history a prior non-landing run recorded.
 *   - `publishOrderRows` (a NON-landing run): the composed file rides a
 *     frame-authored metadata commit pushed to the task's standing branch —
 *     the resume-marker precedent (zero agent content; built with
 *     plumbing commands, the working tree is never touched). Without this
 *     channel the breaker is blind exactly where it matters: a
 *     guardrail-red discard lands nothing, and its ephemeral runner dies
 *     with the evidence.
 *
 * Timestamps are stamped HERE, by the runner layer at record time (the
 * delivery-ledger convention) — the planner never writes a clock.
 *
 * A run's committed work is arbitrated by ONE tree verification, so every
 * order that contributed commits carries the RUN verdict as its row
 * outcome; refusals, failures-before-commit, and infrastructure keep their
 * own words (the breaker's counting sets live beside the row vocabulary).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  mergeOrderRows,
  orderLedgerPath,
  parseOrderRows,
  readLocalOrderRows,
  serializeOrderRows,
  ORDER_LEDGER_SCHEMA_VERSION,
  type OrderOutcomeRow,
  type OrderRowOutcome,
} from '../lanes/order-ledger';
import { remediateBranchFor } from '../lanes/branches';
import { internalGitPushArgs } from '../git-internal-push';
import { BOT_IDENTITY } from '../land-refresh';
import type { RemediateStamp } from './work-orders/breaker';
import type { RemediateOutcome, RemediateResult } from './outcome';

/** Hard cap on rows kept in one task's ledger file (append-only otherwise;
 *  comfortably wider than the reader's window so nothing in view is ever
 *  trimmed by a write). */
export const ORDER_LEDGER_MAX_ROWS = 500;

/** The run-verdict outcome for an order whose work was COMMITTED (one tree
 *  verification arbitrates everything that contributed commits). Outcomes
 *  with no committed-work meaning fold to the neutral 'no-op'. */
function committedVerdict(outcome: RemediateOutcome): OrderRowOutcome {
  switch (outcome) {
    case 'verified':
      return 'verified';
    case 'budget-exhausted':
      return 'budget-exhausted-verified';
    case 'guardrail-red':
      return 'guardrail-red';
    case 'floor-red':
      return 'floor-red';
    case 'install-failed':
      return 'install-failed';
    case 'sweep-failed':
      return 'sweep-failed';
    default:
      return 'no-op';
  }
}

function bounded(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const oneLine = text.split('\n')[0];
  return oneLine.length > 300 ? oneLine.slice(0, 297) + '...' : oneLine;
}

/**
 * Project one run's result into order-outcome rows. Pure over its inputs;
 * the caller (the executor) supplies the timestamp and the environment
 * stamps every row carries for the breaker's unpause comparison.
 */
export function orderOutcomeRows(
  result: Pick<RemediateResult, 'outcome' | 'recipes' | 'orders'>,
  task: string,
  meta: { readonly timestamp: string; readonly stamp: RemediateStamp },
): OrderOutcomeRow[] {
  const base = {
    schema_version: ORDER_LEDGER_SCHEMA_VERSION,
    timestamp: meta.timestamp,
    lane: 'remediate' as const,
    task,
    dxkitVersion: meta.stamp.dxkitVersion,
    policyHash: meta.stamp.policyHash,
  };
  const rows: OrderOutcomeRow[] = [];

  for (const rec of result.recipes?.records ?? []) {
    const o = rec.outcome;
    const outcome: OrderRowOutcome =
      o.kind === 'applied'
        ? committedVerdict(result.outcome)
        : o.kind === 'refused'
          ? 'refused'
          : 'failed-recipe';
    const detail =
      o.kind === 'refused'
        ? bounded(o.reason)
        : o.kind === 'failed'
          ? bounded(`${o.step}: ${o.output}`)
          : undefined;
    rows.push({
      ...base,
      orderId: rec.orderId,
      class: rec.class,
      tier: 'recipe',
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  for (const rec of result.orders?.records ?? []) {
    const outcome: OrderRowOutcome =
      rec.outcome === 'never-ran'
        ? 'never-ran'
        : rec.outcome === 'not-dispatched'
          ? 'not-dispatched'
          : rec.outcome === 'failed'
            ? 'agent-failed'
            : committedVerdict(result.outcome);
    rows.push({
      ...base,
      orderId: rec.orderId,
      class: rec.class,
      tier: 'agent',
      outcome,
      ...(rec.detail ? { detail: bounded(rec.detail) } : {}),
      ...(rec.spent ? { spend: rec.spent } : {}),
    });
  }

  for (const p of result.recipes?.paused ?? []) {
    rows.push({
      ...base,
      orderId: p.orderId,
      class: p.class,
      tier: p.tier,
      outcome: 'paused',
      detail: bounded(p.reason),
    });
  }

  return rows;
}

/** Exec seam for the ledger's git plumbing (tests inject a fake). */
export type OrderLedgerGitExec = (
  bin: string,
  args: readonly string[],
  opts?: { readonly input?: string; readonly env?: Readonly<Record<string, string>> },
) => string;

export function realOrderLedgerGitExec(cwd: string): OrderLedgerGitExec {
  return (bin, args, opts = {}) =>
    execFileSync(bin, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    }).toString();
}

/** The standing branch's current rows + head for one task, or null when
 *  unreachable (fail-open; the caller composes without them). */
function branchState(
  task: string,
  exec: OrderLedgerGitExec,
): { head: string; rows: OrderOutcomeRow[] } | null {
  const branch = remediateBranchFor(task);
  const file = orderLedgerPath('remediate', task);
  try {
    exec('git', ['fetch', 'origin', branch]);
    const head = exec('git', ['rev-parse', 'FETCH_HEAD']).trim();
    let rows: OrderOutcomeRow[] = [];
    try {
      rows = parseOrderRows(exec('git', ['show', `FETCH_HEAD:${file}`]));
    } catch {
      // branch exists, file does not — an empty history
    }
    return { head, rows };
  } catch {
    return null;
  }
}

/** Compose the durable file content: branch rows + local rows + this run's
 *  rows, deduped, oldest first, capped so the file cannot grow forever. */
function composeLedger(
  cwd: string,
  task: string,
  newRows: readonly OrderOutcomeRow[],
  branchRows: readonly OrderOutcomeRow[],
): string {
  const local = readLocalOrderRows(cwd).filter((r) => r.task === task);
  const merged = mergeOrderRows(branchRows, local, newRows);
  return serializeOrderRows(merged.slice(Math.max(0, merged.length - ORDER_LEDGER_MAX_ROWS)));
}

/**
 * Landing path: write the composed ledger file into the checkout so the
 * lander commits it with the delivery ledger and the work. Returns the
 * repo-relative path, or null when nothing was written.
 */
export function writeLocalOrderLedger(
  cwd: string,
  task: string,
  newRows: readonly OrderOutcomeRow[],
  exec?: OrderLedgerGitExec,
): string | null {
  if (newRows.length === 0) return null;
  const rel = orderLedgerPath('remediate', task);
  const branch = branchState(task, exec ?? realOrderLedgerGitExec(cwd));
  const content = composeLedger(cwd, task, newRows, branch?.rows ?? []);
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return rel;
}

export interface PublishOrderRowsResult {
  readonly published: boolean;
  /** Why not, when `published` is false — disclosed by the caller. */
  readonly note?: string;
}

/**
 * Non-landing path: push the composed ledger as a frame-authored metadata
 * commit onto the task's standing branch (created from the checkout's HEAD
 * when no branch exists). Built entirely with plumbing commands — the
 * working tree and index are never touched, and the commit carries exactly
 * one path: the lane's own ledger file. A push race (a concurrent write to
 * the branch) is retried once on a fresh base; failure is a disclosed note,
 * never a crash (evidence plumbing, the GateFailure discipline).
 */
export function publishOrderRows(
  cwd: string,
  task: string,
  newRows: readonly OrderOutcomeRow[],
  exec?: OrderLedgerGitExec,
): PublishOrderRowsResult {
  if (newRows.length === 0) return { published: false, note: 'no order rows to record' };
  const run = exec ?? realOrderLedgerGitExec(cwd);
  const branch = remediateBranchFor(task);
  const file = orderLedgerPath('remediate', task);

  const attempt = (): void => {
    const state = branchState(task, run);
    const base = state?.head ?? run('git', ['rev-parse', 'HEAD']).trim();
    const content = composeLedger(cwd, task, newRows, state?.rows ?? []);
    const blob = run('git', ['hash-object', '-w', '--stdin'], { input: content }).trim();
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-order-ledger-'));
    const indexFile = path.join(indexDir, 'index');
    try {
      const env = { GIT_INDEX_FILE: indexFile };
      run('git', ['read-tree', base], { env });
      run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
      const tree = run('git', ['write-tree'], { env }).trim();
      const commit = run('git', [
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        'commit-tree',
        tree,
        '-p',
        base,
        '-m',
        'chore(dxkit): record remediation order outcomes [skip ci]',
      ]).trim();
      run('git', internalGitPushArgs(`${commit}:refs/heads/${branch}`));
    } finally {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  };

  try {
    attempt();
    return { published: true };
  } catch {
    try {
      attempt(); // one retry on a fresh base (a concurrent push is a race, not a fault)
      return { published: true };
    } catch (err) {
      return {
        published: false,
        note:
          `order-outcome rows could not be recorded on '${branch}' ` +
          `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}), so the ` +
          'circuit breaker will not see this run; the job summary remains the evidence',
      };
    }
  }
}
