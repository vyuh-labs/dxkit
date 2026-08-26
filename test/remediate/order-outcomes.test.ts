/**
 * Order-outcome rows (scheduler memory 3F): the projection from a run's
 * per-order records to ledger rows (committed work carries the RUN verdict;
 * refusals and infrastructure keep their own words; paused orders are
 * recorded as neutral rows), and the two durability channels: the landing
 * path's local composed file and the non-landing metadata commit pushed to
 * the standing branch with plumbing commands only (retry once on a race,
 * disclosed note on failure, never a crash).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  orderOutcomeRows,
  publishOrderRows,
  writeLocalOrderLedger,
  type OrderLedgerGitExec,
} from '../../src/remediate/order-outcomes';
import {
  orderLedgerPath,
  serializeOrderRows,
  type OrderOutcomeRow,
} from '../../src/lanes/order-ledger';
import type { RemediateResult } from '../../src/remediate/outcome';
import type { RecipePhaseSummary } from '../../src/remediate/recipes/run-recipes';

const META = {
  timestamp: '2026-08-25T00:00:00.000Z',
  stamp: { dxkitVersion: '4.4.5', policyHash: 'abc' },
};

function recipes(overrides: Partial<RecipePhaseSummary> = {}): RecipePhaseSummary {
  return {
    ran: true,
    disclosures: [],
    selectedRecipeTier: 0,
    selectedAgentTier: 0,
    records: [],
    ...overrides,
  };
}

function orderRecord(
  orderId: string,
  outcome: 'completed' | 'partial' | 'failed' | 'never-ran' | 'not-dispatched',
  extra: Record<string, unknown> = {},
) {
  return {
    orderId,
    class: 'dep-advisory',
    findings: 1,
    budget: { turns: 5, minutes: 5, usd: 1, derivation: 'x' },
    outcome,
    done: { verifier: 'guardrail' as const, absentIds: 1 },
    ...extra,
  };
}

describe('orderOutcomeRows (the projection)', () => {
  it('committed work carries the run verdict; refusals and infra keep their own words', () => {
    const result: Pick<RemediateResult, 'outcome' | 'recipes' | 'orders'> = {
      outcome: 'guardrail-red',
      recipes: recipes({
        records: [
          {
            orderId: 'r1',
            class: 'stale-lockfile',
            recipe: 'lockfile-sync',
            outcome: { kind: 'applied', changedFiles: ['package-lock.json'] },
          },
          {
            orderId: 'r2',
            class: 'dep-advisory',
            recipe: 'override-pin',
            outcome: { kind: 'refused', reason: 'no fixed version' },
          },
          {
            orderId: 'r3',
            class: 'lint-located',
            recipe: 'lint-autofix',
            outcome: { kind: 'failed', step: 'verify', output: 'ids still present' },
          },
        ],
        paused: [
          {
            orderId: 'p1',
            class: 'unresolved-import',
            tier: 'recipe',
            findings: 2,
            reason: 'streak',
            unpause: 'policy change',
          },
        ],
      }),
      orders: {
        cap: 3,
        queued: 3,
        records: [
          orderRecord('a1', 'completed', { spent: { turns: 9, costUsd: 0.5 } }),
          orderRecord('a2', 'never-ran', { detail: 'credit balance too low' }),
          orderRecord('a3', 'not-dispatched', { detail: 'beyond the cap' }),
        ],
      },
    };
    const rows = orderOutcomeRows(result, 'fix-vulns', META);
    const byId = new Map(rows.map((r) => [r.orderId, r]));
    expect(byId.get('r1')!.outcome).toBe('guardrail-red'); // applied, run blocked
    expect(byId.get('r1')!.tier).toBe('recipe');
    expect(byId.get('r2')!.outcome).toBe('refused');
    expect(byId.get('r3')!.outcome).toBe('failed-recipe');
    expect(byId.get('r3')!.detail).toContain('verify');
    expect(byId.get('a1')!.outcome).toBe('guardrail-red'); // completed, run blocked
    expect(byId.get('a1')!.spend).toEqual({ turns: 9, costUsd: 0.5 });
    expect(byId.get('a2')!.outcome).toBe('never-ran');
    expect(byId.get('a3')!.outcome).toBe('not-dispatched');
    expect(byId.get('p1')!.outcome).toBe('paused');
    // Every row carries the runner timestamp and the environment stamps.
    for (const r of rows) {
      expect(r.timestamp).toBe(META.timestamp);
      expect(r.dxkitVersion).toBe('4.4.5');
      expect(r.policyHash).toBe('abc');
      expect(r.task).toBe('fix-vulns');
    }
  });

  it('a verified run yields verified rows; budget-exhausted yields the verified-partial word', () => {
    const base = {
      recipes: recipes({
        records: [
          {
            orderId: 'r1',
            class: 'stale-lockfile',
            recipe: 'lockfile-sync',
            outcome: { kind: 'applied' as const, changedFiles: ['x'] },
          },
        ],
      }),
    };
    expect(orderOutcomeRows({ outcome: 'verified', ...base }, 't', META)[0].outcome).toBe(
      'verified',
    );
    expect(orderOutcomeRows({ outcome: 'budget-exhausted', ...base }, 't', META)[0].outcome).toBe(
      'budget-exhausted-verified',
    );
    expect(
      orderOutcomeRows(
        {
          outcome: 'agent-failed',
          orders: { cap: 1, queued: 1, records: [orderRecord('a1', 'failed')] },
        },
        't',
        META,
      )[0].outcome,
    ).toBe('agent-failed');
  });

  it('a run with no order records yields no rows (legacy path, refusals)', () => {
    expect(orderOutcomeRows({ outcome: 'refused' }, 't', META)).toEqual([]);
  });

  it('ONE terminal row per order: an agent attempt supersedes the recipe failure it fell through from', () => {
    const result: Pick<RemediateResult, 'outcome' | 'recipes' | 'orders'> = {
      outcome: 'verified',
      recipes: recipes({
        records: [
          {
            orderId: 'dep-advisory:x',
            class: 'dep-advisory',
            recipe: 'override-pin',
            outcome: { kind: 'failed', step: 'verify', output: 'still present' },
          },
        ],
      }),
      orders: {
        cap: 3,
        queued: 1,
        records: [
          {
            orderId: 'dep-advisory:x',
            class: 'dep-advisory',
            findings: 1,
            budget: { turns: 5, minutes: 5, usd: 1, derivation: 'x' },
            outcome: 'completed',
            done: { verifier: 'guardrail', absentIds: 1 },
          },
        ],
      },
    };
    const rows = orderOutcomeRows(result, 'fix-vulns', META);
    // The recipe failed, the agent fixed it in the SAME run: one row, the
    // terminal tier's verified outcome — a kept failure row would let the
    // breaker pause a class that is actively being fixed.
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe('agent');
    expect(rows[0].outcome).toBe('verified');
  });

  it('a NEUTRAL agent record (not dispatched, never ran) leaves the recipe evidence standing', () => {
    const result: Pick<RemediateResult, 'outcome' | 'recipes' | 'orders'> = {
      outcome: 'recipes-refused',
      recipes: recipes({
        records: [
          {
            orderId: 'dep-advisory:x',
            class: 'dep-advisory',
            recipe: 'override-pin',
            outcome: { kind: 'failed', step: 'verify', output: 'still present' },
          },
        ],
      }),
      orders: {
        cap: 0,
        queued: 1,
        records: [orderRecord('dep-advisory:x', 'not-dispatched', { detail: 'cap 0' })],
      },
    };
    const rows = orderOutcomeRows(result, 'fix-vulns', META);
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe('recipe');
    expect(rows[0].outcome).toBe('failed-recipe');
  });

  it('paused orders collapse to ONE bookkeeping marker per class per firing', () => {
    const result: Pick<RemediateResult, 'outcome' | 'recipes' | 'orders'> = {
      outcome: 'no-op',
      recipes: recipes({
        paused: [
          {
            orderId: 'lint-located:a',
            class: 'lint-located',
            tier: 'recipe',
            findings: 2,
            reason: 'streak',
            unpause: 'x',
          },
          {
            orderId: 'lint-located:b',
            class: 'lint-located',
            tier: 'agent',
            findings: 1,
            reason: 'streak',
            unpause: 'x',
          },
        ],
      }),
    };
    const rows = orderOutcomeRows(result, 'fix-lint', META);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('paused');
    expect(rows[0].detail).toContain('2 order(s) paused');
  });

  it("'score-red' (and every unlisted red) is classified breaker-NEUTRAL by the exhaustive verdict switch", () => {
    const rows = orderOutcomeRows(
      {
        outcome: 'score-red',
        recipes: recipes({
          records: [
            {
              orderId: 'r1',
              class: 'stale-lockfile',
              recipe: 'lockfile-sync',
              outcome: { kind: 'applied', changedFiles: ['x'] },
            },
          ],
        }),
      },
      't',
      META,
    );
    expect(rows[0].outcome).toBe('no-op');
  });
});

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-order-write-'));
}

const ROW: OrderOutcomeRow = {
  schema_version: 1,
  timestamp: '2026-08-25T00:00:00.000Z',
  lane: 'remediate',
  task: 'fix-vulns',
  orderId: 'dep-advisory:x',
  class: 'dep-advisory',
  tier: 'agent',
  outcome: 'guardrail-red',
  dxkitVersion: '4.4.5',
  policyHash: 'abc',
};

const BRANCH_ROW: OrderOutcomeRow = {
  ...ROW,
  timestamp: '2026-08-18T00:00:00.000Z',
  outcome: 'floor-red',
};

describe('writeLocalOrderLedger (landing channel)', () => {
  it('composes standing-branch rows + local rows + new rows into the local file, through the ONE branch read', () => {
    const cwd = tempCwd();
    const seen: string[] = [];
    const exec: OrderLedgerGitExec = (bin, args) => {
      seen.push(args[0]);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'head\n';
      if (args[0] === 'show') return serializeOrderRows([BRANCH_ROW]);
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const rel = writeLocalOrderLedger(cwd, 'fix-vulns', [ROW], exec);
    expect(rel).toBe(orderLedgerPath('remediate', 'fix-vulns'));
    const text = fs.readFileSync(path.join(cwd, rel!), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    // Oldest first: the branch's unmerged failure row survives the landing.
    expect(lines[0]).toContain('floor-red');
    expect(lines[1]).toContain('guardrail-red');
    // The read is the shared fetch/rev-parse/show sequence (Rule 2.30:
    // one branch-read function, no second fetch/show pair).
    expect(seen).toEqual(['fetch', 'rev-parse', 'show']);
  });

  it("carries a NEWER schema's rows through verbatim when rewriting the durable file", () => {
    const cwd = tempCwd();
    const futureLine = JSON.stringify({ ...ROW, schema_version: 99, futureField: 'kept' });
    const exec: OrderLedgerGitExec = (bin, args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'head\n';
      if (args[0] === 'show') return serializeOrderRows([BRANCH_ROW]) + futureLine + '\n';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const rel = writeLocalOrderLedger(cwd, 'fix-vulns', [ROW], exec);
    const text = fs.readFileSync(path.join(cwd, rel!), 'utf8');
    expect(text).toContain(futureLine);
    expect(text).toContain('floor-red');
    expect(text).toContain('guardrail-red');
  });

  it('an unreachable branch composes local + new rows only (fail-open)', () => {
    const cwd = tempCwd();
    const exec: OrderLedgerGitExec = () => {
      throw new Error('offline');
    };
    const rel = writeLocalOrderLedger(cwd, 'fix-vulns', [ROW], exec);
    const text = fs.readFileSync(path.join(cwd, rel!), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('no rows of its own and nothing on the branch means no write', () => {
    const offline: OrderLedgerGitExec = () => {
      throw new Error('offline');
    };
    expect(writeLocalOrderLedger(tempCwd(), 'fix-vulns', [], offline)).toBeNull();
  });

  it('no rows of its own still carries the standing branch rows into the landing (a force-push must not erase them)', () => {
    // A resume-attempt count or a prior red run lives only on the branch
    // until a landing composes it in; a landing that skipped the write
    // because it minted no rows erased that memory with its force-push.
    const cwd = tempCwd();
    const exec: OrderLedgerGitExec = (bin, args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'head\n';
      if (args[0] === 'show') return serializeOrderRows([BRANCH_ROW]);
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const rel = writeLocalOrderLedger(cwd, 'fix-vulns', [], exec);
    expect(rel).toBe(orderLedgerPath('remediate', 'fix-vulns'));
    const text = fs.readFileSync(path.join(cwd, rel!), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('floor-red');
  });
});

describe('publishOrderRows (non-landing channel)', () => {
  /** Scripted plumbing exec: answers each git call, records the sequence. */
  function plumbingExec(opts: { failPushes?: number; branchExists?: boolean }) {
    const calls: string[][] = [];
    let pushFailures = opts.failPushes ?? 0;
    const exec: OrderLedgerGitExec = (bin, args) => {
      calls.push([...args]);
      switch (args[0]) {
        case 'fetch':
          if (opts.branchExists === false) throw new Error('no such ref');
          return '';
        case 'rev-parse':
          return args[1] === 'FETCH_HEAD' ? 'branchhead\n' : 'checkouthead\n';
        case 'show':
          return serializeOrderRows([BRANCH_ROW]);
        case 'hash-object':
          return 'blobsha\n';
        case 'read-tree':
        case 'update-index':
          return '';
        case 'write-tree':
          return 'treesha\n';
        default:
          if (args.includes('commit-tree')) return 'commitsha\n';
          if (args.includes('push')) {
            if (pushFailures > 0) {
              pushFailures -= 1;
              throw new Error('rejected (fetch first)');
            }
            return '';
          }
          throw new Error(`unexpected ${args.join(' ')}`);
      }
    };
    return { exec, calls };
  }

  it('builds a metadata commit on the branch head and pushes it (no working-tree involvement)', () => {
    const cwd = tempCwd();
    const { exec, calls } = plumbingExec({});
    const out = publishOrderRows(cwd, 'fix-vulns', [ROW], exec);
    expect(out.published).toBe(true);
    const push = calls.find((c) => c.includes('push'))!;
    expect(push).toContain('--no-verify');
    expect(push).toContain('commitsha:refs/heads/dxkit/remediate-fix-vulns');
    const commitTree = calls.find((c) => c.includes('commit-tree'))!;
    expect(commitTree).toContain('branchhead'); // parent is the BRANCH head, a draft is preserved
    const cacheinfo = calls.find((c) => c[0] === 'update-index')!;
    expect(cacheinfo[3]).toContain(orderLedgerPath('remediate', 'fix-vulns'));
  });

  it('with no reachable standing branch, the commit is an ORPHAN over the ledger file only: no local commit becomes reachable', () => {
    const cwd = tempCwd();
    const { exec, calls } = plumbingExec({ branchExists: false });
    const out = publishOrderRows(cwd, 'fix-vulns', [ROW], exec);
    expect(out.published).toBe(true);
    const commitTree = calls.find((c) => c.includes('commit-tree'))!;
    // No parent at all (orphan), and no read of a local ref: the local
    // history on a non-landing path is unverified content and must never
    // become reachable from the remote through the ledger push.
    expect(commitTree).not.toContain('-p');
    expect(commitTree.join(' ')).not.toContain('checkouthead');
    expect(calls.some((c) => c[0] === 'rev-parse' && c[1] === 'HEAD')).toBe(false);
    expect(calls.some((c) => c[0] === 'read-tree')).toBe(false);
    const push = calls.find((c) => c.includes('push'))!;
    expect(push).toContain('commitsha:refs/heads/dxkit/remediate-fix-vulns');
  });

  it('with a standing branch, the commit parents ONLY on the fetched remote head, never local HEAD', () => {
    const cwd = tempCwd();
    const { exec, calls } = plumbingExec({});
    publishOrderRows(cwd, 'fix-vulns', [ROW], exec);
    const commitTree = calls.find((c) => c.includes('commit-tree'))!;
    const parents = commitTree.filter((_, i) => commitTree[i - 1] === '-p');
    expect(parents).toEqual(['branchhead']);
    expect(calls.some((c) => c[0] === 'rev-parse' && c[1] === 'HEAD')).toBe(false);
    const readTree = calls.find((c) => c[0] === 'read-tree')!;
    expect(readTree[1]).toBe('branchhead');
  });

  it('retries ONCE on a push race and succeeds on the fresh base', () => {
    const cwd = tempCwd();
    const { exec, calls } = plumbingExec({ failPushes: 1 });
    const out = publishOrderRows(cwd, 'fix-vulns', [ROW], exec);
    expect(out.published).toBe(true);
    expect(calls.filter((c) => c.includes('push'))).toHaveLength(2);
  });

  it('a persistent failure is a disclosed note, never a crash', () => {
    const cwd = tempCwd();
    const { exec } = plumbingExec({ failPushes: 5 });
    const out = publishOrderRows(cwd, 'fix-vulns', [ROW], exec);
    expect(out.published).toBe(false);
    expect(out.note).toContain('dxkit/remediate-fix-vulns');
    expect(out.note).toContain('circuit breaker');
  });
});
