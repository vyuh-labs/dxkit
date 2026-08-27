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
 *     the resume-marker precedent (zero agent content; built with plumbing
 *     commands, the working tree is never touched). Without this channel
 *     the breaker is blind exactly where it matters: a guardrail-red
 *     discard lands nothing, and its ephemeral runner dies with the
 *     evidence. SECURITY: the metadata commit parents ONLY on the fetched
 *     REMOTE branch head; when no branch exists it is an ORPHAN commit
 *     whose tree holds the one ledger file — never the local HEAD, whose
 *     history on a non-landing path is exactly the unverified content the
 *     "never push unverified" law exists to keep off the remote.
 *
 * ONE ROW PER ORDER PER RUN: when the agent tier picks up an order the
 * recipe tier refused or failed, the agent's terminal outcome is the row
 * (a first-wins dedupe on a shared run timestamp would otherwise keep the
 * recipe failure and pause a class that is being fixed). Timestamps are
 * stamped HERE, by the runner layer at record time (the delivery-ledger
 * convention) — the planner never writes a clock.
 *
 * A run's committed work is arbitrated by ONE tree verification, so every
 * order that contributed commits carries the RUN verdict as its row
 * outcome; refusals, failures-before-commit, and infrastructure keep their
 * own words (the breaker's counting sets live beside the row vocabulary).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mergeOrderRows,
  orderLedgerPath,
  parseLedgerText,
  readBranchOrderRows,
  realOrderLedgerExec,
  serializeOrderRows,
  ORDER_LEDGER_SCHEMA_VERSION,
  type OrderLedgerExec,
  type OrderOutcomeRow,
  type OrderRowOutcome,
} from '../lanes/order-ledger';
import { remediateBranchFor } from '../lanes/branches';
import { internalGitPushArgs } from '../git-internal-push';
import { BOT_IDENTITY } from '../land-refresh';
import type { RemediateStamp } from './work-orders/breaker';
import type { OrderDisposition, RemediateOutcome, RemediateResult } from './outcome';

/** Hard cap on recognized rows kept in one task's ledger file (append-only
 *  otherwise; comfortably wider than the reader's window so nothing in
 *  view is ever trimmed by a write). Foreign lines (a newer schema's rows)
 *  are always carried through, never capped by THIS build. */
export const ORDER_LEDGER_MAX_ROWS = 500;

/**
 * The run-verdict outcome for an order whose work was COMMITTED (one tree
 * verification arbitrates everything that contributed commits). EXHAUSTIVE
 * over the run-outcome vocabulary on purpose: a new outcome fails to
 * compile until someone classifies it for the breaker, instead of folding
 * silently to neutral.
 */
function committedVerdict(outcome: RemediateOutcome): OrderRowOutcome {
  switch (outcome) {
    case 'verified':
      return 'verified';
    // The kept orders of a partially-landed run verified and land (the
    // dropped ones carry their own row through `droppedVerdict`).
    case 'partially-landed':
      return 'verified';
    // Verification infrastructure failed: nothing was certified either
    // way. Neutral for the breaker (nothing was tried against the code).
    case 'verification-unavailable':
      return 'unverifiable';
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
    // The arms below cannot co-occur with a committed order record today
    // (a no-op / recipes-refused run has no diff; a refusal precedes any
    // record; order-selecting tasks declare no score hinge, catalog-
    // pinned). Classified NEUTRAL deliberately: unreachable rows must
    // never be able to pause or unpause a class.
    case 'no-op':
    case 'recipes-refused':
    case 'score-red':
    case 'refused':
      return 'no-op';
    case 'agent-never-ran':
      return 'never-ran';
    case 'agent-failed':
      return 'agent-failed';
  }
}

/** The row of an order DROPPED at its own verification (4.4.6): the
 *  breaker counts the dropped order's class on the step that dropped it,
 *  never the run as a whole. */
function droppedVerdict(d: Extract<OrderDisposition, { kind: 'dropped' }>): OrderRowOutcome {
  switch (d.step) {
    case 'tree-invariants':
      return 'invariant-failed';
    case 'install':
      return 'install-failed';
    case 'floor':
      return 'floor-red';
  }
}

/** The row outcome of an order that COMMITTED work: its own disposition
 *  when one was decided (per-order landing), else the run verdict. */
function placedVerdict(
  disposition: OrderDisposition | undefined,
  outcome: RemediateOutcome,
): OrderRowOutcome {
  if (disposition?.kind === 'dropped') return droppedVerdict(disposition);
  if (disposition?.kind === 'unverifiable') return 'unverifiable';
  return committedVerdict(outcome);
}

function bounded(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const oneLine = text.split('\n')[0];
  return oneLine.length > 300 ? oneLine.slice(0, 297) + '...' : oneLine;
}

/**
 * Project one run's result into order-outcome rows: ONE row per order,
 * reflecting the TERMINAL tier's outcome — an agent attempt (completed /
 * partial / errored) supersedes the recipe record it fell through from; a
 * neutral agent record (not dispatched, CLI never ran) leaves the recipe
 * tier's evidence standing. The breaker's pause list is recorded as ONE
 * bookkeeping marker per class per firing, not a row per paused order (a
 * weekly stream of paused rows must not drown the outcome evidence).
 * Pure over its inputs; the caller (the executor) supplies the timestamp
 * and the environment stamps every row carries for the breaker's unpause
 * comparison.
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
  const byOrder = new Map<string, OrderOutcomeRow>();

  for (const rec of result.recipes?.records ?? []) {
    const o = rec.outcome;
    const outcome: OrderRowOutcome =
      o.kind === 'applied'
        ? placedVerdict(rec.disposition, result.outcome)
        : o.kind === 'refused'
          ? 'refused'
          : 'failed-recipe';
    const detail =
      o.kind === 'refused'
        ? bounded(o.reason)
        : o.kind === 'failed'
          ? bounded(`${o.step}: ${o.output}`)
          : rec.disposition?.kind === 'dropped'
            ? bounded(`${rec.disposition.step}: ${rec.disposition.reason}`)
            : undefined;
    byOrder.set(rec.orderId, {
      ...base,
      orderId: rec.orderId,
      class: rec.class,
      tier: 'recipe',
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  for (const rec of result.orders?.records ?? []) {
    const attempted =
      rec.outcome === 'completed' || rec.outcome === 'partial' || rec.outcome === 'failed';
    // A neutral agent record (not-dispatched, never-ran) must not erase a
    // recipe tier's evidence for the same order; it only stands alone.
    if (!attempted && byOrder.has(rec.orderId)) continue;
    const outcome: OrderRowOutcome =
      rec.outcome === 'never-ran'
        ? 'never-ran'
        : rec.outcome === 'not-dispatched'
          ? 'not-dispatched'
          : rec.outcome === 'failed' && rec.disposition === undefined
            ? 'agent-failed'
            : rec.outcome === 'failed' && rec.disposition?.kind === 'kept'
              ? // The commits verified and land, but the DRIVER reported the
                // run failed: real progress, not a success — a distinct
                // NEUTRAL row so the breaker's streak neither resets nor
                // grows on it (review fix 9).
                'partial-kept'
              : placedVerdict(rec.disposition, result.outcome);
    const detail =
      rec.disposition?.kind === 'dropped'
        ? `${rec.disposition.step}: ${rec.disposition.reason}`
        : rec.disposition?.kind === 'unverifiable'
          ? `unverifiable: ${rec.disposition.reason}`
          : rec.detail;
    byOrder.set(rec.orderId, {
      ...base,
      orderId: rec.orderId,
      class: rec.class,
      tier: 'agent',
      outcome,
      ...(detail ? { detail: bounded(detail) } : {}),
      ...(rec.spent ? { spend: rec.spent } : {}),
    });
  }

  const rows = [...byOrder.values()];

  // One paused MARKER per class per firing: bookkeeping, never evidence.
  const pausedByClass = new Map<string, { first: string; count: number; reason: string }>();
  for (const p of result.recipes?.paused ?? []) {
    const seen = pausedByClass.get(p.class);
    if (seen) seen.count += 1;
    else pausedByClass.set(p.class, { first: p.orderId, count: 1, reason: p.reason });
  }
  for (const [cls, p] of pausedByClass) {
    rows.push({
      ...base,
      orderId: p.first,
      class: cls,
      tier: 'recipe',
      outcome: 'paused',
      detail: bounded(`${p.count} order(s) paused: ${p.reason}`),
    });
  }

  return rows;
}

/** Exec seam for the ledger's git plumbing — the ONE machine git-exec
 *  shape (`land-refresh.ts:makeExec`), re-exported by the ledger module. */
export type OrderLedgerGitExec = OrderLedgerExec;

export function realOrderLedgerGitExec(cwd: string): OrderLedgerGitExec {
  return realOrderLedgerExec(cwd);
}

/** The one branch read (Rule 2.30: `readBranchOrderRows` in the ledger
 *  module), keyed by task. Null = branch unreachable or absent. */
function branchState(
  task: string,
  exec: OrderLedgerGitExec,
): { head: string; rows: OrderOutcomeRow[]; foreign: string[] } | null {
  return readBranchOrderRows(
    { branch: remediateBranchFor(task), file: orderLedgerPath('remediate', task) },
    exec,
  );
}

/** Compose the durable file content: branch rows + local rows + this run's
 *  rows, deduped, oldest first, recognized rows capped so the file cannot
 *  grow forever — and every FOREIGN line (a newer schema's rows, a corrupt
 *  line) carried through VERBATIM. This build caps only what it can read;
 *  dropping what it cannot would silently roll back a newer build's
 *  memory. */
function composeLedger(
  cwd: string,
  task: string,
  newRows: readonly OrderOutcomeRow[],
  branch: { readonly rows: readonly OrderOutcomeRow[]; readonly foreign: readonly string[] } | null,
): string {
  let localText = '';
  try {
    localText = fs.readFileSync(path.join(cwd, orderLedgerPath('remediate', task)), 'utf8');
  } catch {
    // no local file yet
  }
  const local = parseLedgerText(localText);
  const merged = mergeOrderRows(branch?.rows ?? [], local.rows, newRows).filter(
    (r) => r.task === task,
  );
  const capped = merged.slice(Math.max(0, merged.length - ORDER_LEDGER_MAX_ROWS));
  const foreign = [...new Set([...(branch?.foreign ?? []), ...local.foreign])];
  return serializeOrderRows(capped) + (foreign.length > 0 ? foreign.join('\n') + '\n' : '');
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
  const rel = orderLedgerPath('remediate', task);
  // Even a run with NO rows of its own composes the standing branch's rows
  // into the landing: the lander force-pushes from the default head, so a
  // ledger left only on the branch (a resume-attempt row, a prior red run's
  // failures) would be erased by the very landing that should carry it.
  const branch = branchState(task, exec ?? realOrderLedgerGitExec(cwd));
  const carried = (branch?.rows.length ?? 0) + (branch?.foreign.length ?? 0);
  if (newRows.length === 0 && carried === 0) return null;
  const content = composeLedger(cwd, task, newRows, branch);
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
 * commit onto the task's standing branch. Built entirely with plumbing
 * commands — the working tree and index are never touched, and the commit
 * carries exactly one path: the lane's own ledger file.
 *
 * SECURITY (the never-push-unverified law): the commit parents ONLY on the
 * fetched REMOTE branch head. When no branch is reachable it is an ORPHAN
 * commit over an empty tree plus the ledger blob — never a child of the
 * local HEAD, because on every non-landing path the local history past the
 * base IS the unverified diff (a guardrail-red discard, a wrong-branch
 * refusal), and a ledger push must not make one unverified commit
 * reachable from the remote. A push race (a concurrent write to the
 * branch) is retried once on a fresh base; failure is a disclosed note,
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
    const content = composeLedger(cwd, task, newRows, state);
    const blob = run('git', ['hash-object', '-w', '--stdin'], { input: content }).trim();
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-order-ledger-'));
    const indexFile = path.join(indexDir, 'index');
    try {
      const env = { GIT_INDEX_FILE: indexFile };
      // With a remote head: start from ITS tree and parent on it. Without
      // one: a fresh index (the ledger file becomes the whole tree) and no
      // parent at all — an orphan, so no local commit ever rides along.
      if (state) run('git', ['read-tree', state.head], { env });
      run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
      const tree = run('git', ['write-tree'], { env }).trim();
      const commit = run('git', [
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        'commit-tree',
        tree,
        ...(state ? ['-p', state.head] : []),
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
