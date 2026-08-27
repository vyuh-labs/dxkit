/**
 * Two-phase landing (4.4.7): the credential-freshness root fix.
 *
 * The live class: App installation tokens are hard-capped at one hour, and
 * the task's verify phases scale with repo size, so the landing push fired
 * 68 minutes after mint and 401'd: landing, salvage draft, and the
 * order-outcome ledger ALL lost. The root fix decouples credential
 * freshness from task duration: under the workflow's deferred-landing
 * signal the executor performs NO pushes (it writes ONE landing record),
 * and `remediate land` (a post-task step under a freshly minted token)
 * validates the record and performs every deferred push.
 *
 * Pinned here, both directions per behavior:
 *   - deferred: env set → no push attempted, one record written (the
 *     salvage draft defers through the SAME record, one code path);
 *   - inline: env absent → the immediate landing is unchanged;
 *   - the land CLI: validate → push; a stale HEAD refuses (never pushes
 *     stale or foreign commits); success clears the record (idempotent);
 *     a tampered record is refused before any spawn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTask, runRemediateLand, type ExecutorSeams } from '../../src/remediate/cli';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';
import {
  clearLandingRecord,
  DEFERRED_LANDING_ENV,
  LANDING_RECORD_SCHEMA,
  landingRecordPath,
  readLandingRecord,
  writeLandingRecord,
  type LandingRecord,
} from '../../src/remediate/landing-record';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-2phase-'));
  dirs.push(dir);
  return dir;
}

/** Run git in a fixture repo, trimmed stdout. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A real single-commit git repo (the head-advance proof needs real git). */
function gitRepo(): string {
  const cwd = tempRepo();
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
  git(cwd, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a', 'utf8');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-qm', 'base']);
  return cwd;
}

function config(salvage: RemediateConfig['salvage'] = 'discard'): RemediateConfig {
  return {
    enabled: true,
    tasks: ['write-docs'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage,
    agent: { driver: 'claude-code', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    maxOrdersPerRun: 0,
    pauseAfterFailures: 0,
    resume: false,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

function result(
  outcome: RemediateResult['outcome'],
  extra: Partial<RemediateResult> = {},
): RemediateResult {
  return {
    outcome,
    task: 'write-docs',
    ledger: 'THE VERIFICATION LEDGER',
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
    ...extra,
  };
}

function resultWithOrders(outcome: RemediateResult['outcome']): RemediateResult {
  return result(outcome, {
    orders: {
      cap: 3,
      queued: 1,
      records: [
        {
          orderId: 'dep-advisory:x',
          class: 'dep-advisory',
          findings: 1,
          budget: { turns: 5, minutes: 5, usd: 1, derivation: 'd' },
          outcome: 'completed',
          done: { verifier: 'guardrail', absentIds: 1 },
        },
      ],
    },
  });
}

const DEFERRED_ENV = { [DEFERRED_LANDING_ENV]: '1' };

function seams(overrides: Partial<ExecutorSeams> = {}): ExecutorSeams {
  return {
    runTask: async () => result('verified'),
    branch: () => 'main',
    defaultBranch: () => 'main',
    landHead: () => ({
      outcome: 'pr-opened' as const,
      mode: 'pr' as const,
      prUrl: 'https://example.test/pr/1',
    }),
    probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
    ...overrides,
  };
}

function readRecordFile(cwd: string): LandingRecord {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, landingRecordPath('write-docs')), 'utf8'),
  ) as LandingRecord;
}

function attemptRecord(cwd: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, '.dxkit', 'cache', 'remediate-write-docs.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function validLandRecord(overrides: Partial<LandingRecord> = {}): LandingRecord {
  return {
    schema: LANDING_RECORD_SCHEMA,
    task: 'write-docs',
    action: 'land',
    branch: 'dxkit/remediate-write-docs',
    head: 'bbbb2222',
    baseHead: 'aaaa1111',
    outcome: 'verified',
    defaultBranch: 'main',
    prTitle: 'dxkit remediate: write-docs',
    prBody: 'THE BODY',
    draft: false,
    ledgerPath: '.dxkit/lanes/remediate-write-docs.jsonl',
    orderRows: [],
    ...overrides,
  };
}

describe('landing record: write / read / validate', () => {
  it('round-trips a valid record', () => {
    const cwd = tempRepo();
    writeLandingRecord(cwd, validLandRecord());
    const read = readLandingRecord(cwd, 'write-docs');
    expect(read).not.toBeNull();
    expect(read && 'record' in read && read.record.prTitle).toBe('dxkit remediate: write-docs');
  });

  it('no record file reads as null (nothing was deferred)', () => {
    expect(readLandingRecord(tempRepo(), 'write-docs')).toBeNull();
  });

  it('refuses a tampered or foreign record, naming the reason (never pushes what it cannot validate)', () => {
    const cases: Array<[string, Partial<LandingRecord>]> = [
      ['a redirected branch', { branch: 'refs/heads/main' }],
      ['a non-hex head', { head: 'HEAD@{1}' }],
      ['a missing head', { head: null }],
      ['a traversal ledger path', { ledgerPath: '../outside/x.jsonl' }],
      ['an absolute ledger path', { ledgerPath: '/etc/passwd' }],
      ['a flag-shaped default branch', { defaultBranch: '--force' }],
      ['an unknown action', { action: 'exec' as unknown as LandingRecord['action'] }],
      ['a foreign schema', { schema: 'remediate-landing.v9' as typeof LANDING_RECORD_SCHEMA }],
      ['non-array order rows', { orderRows: 'rows' as unknown as LandingRecord['orderRows'] }],
    ];
    for (const [label, bad] of cases) {
      const cwd = tempRepo();
      // Written raw: writeLandingRecord types would reject some of these.
      fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, landingRecordPath('write-docs')),
        JSON.stringify({ ...validLandRecord(), ...bad }),
        'utf8',
      );
      const read = readLandingRecord(cwd, 'write-docs');
      expect(read && 'error' in read, `${label} must be refused`).toBe(true);
      if (read && 'error' in read) expect(read.error).toContain('re-run the task');
    }
  });

  it("refuses a record written for a DIFFERENT task (a record cannot land under another task's name)", () => {
    const cwd = tempRepo();
    fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, landingRecordPath('write-docs')),
      JSON.stringify(validLandRecord({ task: 'fix-lint' })),
      'utf8',
    );
    const read = readLandingRecord(cwd, 'write-docs');
    expect(read && 'error' in read).toBe(true);
  });

  it('refuses an invalid requested task id before touching the filesystem', () => {
    const read = readLandingRecord(tempRepo(), '../evil');
    expect(read && 'error' in read).toBe(true);
  });

  it('the WRITE side applies the same task-id guard: an invalid id never shapes a path', () => {
    const cwd = tempRepo();
    expect(() => writeLandingRecord(cwd, validLandRecord({ task: '../evil' }))).toThrow(
      /invalid task id/,
    );
    // clear with an invalid id is a no-op, never a path build.
    writeLandingRecord(cwd, validLandRecord());
    clearLandingRecord(cwd, '../evil');
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(true);
    clearLandingRecord(cwd, 'write-docs');
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(false);
  });
});

describe('executor under deferred landing (env set => no push, one record)', () => {
  it('a verified run defers: no lander call, no row publish, the record carries the assembled PR', async () => {
    const cwd = tempRepo();
    let pushed = false;
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        env: DEFERRED_ENV,
        runTask: async () => resultWithOrders('verified'),
        landHead: () => {
          pushed = true;
          return { outcome: 'pr-opened', mode: 'pr' };
        },
        writeOrderLedger: () => {
          pushed = true; // the compose reads the standing branch, deferred too
          return null;
        },
        publishOrderRows: () => {
          pushed = true;
          return { published: true };
        },
      }),
    );
    expect(pushed).toBe(false);
    expect(run.landed).toBe(false);
    expect(run.clean).toBe(true); // verified; the land step carries landing truth
    expect(run.landingDeferred).toContain('remediate land');
    const record = readRecordFile(cwd);
    expect(record.action).toBe('land');
    expect(record.head).toBe('bbbb2222'); // currentHead falls back to the result head off-git
    expect(record.prTitle).toBe('dxkit remediate: write-docs');
    expect(record.prBody).toContain('THE VERIFICATION LEDGER');
    expect(record.draft).toBe(false);
    expect(record.defaultBranch).toBe('main');
    expect(record.orderRows).toHaveLength(1);
    expect(record.ledgerPath).toContain('.dxkit/lanes/');
    // The attempt record discloses the deferral and stays landed:false
    // until the land step flips it.
    const attempt = attemptRecord(cwd);
    expect(attempt.landed).toBe(false);
    expect(String(attempt.landingDeferred)).toContain('remediate land');
  });

  it('the salvage draft defers through the SAME record (one code path), draft flag carried', async () => {
    const cwd = tempRepo();
    let pushed = false;
    const run = await executeTask(
      cwd,
      config('draft-pr'),
      'write-docs',
      'pr',
      seams({
        env: DEFERRED_ENV,
        runTask: async () => result('budget-exhausted'),
        landHead: () => {
          pushed = true;
          return { outcome: 'pr-opened', mode: 'pr' };
        },
      }),
    );
    expect(pushed).toBe(false);
    expect(run.clean).toBe(true); // a recorded budget-bounded draft, same as a landed one
    const record = readRecordFile(cwd);
    expect(record.action).toBe('land');
    expect(record.draft).toBe(true);
    expect(record.prTitle).toContain('(partial, budget-bounded)');
  });

  it('a non-landing outcome defers its order rows instead of pushing the metadata commit', async () => {
    const cwd = tempRepo();
    let published = false;
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        env: DEFERRED_ENV,
        runTask: async () => resultWithOrders('guardrail-red'),
        publishOrderRows: () => {
          published = true;
          return { published: true };
        },
      }),
    );
    expect(published).toBe(false);
    expect(run.landed).toBe(false);
    const record = readRecordFile(cwd);
    expect(record.action).toBe('publish-rows');
    expect(record.orderRows).toHaveLength(1);
    expect((record.orderRows[0] as { outcome: string }).outcome).toBe('guardrail-red');
  });

  it('inline direction: env absent => the immediate landing is unchanged and no record exists', async () => {
    const cwd = tempRepo();
    let pushed = false;
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        env: {},
        landHead: () => {
          pushed = true;
          return { outcome: 'pr-opened', mode: 'pr', prUrl: 'https://example.test/pr/1' };
        },
      }),
    );
    expect(pushed).toBe(true);
    expect(run.landed).toBe(true);
    expect(run.landingDeferred).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(false);
  });
});

describe('remediate land (phase two)', () => {
  it('no record is a disclosed no-op', () => {
    const out = runRemediateLand(tempRepo(), 'write-docs');
    expect(out.outcome).toBe('no-record');
    expect('note' in out && out.note).toContain('nothing to land');
  });

  it('executor record => land: validates HEAD, composes the ledger, pushes, patches the attempt record, clears the record; a re-run is then a no-op', async () => {
    const cwd = tempRepo();
    // Phase one: a deferred verified run writes the record.
    await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({ env: DEFERRED_ENV, runTask: async () => resultWithOrders('verified') }),
    );
    // Phase two: the fresh-credential step.
    let landOpts: Record<string, unknown> | undefined;
    let composedRows: unknown[] | undefined;
    const out = runRemediateLand(cwd, 'write-docs', {
      head: () => 'bbbb2222',
      writeOrderLedger: (_cwd, _task, rows) => {
        composedRows = [...rows];
        return '.dxkit/lanes/remediate-write-docs.orders.jsonl';
      },
      landHead: (opts) => {
        landOpts = { ...opts };
        return { outcome: 'pr-opened', mode: 'pr', prUrl: 'https://example.test/pr/9' };
      },
    });
    expect(out.outcome).toBe('landed');
    expect('prUrl' in out && out.prUrl).toBe('https://example.test/pr/9');
    // The compose (standing-branch read) happened at land time, under the
    // fresh credential, with this run's recorded rows.
    expect(composedRows).toHaveLength(1);
    expect(landOpts!.prTitle).toBe('dxkit remediate: write-docs');
    expect(String(landOpts!.prBody)).toContain('THE VERIFICATION LEDGER');
    expect(landOpts!.orderLedgerPath).toBe('.dxkit/lanes/remediate-write-docs.orders.jsonl');
    expect(landOpts!.defaultBranch).toBe('main');
    // The workflow's evidence step reads the attempt record: now landed.
    const attempt = attemptRecord(cwd);
    expect(attempt.landed).toBe(true);
    expect(attempt.prUrl).toBe('https://example.test/pr/9');
    // Idempotent: the record is cleared, a re-run is a disclosed no-op.
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(false);
    const again = runRemediateLand(cwd, 'write-docs', {
      landHead: () => {
        throw new Error('must not be called');
      },
    });
    expect(again.outcome).toBe('no-record');
  });

  it('a moved HEAD refuses with the remedy named: stale or foreign commits are never pushed', () => {
    const cwd = tempRepo();
    writeLandingRecord(cwd, validLandRecord());
    let pushed = false;
    const out = runRemediateLand(cwd, 'write-docs', {
      head: () => 'cccc3333',
      landHead: () => {
        pushed = true;
        return { outcome: 'pr-opened', mode: 'pr' };
      },
      writeOrderLedger: () => null,
    });
    expect(pushed).toBe(false);
    expect(out.outcome).toBe('stale-head');
    expect('error' in out && out.error).toContain('re-run the task');
    // The record survives for inspection.
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(true);
  });

  it('a tampered record refuses before any push', () => {
    const cwd = tempRepo();
    fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, landingRecordPath('write-docs')),
      JSON.stringify(validLandRecord({ branch: 'main' })),
      'utf8',
    );
    let pushed = false;
    const out = runRemediateLand(cwd, 'write-docs', {
      head: () => 'bbbb2222',
      landHead: () => {
        pushed = true;
        return { outcome: 'pr-opened', mode: 'pr' };
      },
    });
    expect(pushed).toBe(false);
    expect(out.outcome).toBe('invalid-record');
  });

  it('a failed push publishes the recorded rows through the metadata channel anyway (the breaker still sees the run), disclosed', () => {
    // Inline parity: execute.ts calls publishRows() inside its landHead
    // catch, and the A1 failure classes are exactly the runs whose rows
    // the breaker most needs. The deferred path must do the same.
    const cwd = tempRepo();
    const rows = [
      { task: 'write-docs', orderId: 'o1' } as unknown as LandingRecord['orderRows'][number],
    ];
    writeLandingRecord(cwd, validLandRecord({ orderRows: rows }));
    let publishedRows: unknown[] | undefined;
    const out = runRemediateLand(cwd, 'write-docs', {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      publishRows: (_cwd, _task, r) => {
        publishedRows = [...r];
        return { published: true };
      },
      landHead: () => {
        throw Object.assign(new Error('git push exited 1'), {
          stderr: 'remote: error: GH013: Repository rule violations found',
        });
      },
    });
    expect(out.outcome).toBe('landing-failed');
    expect(publishedRows).toHaveLength(1);
    expect('error' in out && out.error).toContain('GH013');
    expect('error' in out && out.error).toContain('circuit breaker sees this run');
    // Failure direction: the fallback itself failing is also disclosed.
    const cwd2 = tempRepo();
    writeLandingRecord(cwd2, validLandRecord({ orderRows: rows }));
    const out2 = runRemediateLand(cwd2, 'write-docs', {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      publishRows: () => ({ published: false, note: 'metadata push refused' }),
      landHead: () => {
        throw new Error('git push exited 1');
      },
    });
    expect(out2.outcome).toBe('landing-failed');
    expect('error' in out2 && out2.error).toContain('also could not be recorded');
    expect('error' in out2 && out2.error).toContain('metadata push refused');
  });

  it('a failed push advances the expected head ONLY over its own bookkeeping commit (git-proven), and a retry then lands', () => {
    const cwd = gitRepo();
    const headA = git(cwd, ['rev-parse', 'HEAD']);
    const ledgerRel = '.dxkit/lanes/remediate-write-docs.jsonl';
    writeLandingRecord(cwd, validLandRecord({ head: headA, ledgerPath: ledgerRel }));
    let attempts = 0;
    const seamsUsed = {
      writeOrderLedger: () => null,
      landHead: () => {
        attempts += 1;
        if (attempts === 1) {
          // The real lander commits its bookkeeping BEFORE the push: one
          // commit atop the verified head touching only the ledger path.
          fs.mkdirSync(path.join(cwd, path.dirname(ledgerRel)), { recursive: true });
          fs.writeFileSync(path.join(cwd, ledgerRel), '{}\n', 'utf8');
          git(cwd, ['add', ledgerRel]);
          git(cwd, ['commit', '-qm', 'chore: ledger', '--', ledgerRel]);
          throw Object.assign(new Error('git push exited 1'), {
            stderr: 'remote: error: GH013: Repository rule violations found',
          });
        }
        return { outcome: 'pr-opened' as const, mode: 'pr' as const, prUrl: 'https://x/pr/1' };
      },
    };
    const out = runRemediateLand(cwd, 'write-docs', seamsUsed);
    expect(out.outcome).toBe('landing-failed');
    const headB = git(cwd, ['rev-parse', 'HEAD']);
    const kept = readRecordFile(cwd);
    expect(kept.head).toBe(headB);
    expect(kept.headAdvancedNote).toContain('bookkeeping commit');
    // The retry validates against the advanced head and lands.
    const retry = runRemediateLand(cwd, 'write-docs', seamsUsed);
    expect(retry.outcome).toBe('landed');
  });

  it('a FOREIGN commit never advances the expected head: the record stays put and the retry refuses as stale', () => {
    const cwd = gitRepo();
    const headA = git(cwd, ['rev-parse', 'HEAD']);
    writeLandingRecord(
      cwd,
      validLandRecord({ head: headA, ledgerPath: '.dxkit/lanes/remediate-write-docs.jsonl' }),
    );
    const seamsUsed = {
      writeOrderLedger: () => null,
      landHead: () => {
        // A commit touching a SOURCE file: not this step's bookkeeping.
        fs.writeFileSync(path.join(cwd, 'evil.ts'), 'x', 'utf8');
        git(cwd, ['add', 'evil.ts']);
        git(cwd, ['commit', '-qm', 'foreign', '--', 'evil.ts']);
        throw new Error('git push exited 1');
      },
    };
    const out = runRemediateLand(cwd, 'write-docs', seamsUsed);
    expect(out.outcome).toBe('landing-failed');
    const kept = readRecordFile(cwd);
    expect(kept.head).toBe(headA); // unchanged: the delta is not provably ours
    expect(kept.headAdvancedNote).toBeUndefined();
    // The retry refuses: HEAD is the foreign commit, not the verified head.
    let pushed = false;
    const retry = runRemediateLand(cwd, 'write-docs', {
      writeOrderLedger: () => null,
      landHead: () => {
        pushed = true;
        return { outcome: 'pr-opened', mode: 'pr' };
      },
    });
    expect(pushed).toBe(false);
    expect(retry.outcome).toBe('stale-head');
  });

  it('publish-rows records push the metadata commit and clear; a publish failure keeps the record (warn, not a lane failure)', async () => {
    const cwd = tempRepo();
    await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({ env: DEFERRED_ENV, runTask: async () => resultWithOrders('guardrail-red') }),
    );
    let publishedRows: unknown[] | undefined;
    const out = runRemediateLand(cwd, 'write-docs', {
      publishRows: (_cwd, _task, rows) => {
        publishedRows = [...rows];
        return { published: true };
      },
    });
    expect(out.outcome).toBe('rows-published');
    expect(publishedRows).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, landingRecordPath('write-docs')))).toBe(false);

    // Failure direction: the record survives for a retry.
    const cwd2 = tempRepo();
    await executeTask(
      cwd2,
      config(),
      'write-docs',
      'pr',
      seams({ env: DEFERRED_ENV, runTask: async () => resultWithOrders('guardrail-red') }),
    );
    const failed = runRemediateLand(cwd2, 'write-docs', {
      publishRows: () => ({ published: false, note: 'remote said no' }),
    });
    expect(failed.outcome).toBe('rows-publish-failed');
    expect('note' in failed && failed.note).toContain('remote said no');
    expect(fs.existsSync(path.join(cwd2, landingRecordPath('write-docs')))).toBe(true);
  });
});
