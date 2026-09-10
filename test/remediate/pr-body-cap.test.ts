/**
 * The PR body stays under GitHub's cap, and a branch with no PR is never
 * reported as landed (#374).
 *
 * The live class: a fix-lint run rendered a 698-order ledger as the PR
 * body (688,909 bytes; GitHub caps a body at 65,536), `gh pr create`
 * failed, the helper answered `branch-pushed-no-pr` with a note naming the
 * cause, and the land CLI mapped a `landed` result without a PR URL to
 * "standing PR updated", exit 0. The branch existed, the PR did not, the
 * note was never printed.
 *
 * Pinned here, both directions per behavior:
 *   - the size DISCIPLINE (the renderer): a large run's body counts its
 *     kept recipe orders instead of listing them, and every line still
 *     exists in the committed run-ledger file the body names; a small
 *     run's body is the ledger verbatim plus the link;
 *   - the size GUARANTEE (the one guard at the gh boundary): a body that
 *     still exceeds the budget is cut, measured in BYTES, with a marker
 *     naming the full record, on `pr create` AND `pr edit`; a body that
 *     fits is byte-identical;
 *   - the no-PR outcome, through every consumer: the inline executor and
 *     the deferred `remediate land` CLI both print the note, exit non-zero,
 *     and write `landed: false` + `prMissing`, never a success line.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  capPrBody,
  PR_BODY_BUDGET_BYTES,
  PR_BODY_MAX_BYTES,
  utf8Bytes,
} from '../../src/pr/body-cap';
import { openOrUpdateStandingPr, type Exec } from '../../src/land-refresh';
import { renderRemediateLedger, renderRemediatePrBody } from '../../src/remediate/ledger-render';
import { PR_BODY_ORDER_LINE_THRESHOLD } from '../../src/remediate/ledger-render-orders';
import { landRemediateHead } from '../../src/remediate/land';
import { extractLedgerOutcome } from '../../src/remediate/standing-branch';
import { runLedgerPath, writeRunLedger } from '../../src/lanes/ledger';
import {
  executeTask,
  landExitClean,
  runRemediateLand,
  runRemediateLandCli,
  type ExecutorSeams,
} from '../../src/remediate/cli';
import {
  LANDING_RECORD_SCHEMA,
  landingRecordPath,
  writeLandingRecord,
  type LandingRecord,
} from '../../src/remediate/landing-record';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';
import type { RecipeOrderRecord } from '../../src/remediate/recipes/run-recipes';

const TASK = 'fix-lint';
const BRANCH = 'dxkit/remediate-fix-lint';
const NO_PR_NOTE =
  `Pushed '${BRANCH}' but could not open the PR (no gh CLI / not GitHub / no permission). ` +
  'Open the PR manually meanwhile: dxkit/remediate-fix-lint -> main.';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-prcap-'));
  dirs.push(dir);
  return dir;
}

// ─── synthetic ledgers ──────────────────────────────────────────────────────

function recipeRecord(i: number, kind: 'applied' | 'refused' | 'failed'): RecipeOrderRecord {
  const orderId = `lint-rule:no-unused-vars:file-${i}`;
  if (kind === 'applied') {
    return {
      orderId,
      class: 'lint-rule',
      recipe: 'lint-autofix',
      outcome: {
        kind: 'applied',
        changedFiles: [`src/module-${i}.ts`],
        notes: [`autofix removed ${i % 7} unused binding(s)`],
        revert: `git revert the order's commit (sha-${i})`,
      },
      disposition: { kind: 'kept', head: `kept-${i}` },
    };
  }
  if (kind === 'refused') {
    return {
      orderId,
      class: 'lint-rule',
      recipe: 'lint-autofix',
      outcome: {
        kind: 'refused',
        reason: i % 3 === 0 ? 'the rule has no autofix' : 'the file is outside the envelope',
      },
    };
  }
  return {
    orderId,
    class: 'lint-rule',
    recipe: 'lint-autofix',
    outcome: {
      kind: 'failed',
      step: 'verify',
      output: `the rule still reports after the fix in src/module-${i}.ts: ${'x'.repeat(160)}`,
    },
  };
}

function resultWith(records: readonly RecipeOrderRecord[]): RemediateResult {
  const base: Omit<RemediateResult, 'ledger'> = {
    outcome: 'verified',
    task: TASK,
    guardrailVerdict: 'PASSED',
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
    recipes: {
      ran: true,
      disclosures: [],
      selectedRecipeTier: records.length,
      selectedAgentTier: 0,
      records,
    },
  };
  return { ...base, ledger: renderRemediateLedger(base) };
}

function many(n: number, kind: 'applied' | 'refused' | 'failed'): RecipeOrderRecord[] {
  return Array.from({ length: n }, (_, i) => recipeRecord(i, kind));
}

/** A recording exec for the standing-PR mechanics: `gh pr create` answers
 *  with a URL unless told to fail; every git spawn succeeds silently. */
function recordingExec(opts: { createFails?: boolean } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return opts.createFails ? '' : 'https://example.test/pr/374';
    }
    return '';
  };
  return { exec, calls };
}

function bodyArg(call: string[] | undefined): string {
  if (!call) throw new Error('no gh call recorded');
  return call[call.indexOf('--body') + 1];
}

// ─── the hard guard ─────────────────────────────────────────────────────────

describe('capPrBody: the one size guard, measured in bytes', () => {
  it('a body under the budget is byte-identical, with no truncation reported', () => {
    const body = '## a\n\nline\n\n### b\n\nline';
    expect(capPrBody(body, { fullRecord: 'x' })).toEqual({ body });
  });

  it('cuts the LARGEST section from its tail, keeps its heading and every other section, and marks the cut', () => {
    const small = Array.from({ length: 20 }, (_, i) => `- small ${i}`).join('\n');
    const big = Array.from({ length: 3000 }, (_, i) => `- big line ${i} ${'y'.repeat(40)}`).join(
      '\n',
    );
    const body = `## Head\n\nintro\n\n### Small\n\n${small}\n\n### Big\n\n${big}\n\n### Verification\n\nGuardrail: **PASSED**`;
    expect(utf8Bytes(body)).toBeGreaterThan(PR_BODY_BUDGET_BYTES);
    const capped = capPrBody(body, { fullRecord: 'the committed ledger `x.md`' });
    expect(utf8Bytes(capped.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(capped.truncated).toEqual([
      { section: '### Big', droppedLines: expect.any(Number) as number },
    ]);
    expect(capped.body).toContain('### Big');
    expect(capped.body).toContain('- big line 0 ');
    expect(capped.body).not.toContain('- big line 2999 ');
    expect(capped.body).toMatch(
      /more lines omitted here .*the full record is the committed ledger `x\.md`/,
    );
    // Untouched sections survive whole, in order.
    expect(capped.body).toContain(small);
    expect(capped.body.endsWith('### Verification\n\nGuardrail: **PASSED**')).toBe(true);
    expect(capped.body.indexOf('### Small')).toBeLessThan(capped.body.indexOf('### Big'));
  });

  it('measures BYTES, not characters: a multi-byte body under 65,536 characters is still cut', () => {
    // 30,000 three-byte characters: 30,000 chars, 90,000 bytes.
    const lines = Array.from({ length: 300 }, () => '…'.repeat(100));
    const body = `## Head\n\n${lines.join('\n')}`;
    expect(body.length).toBeLessThan(PR_BODY_MAX_BYTES);
    expect(utf8Bytes(body)).toBeGreaterThan(PR_BODY_MAX_BYTES);
    const capped = capPrBody(body, { fullRecord: 'x' });
    expect(utf8Bytes(capped.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(capped.truncated).toBeDefined();
  });

  it('the guarantee holds for any input: a single oversized line, and an oversized HEADING (the last-resort byte cut at a character boundary)', () => {
    const oneLine = capPrBody(`## Head\n\n${'é'.repeat(80_000)}`, { fullRecord: 'x' });
    expect(utf8Bytes(oneLine.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(oneLine.body).toContain('## Head');
    expect(oneLine.body).toContain('1 more line omitted');
    expect(oneLine.truncated).toEqual([{ section: '## Head', droppedLines: 1 }]);
    // Nothing droppable is left once the heading itself is oversized: the
    // byte cut runs, ending on a whole character.
    const heading = capPrBody(`## ${'é'.repeat(80_000)}\n\nline`, { fullRecord: 'x' });
    expect(utf8Bytes(heading.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(heading.body).not.toContain('�');
    expect(heading.body).toContain('more line');
    expect(heading.truncated?.some((t) => t.section === '(body)')).toBe(true);
  });
});

// ─── the size discipline (the renderer) ─────────────────────────────────────

describe('renderRemediatePrBody: the summary the PR body carries', () => {
  it('a synthetic 1,000-order ledger renders a body under the cap that COUNTS the kept orders, names the committed file, and the full ledger has every line', () => {
    const r = resultWith(many(1000, 'applied'));
    const file = runLedgerPath('remediate', TASK);
    const body = renderRemediatePrBody(r, { ledgerFile: file });
    expect(utf8Bytes(r.ledger)).toBeGreaterThan(PR_BODY_MAX_BYTES); // the class
    expect(utf8Bytes(body)).toBeLessThan(PR_BODY_BUDGET_BYTES);
    expect(body).toContain('1000 applied recipe orders verified and KEPT');
    expect(body).not.toContain('file-999`');
    expect(body).toContain('1000 applied, 0 refused, 0 failed');
    expect(body).toContain(`committed on this branch at \`${file}\``);
    // The standing-branch reader still finds the outcome line.
    expect(extractLedgerOutcome(body)).toBe('verified');
    // The FULL ledger lists every order, one line each.
    for (const i of [0, 499, 999]) {
      expect(r.ledger).toContain(`\`lint-rule:no-unused-vars:file-${i}\` (lint-autofix): APPLIED`);
    }
    expect(r.ledger.split('\n').filter((l) => l.includes(': APPLIED,'))).toHaveLength(1000);
  });

  it('a small run (at or under the threshold) is the ledger verbatim plus the link line: unchanged apart from the link', () => {
    const r = resultWith(many(PR_BODY_ORDER_LINE_THRESHOLD, 'applied'));
    const body = renderRemediatePrBody(r, { ledgerFile: null });
    expect(body.startsWith(r.ledger)).toBe(true);
    expect(body).toContain('Full ledger');
    expect(body).toContain('job step summary');
    expect(body).toContain(`file-${PR_BODY_ORDER_LINE_THRESHOLD - 1}\``);
  });

  it('refused orders over the threshold are grouped by reason; failed orders are ALWAYS listed', () => {
    const r = resultWith([...many(300, 'refused'), ...many(30, 'failed')]);
    const body = renderRemediatePrBody(r, { ledgerFile: 'x.md' });
    expect(body).toContain('300 recipe orders refused');
    expect(body).toContain('- 200: the file is outside the envelope');
    expect(body).toContain('- 100: the rule has no autofix');
    expect(body).not.toContain('file-299` (lint-autofix): refused');
    for (let i = 0; i < 30; i += 1) {
      expect(body).toContain(`file-${i}\` (lint-autofix): FAILED at verify`);
    }
  });

  it('an applied order a reviewer must act on (dropped, envelope drop, invariant) is listed even when the kept majority is counted', () => {
    const records = many(200, 'applied');
    const dropped: RecipeOrderRecord = {
      ...recipeRecord(7, 'applied'),
      orderId: 'lint-rule:special:dropped',
      disposition: { kind: 'dropped', step: 'floor', reason: 'tsc failed net-new' },
    };
    const sprawl: RecipeOrderRecord = {
      ...recipeRecord(8, 'applied'),
      orderId: 'lint-rule:special:sprawl',
      droppedPaths: ['.github/workflows/ci.yml'],
    };
    const body = renderRemediatePrBody(resultWith([...records, dropped, sprawl]), {
      ledgerFile: 'x.md',
    });
    expect(body).toContain('200 applied recipe orders verified and KEPT');
    expect(body).toContain('`lint-rule:special:dropped`');
    expect(body).toContain('DROPPED at floor');
    expect(body).toContain('`lint-rule:special:sprawl`');
    expect(body).toContain('.github/workflows/ci.yml');
  });
});

// ─── the guard at the gh boundary, create AND edit ──────────────────────────

describe('openOrUpdateStandingPr: the same capped body reaches `pr create` and `pr edit`', () => {
  const oversized = renderRemediatePrBody(resultWith(many(1000, 'failed')), {
    ledgerFile: runLedgerPath('remediate', TASK),
  });

  it('a 1,000-failed-order body (nothing to collapse) is cut to the budget with the marker on create', () => {
    expect(utf8Bytes(oversized)).toBeGreaterThan(PR_BODY_MAX_BYTES);
    const { exec, calls } = recordingExec();
    const out = openOrUpdateStandingPr(exec, {
      branchName: BRANCH,
      defaultBranch: 'main',
      prTitle: 't',
      prBody: oversized,
      existing: null,
      fullRecord: 'the committed ledger `x.md`',
    });
    const body = bodyArg(calls.find((c) => c[0] === 'gh' && c[2] === 'create'));
    expect(utf8Bytes(body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(body).toContain('more lines omitted here');
    expect(body).toContain('the committed ledger `x.md`');
    expect(out.outcome).toBe('pr-opened');
    expect(out.bodyTruncated).toContain('65536-byte cap');
  });

  it('the same guard on edit; and a body that fits is byte-identical on both', () => {
    const { exec, calls } = recordingExec();
    openOrUpdateStandingPr(exec, {
      branchName: BRANCH,
      defaultBranch: 'main',
      prTitle: 't',
      prBody: oversized,
      existing: { url: 'https://example.test/pr/1' },
    });
    const edited = bodyArg(calls.find((c) => c[0] === 'gh' && c[2] === 'edit'));
    expect(utf8Bytes(edited)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(edited).toContain('job step summary'); // the default full-record name

    const small = renderRemediatePrBody(resultWith(many(3, 'applied')), { ledgerFile: null });
    for (const existing of [null, { url: 'https://example.test/pr/1' }]) {
      const rec = recordingExec();
      const out = openOrUpdateStandingPr(rec.exec, {
        branchName: BRANCH,
        defaultBranch: 'main',
        prTitle: 't',
        prBody: small,
        existing,
      });
      const call = rec.calls.find((c) => c[0] === 'gh' && (c[2] === 'create' || c[2] === 'edit'));
      expect(bodyArg(call)).toBe(small);
      expect(out.bodyTruncated).toBeUndefined();
    }
  });
});

// ─── the committed file rides the bookkeeping commit ────────────────────────

describe('the full ledger is committed on the branch', () => {
  it('writeRunLedger writes every line; the lander commits the file path-scoped with the other ledgers and names it to the size guard', () => {
    const cwd = tempRepo();
    const r = resultWith(many(1000, 'applied'));
    const rel = writeRunLedger(cwd, 'remediate', TASK, r.ledger);
    expect(rel).toBe(runLedgerPath('remediate', TASK));
    const onDisk = fs.readFileSync(path.join(cwd, rel!), 'utf8');
    expect(onDisk.split('\n').filter((l) => l.includes(': APPLIED,'))).toHaveLength(1000);

    const { exec, calls } = recordingExec();
    landRemediateHead({
      cwd,
      taskId: TASK,
      defaultBranch: 'main',
      outcome: 'verified',
      prTitle: 't',
      prBody: renderRemediatePrBody(r, { ledgerFile: rel }),
      ledgerPath: '.dxkit/lanes/remediate-fix-lint.jsonl',
      runLedgerPath: rel!,
      exec,
    });
    const commit = calls.find((c) => c[0] === 'git' && c.includes('commit'))!;
    expect(commit.slice(commit.indexOf('--') + 1)).toEqual([
      '.dxkit/lanes/remediate-fix-lint.jsonl',
      rel,
      '.dxkit/lanes/remediate-fix-lint.orders.jsonl',
    ]);
    const add = calls.find((c) => c[0] === 'git' && c[1] === 'add')!;
    expect(add).toContain(rel);
  });
});

// ─── a branch with no PR is not "landed" ────────────────────────────────────

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: [TASK],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'discard',
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

function seams(overrides: Partial<ExecutorSeams> = {}): ExecutorSeams {
  return {
    runTask: async () => resultWith(many(3, 'applied')),
    branch: () => 'main',
    defaultBranch: () => 'main',
    probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
    ...overrides,
  };
}

function attemptRecord(cwd: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, '.dxkit', 'cache', `remediate-${TASK}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function validLandRecord(cwd: string): LandingRecord {
  const runLedger = writeRunLedger(cwd, 'remediate', TASK, 'THE FULL LEDGER\n');
  return {
    schema: LANDING_RECORD_SCHEMA,
    task: TASK,
    action: 'land',
    branch: BRANCH,
    head: 'bbbb2222',
    baseHead: 'aaaa1111',
    outcome: 'verified',
    defaultBranch: 'main',
    prTitle: 'dxkit remediate: fix-lint',
    prBody: 'THE BODY',
    draft: false,
    ledgerPath: '.dxkit/lanes/remediate-fix-lint.jsonl',
    ...(runLedger ? { runLedgerPath: runLedger } : {}),
    orderRows: [],
  };
}

describe('branch-pushed-no-pr through every consumer', () => {
  it('inline executor: landed false, not clean, the note is the landing failure, prMissing set, and the run ledger was written', async () => {
    const cwd = tempRepo();
    const run = await executeTask(
      cwd,
      config(),
      TASK,
      'pr',
      seams({
        landHead: (o) => {
          // The executor handed the lander the committed run ledger.
          expect(o.runLedgerPath).toBe(runLedgerPath('remediate', TASK));
          return { outcome: 'branch-pushed-no-pr', branch: BRANCH, mode: 'pr', note: NO_PR_NOTE };
        },
      }),
    );
    expect(run.landed).toBe(false);
    expect(run.clean).toBe(false);
    expect(run.prUrl).toBeUndefined();
    expect(run.landedBranch).toBe(BRANCH);
    expect(run.prMissing).toBe(NO_PR_NOTE);
    expect(run.landingBlocked).toContain('could not open the PR');
    const record = attemptRecord(cwd);
    expect(record.landed).toBe(false);
    expect(record.prMissing).toBe(NO_PR_NOTE);
    expect(record.landingBlocked).toContain('Open the PR manually');
    expect(fs.existsSync(path.join(cwd, runLedgerPath('remediate', TASK)))).toBe(true);
    // Positive control: a landing WITH a PR still reads as landed.
    const ok = await executeTask(
      tempRepo(),
      config(),
      TASK,
      'pr',
      seams({
        landHead: () => ({
          outcome: 'pr-opened',
          branch: BRANCH,
          mode: 'pr',
          prUrl: 'https://example.test/pr/1',
        }),
      }),
    );
    expect(ok.landed).toBe(true);
    expect(ok.prMissing).toBeUndefined();
  });

  it('`remediate land` (the deferred path): outcome branch-pushed-no-pr, non-clean exit, attempt record landed false with prMissing, record cleared', () => {
    const cwd = tempRepo();
    writeLandingRecord(cwd, validLandRecord(cwd));
    fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'cache', `remediate-${TASK}.json`),
      JSON.stringify({ landed: false, task: TASK }),
      'utf8',
    );
    let landOpts: Record<string, unknown> | undefined;
    const out = runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: (o) => {
        landOpts = { ...o };
        return { outcome: 'branch-pushed-no-pr', branch: BRANCH, mode: 'pr', note: NO_PR_NOTE };
      },
    });
    expect(out.outcome).toBe('branch-pushed-no-pr');
    expect('note' in out && out.note).toBe(NO_PR_NOTE);
    expect(landExitClean(out)).toBe(false);
    expect(landOpts!.runLedgerPath).toBe(runLedgerPath('remediate', TASK));
    const record = attemptRecord(cwd);
    expect(record.landed).toBe(false);
    expect(record.prMissing).toBe(NO_PR_NOTE);
    expect(record.branch).toBe(BRANCH);
    expect(fs.existsSync(path.join(cwd, landingRecordPath(TASK)))).toBe(false);
  });

  it('end to end through runRemediateLandCli: the note is PRINTED as a failure, exit code 1, no success line', () => {
    const cwd = tempRepo();
    writeLandingRecord(cwd, validLandRecord(cwd));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      printed.push(String(line));
    });
    runRemediateLandCli(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => ({
        outcome: 'branch-pushed-no-pr',
        branch: BRANCH,
        mode: 'pr',
        note: NO_PR_NOTE,
      }),
    });
    expect(process.exitCode).toBe(1);
    const output = printed.join('\n');
    expect(output).toContain('not landed');
    expect(output).toContain('could not open the PR');
    expect(output).toContain('Open the PR manually');
    expect(output).not.toContain('PR updated');
    expect(output).not.toContain('✓');
  });

  it('positive control through the CLI: a landing with a PR prints the URL and exits clean', () => {
    const cwd = tempRepo();
    writeLandingRecord(cwd, validLandRecord(cwd));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      printed.push(String(line));
    });
    runRemediateLandCli(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => ({
        outcome: 'pr-opened',
        branch: BRANCH,
        mode: 'pr',
        prUrl: 'https://example.test/pr/374',
      }),
    });
    expect(process.exitCode).toBeUndefined();
    expect(printed.join('\n')).toContain('https://example.test/pr/374');
  });

  it('the landing record validates runLedgerPath like ledgerPath: a traversal path is refused before any push', () => {
    const cwd = tempRepo();
    fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, landingRecordPath(TASK)),
      JSON.stringify({ ...validLandRecord(cwd), runLedgerPath: '../outside/ledger.md' }),
      'utf8',
    );
    let pushed = false;
    const out = runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      landHead: () => {
        pushed = true;
        return { outcome: 'pr-opened', branch: BRANCH, mode: 'pr' };
      },
    });
    expect(pushed).toBe(false);
    expect(out.outcome).toBe('invalid-record');
  });
});
