/**
 * A verified standing PR is never replaced by a red salvage (#372).
 *
 * The live class: a run partially landed twenty verified orders as the
 * task's standing PR (green, reviewed, awaiting merge). The next run
 * declined to resume onto it, ran fresh, ended guardrail-red, and the
 * salvage force-pushed the red attempt over the SAME branch and retitled
 * the PR "do not merge". The verified head's only copy was the branch.
 *
 * Pinned here, both directions and both landing moments:
 *   - verified standing PR + red attempt: the standing branch is untouched,
 *     the attempt goes to the attempt branch as a draft, disclosed;
 *   - red standing PR + verified attempt: the standing branch is rebuilt
 *     (the pre-#372 behavior survives);
 *   - verified standing PR + verified attempt: rebuilt (it supersedes);
 *   - the inline landing and the deferred `remediate land` step reach the
 *     same decision through the one lander (parity).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  decideLandingTarget,
  landRemediateHead,
  remediateAttemptBranchFor,
  remediateBranchFor,
} from '../../src/remediate/land';
import { readOpenStandingPr } from '../../src/remediate/standing-pr';
import { executeTask, type ExecutorSeams } from '../../src/remediate/cli';
import { runRemediateLand } from '../../src/remediate/land-cli';
import { DEFERRED_LANDING_ENV } from '../../src/remediate/landing-record';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';
import type { Exec } from '../../src/land-refresh';

const TASK = 'write-docs';
const STANDING = remediateBranchFor(TASK);
const ATTEMPT = remediateAttemptBranchFor(TASK);
const STANDING_URL = 'https://example.test/pr/20';
const ATTEMPT_URL = 'https://example.test/pr/21';
const CREATED_URL = 'https://example.test/pr/22';

/** The ledger body a standing PR of the given outcome carries. */
function ledgerBody(outcome: string): string {
  return `## dxkit remediate: ${TASK}\n\nTask: **${TASK}** ... outcome: **${outcome}**\n`;
}

interface GhState {
  /** The standing PR's body (an open standing PR exists iff set). */
  readonly standingBody?: string;
  /** An open PR already exists for the attempt branch. */
  readonly attemptPr?: boolean;
  /** gh itself fails (no CLI, no auth). */
  readonly ghFails?: boolean;
}

/** A recording exec over a scripted gh: every git spawn succeeds silently. */
function recordingExec(state: GhState): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (bin, args, opts) => {
    calls.push([bin, ...args]);
    if (bin !== 'gh') return '';
    if (state.ghFails) {
      if (opts?.allowFail) return '';
      throw new Error('gh: command not found');
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args[args.indexOf('--head') + 1];
      if (head === STANDING && state.standingBody !== undefined) {
        return JSON.stringify([{ url: STANDING_URL, body: state.standingBody }]);
      }
      if (head === ATTEMPT && state.attemptPr) return JSON.stringify([{ url: ATTEMPT_URL }]);
      return '[]';
    }
    if (args[0] === 'pr' && args[1] === 'create') return CREATED_URL;
    return '';
  };
  return { exec, calls };
}

/** The refspecs of every git push. */
function pushRefspecs(calls: string[][]): string[] {
  return calls.filter((c) => c[0] === 'git' && c[1] === 'push').map((c) => c[c.length - 1]);
}
function gh(calls: string[][], sub: string): string[][] {
  return calls.filter((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === sub);
}

function land(state: GhState, outcome: RemediateResult['outcome'], draft?: boolean) {
  const { exec, calls } = recordingExec(state);
  const result = landRemediateHead({
    cwd: '/repo',
    taskId: TASK,
    defaultBranch: 'main',
    outcome,
    prTitle: 't',
    prBody: 'THE LEDGER',
    ...(draft !== undefined ? { draft } : {}),
    exec,
  });
  return { result, calls };
}

describe('decideLandingTarget (the one policy, pure)', () => {
  const verified = { url: STANDING_URL, outcome: 'verified' };
  const partial = { url: STANDING_URL, outcome: 'partially-landed' };
  const red = { url: STANDING_URL, outcome: 'guardrail-red' };

  it('no standing PR: every outcome rebuilds the standing branch', () => {
    for (const o of ['verified', 'guardrail-red', 'budget-exhausted'] as const) {
      expect(decideLandingTarget(TASK, o, null)).toEqual({ kind: 'standing', branch: STANDING });
    }
  });

  it('a verified standing PR + a salvage: the attempt branch, standing preserved', () => {
    const t = decideLandingTarget(TASK, 'guardrail-red', partial);
    expect(t.kind).toBe('attempt');
    expect(t.branch).toBe(ATTEMPT);
    if (t.kind === 'attempt') {
      expect(t.preserved).toEqual({
        standingBranch: STANDING,
        prUrl: STANDING_URL,
        standingOutcome: 'partially-landed',
        attemptBranch: ATTEMPT,
        attemptOutcome: 'guardrail-red',
      });
    }
    expect(decideLandingTarget(TASK, 'budget-exhausted', verified).kind).toBe('attempt');
  });

  it('a verified standing PR + a verified landing: rebuilt (it supersedes)', () => {
    expect(decideLandingTarget(TASK, 'verified', verified).kind).toBe('standing');
    expect(decideLandingTarget(TASK, 'partially-landed', partial).kind).toBe('standing');
  });

  it('a red or unreadable standing PR: rebuilt, whatever this run is', () => {
    expect(decideLandingTarget(TASK, 'verified', red).kind).toBe('standing');
    expect(decideLandingTarget(TASK, 'guardrail-red', red).kind).toBe('standing');
    // A body with no ledger outcome line is unknown, never treated as verified.
    expect(decideLandingTarget(TASK, 'guardrail-red', { url: STANDING_URL }).kind).toBe('standing');
  });
});

describe('landRemediateHead: the standing-PR guard (#372)', () => {
  it('verified standing PR + red attempt: standing branch untouched, attempt pushed as a draft, disclosed', () => {
    const { result, calls } = land(
      { standingBody: ledgerBody('partially-landed') },
      'guardrail-red',
    );
    // The only push targets the attempt branch; nothing names the standing branch.
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    // (an exact-suffix check: the attempt branch name CONTAINS the standing one)
    expect(calls.some((c) => c[0] === 'git' && c.some((a) => a.endsWith(STANDING)))).toBe(false);
    // The standing PR is neither edited nor un-readied.
    expect(gh(calls, 'edit')).toEqual([]);
    expect(gh(calls, 'ready')).toEqual([]);
    // The attempt PR is created as a draft.
    const create = gh(calls, 'create')[0];
    expect(create).toContain('--draft');
    expect(create[create.indexOf('--head') + 1]).toBe(ATTEMPT);
    expect(result.preserved?.attemptBranch).toBe(ATTEMPT);
    expect(result.outcome).toBe('pr-opened');
    expect(result.prUrl).toBe(CREATED_URL);
    expect(result.preserved?.standingOutcome).toBe('partially-landed');
    expect(result.preserved?.prUrl).toBe(STANDING_URL);
    // The attempt PR's body opens with the disclosure, the ledger below it.
    const body = create[create.indexOf('--body') + 1];
    expect(body.startsWith(`> standing PR ${STANDING_URL} holds a verified landing`)).toBe(true);
    expect(body).toContain('THE LEDGER');
  });

  it('verified standing PR + red attempt with an existing attempt PR: updated in place and converted to draft', () => {
    const { result, calls } = land(
      { standingBody: ledgerBody('verified'), attemptPr: true },
      'budget-exhausted',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    expect(gh(calls, 'edit')[0][3]).toBe(ATTEMPT);
    expect(gh(calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', ATTEMPT]);
    expect(result.outcome).toBe('pr-updated');
    expect(result.prUrl).toBe(ATTEMPT_URL);
    expect(result.preserved?.attemptOutcome).toBe('budget-exhausted');
  });

  it('red standing PR + verified attempt: the standing branch IS rebuilt (the current behavior survives)', () => {
    const { result, calls } = land({ standingBody: ledgerBody('guardrail-red') }, 'verified');
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(gh(calls, 'edit')[0][3]).toBe(STANDING);
    expect(gh(calls, 'ready')).toEqual([]); // a verified landing does not force draft
    expect(result.preserved).toBeUndefined();
  });

  it('verified standing PR + verified attempt: rebuilt (it supersedes)', () => {
    const { result, calls } = land({ standingBody: ledgerBody('partially-landed') }, 'verified');
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(result.preserved).toBeUndefined();
  });

  it('a salvage that updates an existing standing PR marks it draft', () => {
    const { calls } = land({ standingBody: ledgerBody('guardrail-red') }, 'guardrail-red', true);
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(gh(calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', STANDING]);
  });

  it('no standing PR: a salvage opens the standing draft as before', () => {
    const { result, calls } = land({}, 'guardrail-red', true);
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(gh(calls, 'create')[0]).toContain('--draft');
    expect(result.preserved).toBeUndefined();
  });

  it('an unreadable standing PR (gh fails) falls back to the rebuild, never a throw', () => {
    const { result, calls } = land({ ghFails: true }, 'guardrail-red', true);
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(result.outcome).toBe('branch-pushed-no-pr');
    expect(result.preserved).toBeUndefined();
  });
});

describe('readOpenStandingPr (the one reader)', () => {
  it('null without an open PR; the url + ledger facts with one; throws when gh fails', () => {
    expect(readOpenStandingPr(recordingExec({}).exec, STANDING)).toBeNull();
    const body = ledgerBody('guardrail-red') + 'Blocking findings:\n- secret in a.ts\n';
    expect(readOpenStandingPr(recordingExec({ standingBody: body }).exec, STANDING)).toEqual({
      url: STANDING_URL,
      outcome: 'guardrail-red',
      blockingContext: '- secret in a.ts',
    });
    expect(() => readOpenStandingPr(recordingExec({ ghFails: true }).exec, STANDING)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Parity: the inline landing and the deferred `remediate land` step route
// through the one lander, so both preserve the standing PR identically.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-standing-'));
  dirs.push(dir);
  return dir;
}

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: [TASK],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'draft-pr',
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

/** A guardrail that RAN and blocked: the red salvage shape. */
function redResult(): RemediateResult {
  return {
    outcome: 'guardrail-red',
    task: TASK,
    ledger: `Task: **${TASK}** ... outcome: **guardrail-red**\n`,
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
    guardrailRan: true,
  };
}

function seams(exec: Exec, extra: Partial<ExecutorSeams> = {}): ExecutorSeams {
  return {
    runTask: async () => redResult(),
    branch: () => 'main',
    defaultBranch: () => 'main',
    landHead: (o) => landRemediateHead({ ...o, exec }),
    probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
    writeOrderLedger: () => null,
    ...extra,
  };
}

function attemptRecord(cwd: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, '.dxkit', 'cache', `remediate-${TASK}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

describe('parity: inline landing and deferred `remediate land` preserve the standing PR the same way', () => {
  it('both push the red attempt to the attempt branch and disclose it in the run + JSON', async () => {
    // Inline: the executor lands immediately through the real lander.
    const inlineRepo = tempRepo();
    const inline = recordingExec({ standingBody: ledgerBody('partially-landed') });
    const run = await executeTask(inlineRepo, config(), TASK, 'pr', seams(inline.exec));
    expect(run.landed).toBe(true);
    expect(run.prUrl).toBe(CREATED_URL);
    expect(run.standingPreserved).toContain(`standing PR ${STANDING_URL} holds a verified landing`);
    expect(run.standingPreserved).toContain(ATTEMPT);
    expect(attemptRecord(inlineRepo).standingPreserved).toBe(run.standingPreserved);
    expect(pushRefspecs(inline.calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);

    // Deferred: the executor writes the record; `remediate land` lands it
    // through the SAME lander under the same gh state.
    const deferredRepo = tempRepo();
    const deferred = recordingExec({ standingBody: ledgerBody('partially-landed') });
    const phaseOne = await executeTask(
      deferredRepo,
      config(),
      TASK,
      'pr',
      seams(deferred.exec, {
        env: { [DEFERRED_LANDING_ENV]: '1' },
        landHead: () => {
          throw new Error('the task step must not push under deferred landing');
        },
      }),
    );
    expect(phaseOne.landingDeferred).toContain('remediate land');
    const out = runRemediateLand(deferredRepo, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: (o) => landRemediateHead({ ...o, exec: deferred.exec }),
    });
    expect(out.outcome).toBe('landed');
    expect('standingPreserved' in out && out.standingPreserved).toBe(run.standingPreserved);
    expect(attemptRecord(deferredRepo).standingPreserved).toBe(run.standingPreserved);
    expect(pushRefspecs(deferred.calls)).toEqual(pushRefspecs(inline.calls));
    expect(gh(deferred.calls, 'create')[0]).toEqual(gh(inline.calls, 'create')[0]);
  });

  it('both rebuild the standing branch when it holds a red draft (the current behavior, both moments)', async () => {
    const inlineRepo = tempRepo();
    const inline = recordingExec({ standingBody: ledgerBody('guardrail-red') });
    const run = await executeTask(inlineRepo, config(), TASK, 'pr', seams(inline.exec));
    expect(run.standingPreserved).toBeUndefined();
    expect(attemptRecord(inlineRepo).standingPreserved).toBeNull();
    expect(pushRefspecs(inline.calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    // The red salvage updating the existing red draft keeps it a draft.
    expect(gh(inline.calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', STANDING]);

    const deferredRepo = tempRepo();
    const deferred = recordingExec({ standingBody: ledgerBody('guardrail-red') });
    await executeTask(
      deferredRepo,
      config(),
      TASK,
      'pr',
      seams(deferred.exec, { env: { [DEFERRED_LANDING_ENV]: '1' } }),
    );
    const out = runRemediateLand(deferredRepo, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: (o) => landRemediateHead({ ...o, exec: deferred.exec }),
    });
    expect(out.outcome).toBe('landed');
    expect(out).not.toHaveProperty('standingPreserved');
    expect(pushRefspecs(deferred.calls)).toEqual(pushRefspecs(inline.calls));
    expect(gh(deferred.calls, 'ready')).toEqual(gh(inline.calls, 'ready'));
  });
});
