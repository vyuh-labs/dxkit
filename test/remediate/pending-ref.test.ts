/**
 * Un-landed verified work is DURABLE (#375): the pending ref.
 *
 * The live class: the task step verified its work and wrote the landing
 * record; the fresh-credential land step's `ls-remote` proof answered
 * "Repository not found" (transient) and died before `remediate land` ran.
 * The record and the verified commits lived only on the runner; the next
 * scheduled run started fresh and never re-landed them.
 *
 * Pinned here, both directions per behavior, on REAL git with a bare
 * origin (the plumbing-built pending commit and the re-land's fetch /
 * detach / restore are the load-bearing parts):
 *   - the task step pushes the verified head + ONE record commit to the
 *     pending ref right after the record is written, HEAD never moves,
 *     and a failed push is disclosed with the artifact fallback;
 *   - a successful `remediate land` deletes the ref the record names (the
 *     one deleter); a failed one keeps it and says where the work is;
 *   - `--preflight-failed` yields the ONE `landing-blocked:` phrasing,
 *     pushes nothing, and reaches the annotation + run summary;
 *   - the next run's plan step re-lands a VALID pending ref through the
 *     same lander (shallow checkout included), skips an invalid one with
 *     the reason, discloses a re-land that fails again, and always puts
 *     the checkout back where it was;
 *   - the branch TRIPLE is what the preflight and the delivery prober
 *     probe (one home).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTask, runRemediateLand, type ExecutorSeams } from '../../src/remediate/cli';
import { runRemediateLandCli } from '../../src/remediate/land-cli';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';
import {
  DEFERRED_LANDING_ENV,
  LANDING_RECORD_SCHEMA,
  landingRecordPath,
  parseLandingRecord,
  pendingLandingRecordPath,
  readLandingRecord,
  writeLandingRecord,
  type LandingRecord,
} from '../../src/remediate/landing-record';
import {
  deletePendingRef,
  landingArtifactName,
  pushPendingRef,
} from '../../src/remediate/pending-ref';
import { relandPendingWork } from '../../src/remediate/pending-reland';
import { runRemediatePlan } from '../../src/remediate/plan-cli';
import {
  describePendingPreservation,
  describePreflightFailure,
} from '../../src/remediate/attempt-record';
import { landingPreflightRefusal } from '../../src/remediate/landing-preflight';
import { remediateBranchesFor, remediatePendingBranchFor } from '../../src/lanes/branches';
import { standingLaneBranches } from '../../src/lanes/delivery-preconditions';
import { REMEDIATE_TASKS } from '../../src/remediate/tasks';
import { makeExec } from '../../src/land-refresh';

const TASK = 'write-docs';
const PENDING = remediatePendingBranchFor(TASK);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dxkit-pending-${label}-`));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A working repo on `main` with a bare origin holding the same commit. */
function repoWithOrigin(): { cwd: string; origin: string } {
  const origin = tempDir('origin');
  // HEAD on main, as a hosted origin's is (a depth-1 clone needs it).
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  const cwd = tempDir('work');
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
  git(cwd, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n', 'utf8');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-qm', 'base']);
  // A second commit, so a depth-1 clone of origin is genuinely shallow.
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'aa\n', 'utf8');
  git(cwd, ['commit', '-qam', 'base 2']);
  git(cwd, ['remote', 'add', 'origin', origin]);
  git(cwd, ['push', '-q', 'origin', 'main']);
  return { cwd, origin };
}

const LEDGER = `.dxkit/lanes/remediate-${TASK}.jsonl`;
const RUN_LEDGER = `.dxkit/lanes/remediate-${TASK}.ledger.md`;

/** Simulate a task step: the agent's commit (the verified head) plus the
 *  UNCOMMITTED ledger files the executor writes into the tree. */
function verifiedWork(cwd: string): string {
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'agent work\n', 'utf8');
  git(cwd, ['add', 'b.txt']);
  git(cwd, ['commit', '-qm', 'agent: the fix']);
  fs.mkdirSync(path.join(cwd, '.dxkit', 'lanes'), { recursive: true });
  fs.writeFileSync(path.join(cwd, LEDGER), '{"outcome":"landed"}\n', 'utf8');
  fs.writeFileSync(path.join(cwd, RUN_LEDGER), '# ledger\n', 'utf8');
  return git(cwd, ['rev-parse', 'HEAD']);
}

function record(head: string, overrides: Partial<LandingRecord> = {}): LandingRecord {
  return {
    schema: LANDING_RECORD_SCHEMA,
    task: TASK,
    action: 'land',
    branch: `dxkit/remediate-${TASK}`,
    head,
    outcome: 'verified',
    defaultBranch: 'main',
    prTitle: `dxkit remediate: ${TASK}`,
    prBody: 'THE BODY',
    draft: false,
    ledgerPath: LEDGER,
    runLedgerPath: RUN_LEDGER,
    orderRows: [],
    ...overrides,
  };
}

function originRef(origin: string, ref: string): string | null {
  try {
    return git(origin, ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]);
  } catch {
    return null;
  }
}

const landed = (prUrl = 'https://example.test/pr/9') => ({
  outcome: 'pr-opened' as const,
  branch: `dxkit/remediate-${TASK}`,
  mode: 'pr' as const,
  prUrl,
});

describe('pushPendingRef: the task step preserves the verified head (#375)', () => {
  it('pushes ONE record commit atop the verified head carrying the record + the ledger files; HEAD never moves', () => {
    const { cwd, origin } = repoWithOrigin();
    const head = verifiedWork(cwd);
    const rec = record(head);
    const out = pushPendingRef(cwd, rec);
    expect(out.pushed).toBe(true);
    if (!out.pushed) return;
    expect(out.ref).toBe(PENDING);
    // The remote holds the tip; its parent is the verified head; it carries
    // exactly the record + the two ledger files the task step wrote.
    expect(originRef(origin, PENDING)).toBe(out.tip);
    expect(git(origin, ['rev-parse', `${out.tip}^`])).toBe(head);
    const files = git(origin, ['diff-tree', '--no-commit-id', '--name-only', '-r', out.tip])
      .split('\n')
      .sort();
    expect(files).toEqual([pendingLandingRecordPath(TASK), LEDGER, RUN_LEDGER].sort());
    const committed = git(origin, ['show', `${out.tip}:${pendingLandingRecordPath(TASK)}`]);
    const parsed = parseLandingRecord(committed, TASK, 'origin');
    expect('record' in parsed && parsed.record.head).toBe(head);
    expect(git(origin, ['show', `${out.tip}:${LEDGER}`])).toBe('{"outcome":"landed"}');
    // The checkout is untouched: HEAD is still the verified head, the
    // ledger files are still uncommitted (the lander commits them).
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(cwd, ['status', '--porcelain', '--', '.dxkit'])).toContain('?? .dxkit/');
    // Force semantics: a second run rebuilds the ref, never piles.
    const again = pushPendingRef(cwd, record(head, { prBody: 'REBUILT' }));
    expect(again.pushed).toBe(true);
    if (again.pushed) expect(originRef(origin, PENDING)).toBe(again.tip);
  });

  it('a push that fails is disclosed, never thrown, and a rows-only record has nothing to preserve', () => {
    const { cwd } = repoWithOrigin();
    const head = verifiedWork(cwd);
    git(cwd, ['remote', 'set-url', 'origin', path.join(tempDir('gone'), 'missing.git')]);
    const out = pushPendingRef(cwd, record(head));
    expect(out.pushed).toBe(false);
    if (!out.pushed) expect(out.note.length).toBeGreaterThan(0);
    const rows = pushPendingRef(cwd, record(head, { action: 'publish-rows' }));
    expect(rows.pushed).toBe(false);
  });

  it('deletePendingRef retires the ref; a missing remote answers false, never throws', () => {
    const { cwd, origin } = repoWithOrigin();
    const head = verifiedWork(cwd);
    const out = pushPendingRef(cwd, record(head));
    expect(out.pushed).toBe(true);
    expect(deletePendingRef(cwd, PENDING)).toBe(true);
    expect(originRef(origin, PENDING)).toBeNull();
    git(cwd, ['remote', 'set-url', 'origin', path.join(tempDir('gone'), 'missing.git')]);
    expect(deletePendingRef(cwd, PENDING)).toBe(false);
  });
});

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

function verified(): RemediateResult {
  return {
    outcome: 'verified',
    task: TASK,
    ledger: 'THE VERIFICATION LEDGER',
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
  };
}

function seams(overrides: Partial<ExecutorSeams> = {}): ExecutorSeams {
  return {
    runTask: async () => verified(),
    branch: () => 'main',
    defaultBranch: () => 'main',
    landHead: () => landed(),
    probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
    env: { [DEFERRED_LANDING_ENV]: '1' },
    ...overrides,
  };
}

describe('executor under deferred landing: the pending push follows the record (#375)', () => {
  it('pushes right AFTER the record exists; the record on disk names the ref and the disclosure says where the work is', async () => {
    const cwd = tempDir('exec');
    let recordExistedAtPush = false;
    let pushedRecord: LandingRecord | undefined;
    const run = await executeTask(
      cwd,
      config(),
      TASK,
      'pr',
      seams({
        pushPending: (c, rec) => {
          recordExistedAtPush = fs.existsSync(path.join(c, landingRecordPath(TASK)));
          pushedRecord = rec;
          return { pushed: true, ref: PENDING, tip: 'cccc3333' };
        },
      }),
    );
    expect(recordExistedAtPush).toBe(true);
    expect(pushedRecord?.head).toBe('bbbb2222');
    expect(pushedRecord?.prBody).toContain('THE VERIFICATION LEDGER');
    const read = readLandingRecord(cwd, TASK);
    expect(read && 'record' in read && read.record.pendingRef).toBe(PENDING);
    expect(run.landingDeferred).toContain(`preserved on '${PENDING}'`);
    expect(run.landingDeferred).toContain('re-lands it');
  });

  it('a failed push is disclosed with the artifact fallback and the record carries no ref', async () => {
    const cwd = tempDir('exec');
    const run = await executeTask(
      cwd,
      config(),
      TASK,
      'pr',
      seams({ pushPending: () => ({ pushed: false, ref: PENDING, note: 'remote refused' }) }),
    );
    expect(run.landingDeferred).toContain('could NOT be preserved');
    expect(run.landingDeferred).toContain('remote refused');
    expect(run.landingDeferred).toContain(landingArtifactName(TASK));
    const read = readLandingRecord(cwd, TASK);
    expect(read && 'record' in read && read.record.pendingRef).toBeUndefined();
  });

  it('the Actions run URL rides the record when the ambient env names one', async () => {
    const cwd = tempDir('exec');
    await executeTask(
      cwd,
      config(),
      TASK,
      'pr',
      seams({
        env: {
          [DEFERRED_LANDING_ENV]: '1',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'acme/repo',
          GITHUB_RUN_ID: '42',
        },
        pushPending: () => ({ pushed: false, ref: PENDING, note: 'n/a' }),
      }),
    );
    const read = readLandingRecord(cwd, TASK);
    expect(read && 'record' in read && read.record.runUrl).toBe(
      'https://github.com/acme/repo/actions/runs/42',
    );
  });
});

describe('remediate land: the ONE deleter, and the blocked-landing disclosures (#375)', () => {
  it('a successful landing deletes the ref the record names', () => {
    const cwd = tempDir('land');
    writeLandingRecord(cwd, record('bbbb2222', { pendingRef: PENDING }));
    const deleted: string[] = [];
    const out = runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => landed(),
      deletePendingRef: (_cwd, ref) => {
        deleted.push(ref);
        return true;
      },
    });
    expect(out.outcome).toBe('landed');
    expect(deleted).toEqual([PENDING]);
    // No ref recorded: nothing to delete.
    writeLandingRecord(cwd, record('bbbb2222'));
    deleted.length = 0;
    runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => landed(),
      deletePendingRef: (_cwd, ref) => {
        deleted.push(ref);
        return true;
      },
    });
    expect(deleted).toEqual([]);
  });

  it('a failed push keeps the ref and names it as where the verified work survives', () => {
    const cwd = tempDir('land');
    writeLandingRecord(cwd, record('bbbb2222', { pendingRef: PENDING }));
    let deleted = false;
    const out = runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => {
        throw new Error('git push exited 1');
      },
      deletePendingRef: () => {
        deleted = true;
        return true;
      },
    });
    expect(out.outcome).toBe('landing-failed');
    expect(deleted).toBe(false);
    expect('error' in out && out.error).toContain(`verified work preserved on '${PENDING}'`);
    expect('error' in out && out.error).toContain('the next run re-lands it');
    // Without a ref, the artifact is the only copy, said so.
    writeLandingRecord(cwd, record('bbbb2222'));
    const noRef = runRemediateLand(cwd, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: () => {
        throw new Error('git push exited 1');
      },
    });
    expect('error' in noRef && noRef.error).toContain(landingArtifactName(TASK));
  });

  it('--preflight-failed: the ONE landing-blocked phrasing, nothing pushed, record kept, attempt record patched', () => {
    const cwd = tempDir('land');
    writeLandingRecord(cwd, record('bbbb2222', { pendingRef: PENDING }));
    fs.writeFileSync(
      path.join(cwd, '.dxkit', 'cache', `remediate-${TASK}.json`),
      JSON.stringify({ landed: false }),
      'utf8',
    );
    let pushed = false;
    const lastError = "remote: Repository not found.\nfatal: repository 'https://x/y/' not found";
    const out = runRemediateLand(
      cwd,
      TASK,
      {
        head: () => 'bbbb2222',
        writeOrderLedger: () => null,
        landHead: () => {
          pushed = true;
          return landed();
        },
        deletePendingRef: () => {
          pushed = true;
          return true;
        },
      },
      { attempts: 3, lastError },
    );
    expect(pushed).toBe(false);
    expect(out.outcome).toBe('landing-blocked');
    const why = describePreflightFailure(3, lastError);
    expect(why).toBe(
      'landing-blocked: credential preflight failed after 3 attempts (remote: Repository not found.)',
    );
    expect('error' in out && out.error.startsWith(why)).toBe(true);
    expect('error' in out && out.error).toContain(describePendingPreservation(PENDING, why));
    expect(fs.existsSync(path.join(cwd, landingRecordPath(TASK)))).toBe(true);
    const attempt = JSON.parse(
      fs.readFileSync(path.join(cwd, '.dxkit', 'cache', `remediate-${TASK}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(attempt.landed).toBe(false);
    expect(String(attempt.landingBlocked)).toContain(why);
    // A rows-only record under a failed preflight: the breaker loss is named.
    writeLandingRecord(cwd, record('bbbb2222', { action: 'publish-rows' }));
    const rows = runRemediateLand(cwd, TASK, {}, { attempts: 3, lastError });
    expect(rows.outcome).toBe('landing-blocked');
    expect('error' in rows && rows.error).toContain('circuit breaker will not see this run');
  });

  it('the CLI wrapper puts a blocked landing on the run page (annotation) and in the run summary, exit 1', () => {
    const cwd = tempDir('land');
    writeLandingRecord(cwd, record('bbbb2222', { pendingRef: PENDING }));
    const summary = path.join(tempDir('summary'), 'summary.md');
    const prevActions = process.env.GITHUB_ACTIONS;
    const prevSummary = process.env.GITHUB_STEP_SUMMARY;
    const prevExit = process.exitCode;
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_STEP_SUMMARY = summary;
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      runRemediateLandCli(
        cwd,
        TASK,
        { head: () => 'bbbb2222' },
        { attempts: 3, lastError: 'boom' },
      );
    } finally {
      spy.mockRestore();
      process.env.GITHUB_ACTIONS = prevActions;
      process.env.GITHUB_STEP_SUMMARY = prevSummary;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
    const why = describePreflightFailure(3, 'boom');
    expect(chunks.join('')).toContain(`::error::remediate ${TASK} did not land: ${why}`);
    const written = fs.readFileSync(summary, 'utf8');
    expect(written).toContain(`## dxkit remediate: ${TASK} did not land`);
    expect(written).toContain(why);
    expect(written).toContain(describePendingPreservation(PENDING, why));
  });

  it('the validator cross-checks the pending ref: a foreign ref name is refused', () => {
    const cwd = tempDir('land');
    fs.mkdirSync(path.join(cwd, '.dxkit', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, landingRecordPath(TASK)),
      JSON.stringify(record('bbbb2222', { pendingRef: 'refs/heads/main' })),
      'utf8',
    );
    const read = readLandingRecord(cwd, TASK);
    expect(read && 'error' in read && read.error).toContain("is not the task's pending ref");
    fs.writeFileSync(
      path.join(cwd, landingRecordPath(TASK)),
      JSON.stringify(record('bbbb2222', { runUrl: 'javascript:alert(1)' })),
      'utf8',
    );
    const url = readLandingRecord(cwd, TASK);
    expect(url && 'error' in url && url.error).toContain('runUrl');
  });
});

/** A prior run: verified work pushed to the pending ref, then the runner
 *  is gone. The next run checks out ORIGIN's main, which never saw the
 *  agent's commit, so local main is reset to it and the tree is clean. */
function priorRunLeftPending(cwd: string): { head: string; tip: string } {
  const head = verifiedWork(cwd);
  const out = pushPendingRef(
    cwd,
    record(head, { runUrl: 'https://github.com/acme/repo/actions/runs/7' }),
  );
  if (!out.pushed) throw new Error(out.note);
  fs.rmSync(path.join(cwd, '.dxkit'), { recursive: true, force: true });
  git(cwd, ['checkout', '-q', 'main']);
  git(cwd, ['reset', '-q', '--hard', 'origin/main']);
  return { head, tip: out.tip };
}

describe('the next run re-lands a pending ref before planning (#375)', () => {
  it('a VALID ref lands through remediate land: detached at the verified head, ledgers restored, PR body discloses, ref deleted, checkout restored', () => {
    const { cwd, origin } = repoWithOrigin();
    const { head } = priorRunLeftPending(cwd);
    expect(git(cwd, ['rev-parse', 'HEAD'])).not.toBe(head);
    let seen: { head: string; ledger: string; runLedger: boolean; prBody: string } | undefined;
    const out = relandPendingWork(cwd, [TASK], {
      writeOrderLedger: () => null,
      landHead: (opts) => {
        seen = {
          head: git(cwd, ['rev-parse', 'HEAD']),
          ledger: fs.readFileSync(path.join(cwd, LEDGER), 'utf8'),
          runLedger: fs.existsSync(path.join(cwd, RUN_LEDGER)),
          prBody: opts.prBody,
        };
        return landed('https://example.test/pr/12');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('relanded');
    if (out[0].outcome === 'relanded') expect(out[0].prUrl).toBe('https://example.test/pr/12');
    // The lander saw exactly what an in-run landing sees: the verified
    // head checked out, the task step's ledger files back in the tree.
    expect(seen?.head).toBe(head);
    expect(seen?.ledger).toBe('{"outcome":"landed"}\n');
    expect(seen?.runLedger).toBe(true);
    // The PR body opens with the ONE preservation phrasing + the run URL.
    expect(seen?.prBody.startsWith("> verified work preserved on '" + PENDING + "'")).toBe(true);
    expect(seen?.prBody).toContain('https://github.com/acme/repo/actions/runs/7');
    expect(seen?.prBody).toContain('THE BODY');
    // Retired: the ref is gone from origin, the runtime record cleared,
    // and the checkout is back on main.
    expect(originRef(origin, PENDING)).toBeNull();
    expect(fs.existsSync(path.join(cwd, landingRecordPath(TASK)))).toBe(false);
    expect(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    // Idempotent: nothing pending now, nothing reported.
    expect(relandPendingWork(cwd, [TASK], { landHead: () => landed() })).toEqual([]);
  });

  it('a SHALLOW checkout (the CI plan job) re-lands the same way, fetching only the tip and its parent', () => {
    const { cwd, origin } = repoWithOrigin();
    const { head } = priorRunLeftPending(cwd);
    const shallow = tempDir('shallow');
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, shallow], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(shallow, ['config', 'user.email', 'test@example.invalid']);
    git(shallow, ['config', 'user.name', 'test']);
    expect(git(shallow, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    let seenHead: string | undefined;
    const out = relandPendingWork(shallow, [TASK], {
      writeOrderLedger: () => null,
      landHead: () => {
        seenHead = git(shallow, ['rev-parse', 'HEAD']);
        return landed();
      },
    });
    expect(out[0]?.outcome).toBe('relanded');
    expect(seenHead).toBe(head);
    expect(originRef(origin, PENDING)).toBeNull();
    expect(git(shallow, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('an INVALID ref is skipped with the reason and left in place: no record, a piled tip, a tampered record', () => {
    // No record at the tip (someone pushed a plain commit there).
    const a = repoWithOrigin();
    const headA = verifiedWork(a.cwd);
    git(a.cwd, ['push', '-q', '-f', 'origin', `${headA}:refs/heads/${PENDING}`]);
    fs.rmSync(path.join(a.cwd, '.dxkit'), { recursive: true, force: true });
    git(a.cwd, ['reset', '-q', '--hard', 'origin/main']);
    let pushed = false;
    const noRecord = relandPendingWork(a.cwd, [TASK], {
      landHead: () => {
        pushed = true;
        return landed();
      },
    });
    expect(noRecord[0]?.outcome).toBe('skipped');
    expect(noRecord[0] && 'reason' in noRecord[0] && noRecord[0].reason).toContain(
      'carries no landing record',
    );
    expect(originRef(a.origin, PENDING)).toBe(headA);
    expect(git(a.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');

    // A tip that is NOT one record commit atop the recorded head (piled).
    const b = repoWithOrigin();
    const { tip } = priorRunLeftPending(b.cwd);
    git(b.cwd, ['checkout', '-q', '--detach', tip]);
    fs.writeFileSync(path.join(b.cwd, 'c.txt'), 'pile\n', 'utf8');
    git(b.cwd, ['add', 'c.txt']);
    git(b.cwd, ['commit', '-qm', 'piled on']);
    const piled = git(b.cwd, ['rev-parse', 'HEAD']);
    git(b.cwd, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${PENDING}`]);
    git(b.cwd, ['checkout', '-q', 'main']);
    const piledOut = relandPendingWork(b.cwd, [TASK], {
      landHead: () => {
        pushed = true;
        return landed();
      },
    });
    expect(piledOut[0]?.outcome).toBe('skipped');
    expect(piledOut[0] && 'reason' in piledOut[0] && piledOut[0].reason).toContain(
      'is not one record commit atop the verified head',
    );
    expect(originRef(b.origin, PENDING)).toBe(piled);

    // A record that fails the ONE validator (a redirected branch).
    const c = repoWithOrigin();
    const headC = verifiedWork(c.cwd);
    const bad = pushPendingRef(c.cwd, record(headC, { branch: 'main' }));
    expect(bad.pushed).toBe(true);
    fs.rmSync(path.join(c.cwd, '.dxkit'), { recursive: true, force: true });
    git(c.cwd, ['reset', '-q', '--hard', 'origin/main']);
    const tampered = relandPendingWork(c.cwd, [TASK], {
      landHead: () => {
        pushed = true;
        return landed();
      },
    });
    expect(tampered[0]?.outcome).toBe('skipped');
    expect(tampered[0] && 'reason' in tampered[0] && tampered[0].reason).toContain(
      'failed validation',
    );
    expect(pushed).toBe(false);
  });

  it('a re-land that fails again is disclosed, the ref stays, the checkout is restored', () => {
    const { cwd, origin } = repoWithOrigin();
    const { tip } = priorRunLeftPending(cwd);
    const out = relandPendingWork(cwd, [TASK], {
      writeOrderLedger: () => null,
      landHead: () => {
        throw Object.assign(new Error('git push exited 1'), {
          stderr: 'remote: error: GH013: Repository rule violations found',
        });
      },
    });
    expect(out[0]?.outcome).toBe('failed');
    expect(out[0] && 'reason' in out[0] && out[0].reason).toContain('did NOT land');
    expect(originRef(origin, PENDING)).toBe(tip);
    expect(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    // Clean: no restored ledger left behind, no runtime record (the ref is
    // the retry's source of truth), nothing staged.
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(cwd, landingRecordPath(TASK)))).toBe(false);
  });

  it('an unlistable remote is disclosed as unprobeable, never as "nothing pending"', () => {
    const out = relandPendingWork(tempDir('plain'), [TASK], {
      exec: (bin, args) => {
        if (bin === 'git' && args[0] === 'ls-remote') throw new Error('no remote');
        return '';
      },
    });
    expect(out).toEqual([
      {
        task: TASK,
        ref: PENDING,
        outcome: 'unprobeable',
        reason: expect.stringContaining('ls-remote'),
      },
    ]);
  });

  it('remediate plan --reland-pending runs the re-land first and reports it in the JSON; without the flag it touches nothing', async () => {
    const repo = tempDir('plan');
    fs.mkdirSync(path.join(repo, '.dxkit', 'baselines'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
    fs.writeFileSync(
      path.join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ remediate: { enabled: true, tasks: [TASK] } }),
    );
    const capture = async (opts: Parameters<typeof runRemediatePlan>[1]) => {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        await runRemediatePlan(repo, opts);
      } finally {
        spy.mockRestore();
      }
      return JSON.parse(chunks.join('')) as Record<string, unknown>;
    };
    let probed = 0;
    const relandSeams = {
      exec: (bin: string, args: readonly string[]) => {
        if (bin === 'git' && args[0] === 'ls-remote') {
          probed += 1;
          throw new Error('offline');
        }
        return '';
      },
    };
    const on = await capture({ json: true, relandPending: true, relandSeams });
    expect(on.pendingLandings).toEqual([
      expect.objectContaining({ task: TASK, ref: PENDING, outcome: 'unprobeable' }),
    ]);
    expect(probed).toBe(1);
    const off = await capture({ json: true, relandSeams });
    expect(off.pendingLandings).toEqual([]);
    expect(probed).toBe(1);
  });
});

describe('the branch TRIPLE is one home: preflight and prober see the pending ref', () => {
  it('remediateBranchesFor names all three, and every consumer probes them', () => {
    const triple = remediateBranchesFor(TASK);
    expect(triple).toEqual({
      standing: `dxkit/remediate-${TASK}`,
      attempt: `dxkit/remediate-${TASK}-attempt`,
      pending: PENDING,
    });
    for (const t of REMEDIATE_TASKS) {
      expect(standingLaneBranches()).toContain(remediatePendingBranchFor(t.id));
    }
    let probedBranches: readonly string[] | undefined;
    const refusal = landingPreflightRefusal(tempDir('pre'), TASK, {
      probeDelivery: (_cwd, opts) => {
        probedBranches = opts?.branches;
        return { probes: [], anyBlocked: false, unverifiable: false };
      },
    });
    expect(refusal).toBeNull();
    expect(probedBranches).toEqual([triple.standing, triple.attempt, triple.pending]);
  });

  it('a blocked pending ref never refuses the run (it only costs the durable copy, disclosed)', () => {
    const triple = remediateBranchesFor(TASK);
    const refusal = landingPreflightRefusal(tempDir('pre'), TASK, {
      probeDelivery: () => ({
        probes: [
          { branch: triple.pending, verdict: 'blocked', evidence: 'a creation rule', remedy: 'x' },
        ],
        anyBlocked: true,
        unverifiable: false,
      }),
    });
    expect(refusal).toBeNull();
  });

  it('pushPendingRef and relandPendingWork agree on the ref name through the one home (no string literal drift)', () => {
    const { cwd, origin } = repoWithOrigin();
    const head = verifiedWork(cwd);
    const out = pushPendingRef(cwd, record(head), makeExec(cwd));
    expect(out.pushed && out.ref).toBe(remediateBranchesFor(TASK).pending);
    expect(originRef(origin, remediateBranchesFor(TASK).pending)).not.toBeNull();
  });
});
