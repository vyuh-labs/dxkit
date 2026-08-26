/**
 * The work-order outcome ledger (scheduler memory, remediate rethink 3F):
 * row parsing is fail-open per line and per schema, the local reader sees
 * only order files, merging dedupes across channels, the window bounds by
 * age and per-class count, and the ONE history reader composes local +
 * standing-branch rows with disclosed (never silent) degradations. Plus
 * the compatibility pin: the DELIVERY ledger reader never ingests order
 * rows, and vice versa.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ORDER_FAILURE_OUTCOMES,
  ORDER_LEDGER_SCHEMA_VERSION,
  ORDER_SUCCESS_OUTCOMES,
  boundOrderWindow,
  existingRemoteBranches,
  mergeOrderRows,
  orderHistory,
  orderLedgerPath,
  parseLedgerText,
  parseOrderRows,
  readLocalOrderRows,
  realOrderLedgerExec,
  serializeOrderRows,
  type OrderOutcomeRow,
} from '../../src/lanes/order-ledger';
import { readLaneEvents } from '../../src/lanes/ledger';

function row(overrides: Partial<OrderOutcomeRow> = {}): OrderOutcomeRow {
  return {
    schema_version: ORDER_LEDGER_SCHEMA_VERSION,
    timestamp: '2026-08-20T00:00:00.000Z',
    lane: 'remediate',
    task: 'fix-vulns',
    orderId: 'dep-advisory:lodash',
    class: 'dep-advisory',
    tier: 'recipe',
    outcome: 'guardrail-red',
    dxkitVersion: '4.4.5',
    policyHash: 'abc',
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-order-ledger-test-'));
}

describe('row parsing and files', () => {
  it('parses valid rows, skips corrupt lines and rows from a NEWER schema', () => {
    const text =
      serializeOrderRows([row()]) +
      'not json at all\n' +
      JSON.stringify({ ...row(), schema_version: ORDER_LEDGER_SCHEMA_VERSION + 1 }) +
      '\n' +
      JSON.stringify({ hello: 'world' }) +
      '\n';
    const rows = parseOrderRows(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe('dep-advisory:lodash');
    // The WRITER's view keeps what the reader skipped, verbatim: a newer
    // schema's row and a corrupt line are foreign lines, never data loss.
    const split = parseLedgerText(text);
    expect(split.rows).toHaveLength(1);
    expect(split.foreign).toHaveLength(3);
    expect(split.foreign.some((l) => l.includes('"schema_version":2'))).toBe(true);
  });

  it('readLocalOrderRows reads only *.orders.jsonl files in the lanes dir', () => {
    const cwd = tempDir();
    const rel = orderLedgerPath('remediate', 'fix-vulns');
    expect(rel).toBe('.dxkit/lanes/remediate-fix-vulns.orders.jsonl');
    fs.mkdirSync(path.join(cwd, '.dxkit', 'lanes'), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), serializeOrderRows([row()]));
    // A delivery-ledger file in the same directory is NOT an order file.
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'lanes', 'remediate-fix-vulns.jsonl'),
      JSON.stringify({
        schema_version: 1,
        timestamp: '2026-08-20T00:00:00.000Z',
        lane: 'remediate',
        outcome: 'landed',
      }) + '\n',
    );
    expect(readLocalOrderRows(cwd)).toHaveLength(1);
    // COMPATIBILITY, both directions: the delivery reader must not ingest
    // order rows (no order outcome is 'landed'), and the order reader must
    // not ingest delivery events (file suffix).
    expect(readLaneEvents(cwd)).toHaveLength(1);
    expect(readLaneEvents(cwd)[0].outcome).toBe('landed');
  });

  it('the outcome vocabulary keeps the breaker sets disjoint', () => {
    for (const o of ORDER_FAILURE_OUTCOMES) expect(ORDER_SUCCESS_OUTCOMES.has(o)).toBe(false);
  });
});

describe('merge + window', () => {
  it('mergeOrderRows dedupes on (task, orderId, tier, timestamp) across channels, oldest first', () => {
    const a = row({ timestamp: '2026-08-01T00:00:00.000Z' });
    const b = row({ timestamp: '2026-08-02T00:00:00.000Z', outcome: 'verified' });
    const merged = mergeOrderRows([b, a], [a], [b]);
    expect(merged).toHaveLength(2);
    expect(merged[0].timestamp < merged[1].timestamp).toBe(true);
  });

  it('TIER is part of the row identity: a recipe row and an agent row for one order in one run both survive', () => {
    // One run stamps one timestamp; a recipe-failed order the agent then
    // fixed carries two rows — first-wins on a tier-less key would keep
    // the failure and lose the fix.
    const failed = row({ tier: 'recipe', outcome: 'failed-recipe' });
    const fixed = row({ tier: 'agent', outcome: 'verified' });
    const merged = mergeOrderRows([failed], [fixed]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.outcome).sort()).toEqual(['failed-recipe', 'verified']);
  });

  it('bookkeeping rows never evict the failure evidence: the per-class cap counts outcome rows and neutral rows separately', () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const failure = row({ timestamp: '2026-08-01T00:00:00.000Z', outcome: 'guardrail-red' });
    const pausedFlood = Array.from({ length: 10 }, (_, i) =>
      row({
        timestamp: `2026-08-${String(2 + i).padStart(2, '0')}T00:00:00.000Z`,
        orderId: `p${i}`,
        outcome: 'paused',
      }),
    );
    const bounded = boundOrderWindow([failure, ...pausedFlood], {
      now,
      windowDays: 60,
      maxPerClass: 3,
    });
    // The single counted failure row survives ANY number of paused
    // markers; the markers are capped on their own budget.
    expect(bounded.filter((r) => r.outcome === 'guardrail-red')).toHaveLength(1);
    expect(bounded.filter((r) => r.outcome === 'paused')).toHaveLength(3);
  });

  it('boundOrderWindow drops rows older than the window and caps rows per class (newest kept)', () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const old = row({ timestamp: '2026-01-01T00:00:00.000Z' });
    const recent = Array.from({ length: 5 }, (_, i) =>
      row({ timestamp: `2026-08-2${i}T00:00:00.000Z`, orderId: `o${i}` }),
    );
    const other = row({ class: 'lint-located', timestamp: '2026-08-24T00:00:00.000Z' });
    const bounded = boundOrderWindow([old, ...recent, other], {
      now,
      windowDays: 60,
      maxPerClass: 3,
    });
    expect(bounded.some((r) => r.timestamp === old.timestamp)).toBe(false);
    expect(bounded.filter((r) => r.class === 'dep-advisory')).toHaveLength(3);
    expect(bounded.filter((r) => r.class === 'dep-advisory').map((r) => r.orderId)).toEqual([
      'o2',
      'o3',
      'o4',
    ]);
    expect(bounded.filter((r) => r.class === 'lint-located')).toHaveLength(1);
  });

  it('a row with an unparseable timestamp is dropped by the window, never a crash', () => {
    const bounded = boundOrderWindow([row({ timestamp: 'not-a-date' })], {
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(bounded).toHaveLength(0);
  });
});

describe('orderHistory (the ONE reader)', () => {
  const branchSource = {
    branch: 'dxkit/remediate-fix-vulns',
    file: orderLedgerPath('remediate', 'fix-vulns'),
  };

  it('merges local committed rows with a standing branch copy (deduped), bounded', () => {
    const cwd = tempDir();
    const localRow = row({ timestamp: '2026-08-20T00:00:00.000Z' });
    const branchOnly = row({ timestamp: '2026-08-22T00:00:00.000Z', outcome: 'floor-red' });
    fs.mkdirSync(path.join(cwd, '.dxkit', 'lanes'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, orderLedgerPath('remediate', 'fix-vulns')),
      serializeOrderRows([localRow]),
    );
    const exec = (bin: string, args: readonly string[]): string => {
      if (args[0] === 'ls-remote') {
        return `sha\trefs/heads/${branchSource.branch}\n`;
      }
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'branchhead\n';
      if (args[0] === 'show') return serializeOrderRows([localRow, branchOnly]);
      throw new Error(`unexpected: ${bin} ${args.join(' ')}`);
    };
    const history = orderHistory(cwd, {
      branches: [branchSource],
      exec,
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(history.rows).toHaveLength(2);
    expect(history.disclosures).toEqual([]);
  });

  it('an unreachable remote is a DISCLOSED absence with local rows still read', () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, '.dxkit', 'lanes'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, orderLedgerPath('remediate', 'fix-vulns')),
      serializeOrderRows([row({ timestamp: '2026-08-20T00:00:00.000Z' })]),
    );
    const exec = () => {
      throw new Error('no remote');
    };
    const history = orderHistory(cwd, {
      branches: [branchSource],
      exec,
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(history.rows).toHaveLength(1);
    expect(history.disclosures.some((d) => d.includes('no remote reachable'))).toBe(true);
  });

  it('an ABSENT standing branch is normal (empty history), not a disclosure', () => {
    const cwd = tempDir();
    const exec = (bin: string, args: readonly string[]): string => {
      if (args[0] === 'ls-remote') return ''; // remote reachable, branch absent
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const history = orderHistory(cwd, { branches: [branchSource], exec });
    expect(history.rows).toEqual([]);
    expect(history.disclosures).toEqual([]);
  });

  it('a branch that exists but cannot be fetched is disclosed by name', () => {
    const cwd = tempDir();
    const exec = (bin: string, args: readonly string[]): string => {
      if (args[0] === 'ls-remote') return `sha\trefs/heads/${branchSource.branch}\n`;
      throw new Error('fetch refused');
    };
    const history = orderHistory(cwd, { branches: [branchSource], exec });
    expect(history.disclosures.some((d) => d.includes(branchSource.branch))).toBe(true);
  });

  it('the real exec is the ONE hardened machine git-exec factory (no-prompt env, stdin support)', () => {
    const exec = realOrderLedgerExec(process.cwd());
    expect(exec('sh', ['-c', 'printf "%s" "$GIT_TERMINAL_PROMPT"'])).toBe('0');
    expect(exec('sh', ['-c', 'printf "%s" "$GIT_SSH_COMMAND"'])).toContain('BatchMode=yes');
    expect(exec('cat', [], { input: 'stdin works' })).toBe('stdin works');
    expect(exec('sh', ['-c', 'printf "%s" "$DXKIT_X"'], { env: { DXKIT_X: 'layered' } })).toBe(
      'layered',
    );
  });

  it('existingRemoteBranches parses ls-remote output and null-signals a failed probe', () => {
    const okExec = () => 'aaa\trefs/heads/dxkit/remediate-fix-vulns\nbbb\trefs/heads/other\n';
    expect([...existingRemoteBranches(['dxkit/remediate-fix-vulns'], okExec)!]).toContain(
      'dxkit/remediate-fix-vulns',
    );
    expect(
      existingRemoteBranches(['x'], () => {
        throw new Error('offline');
      }),
    ).toBeNull();
    expect([...existingRemoteBranches([], okExec)!]).toEqual([]);
  });
});
