/**
 * A verified standing branch is never replaced by a red salvage (#372).
 *
 * The live class: a run partially landed twenty verified orders as the
 * task's standing PR (green, reviewed, awaiting merge). The next run
 * declined to resume onto it, ran fresh, ended guardrail-red, and the
 * salvage force-pushed the red attempt over the SAME branch and retitled
 * the PR "do not merge". The verified head's only copy was the branch.
 *
 * Pinned here, both directions and both landing moments:
 *   - the evidence is BRANCH-SIDE: the landing marker at the standing
 *     branch's ledger tip decides, the open PR body only corroborates, and
 *     an unreadable PR over an existing branch with no marker is an
 *     UNKNOWN that is never force-pushed over;
 *   - verified standing + red attempt: the standing branch is untouched,
 *     the attempt goes to the attempt branch as a draft, disclosed;
 *   - red standing + verified attempt: the standing branch is rebuilt and
 *     any open attempt PR is closed as superseded (the branch is kept);
 *   - the ledger composes the PAIR (attempt rows survive a second salvage),
 *     bookkeeping never lands on a preserved standing branch, and resume
 *     sees an attempt-branch partial as an anchor;
 *   - a draft flip on a ready PR is disclosed; a landing record with a
 *     foreign outcome is refused; `draft` is exactly `isSalvageLanding`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  decideLandingTarget,
  landingEligibility,
  landRemediateHead,
  remediateBranchesFor,
} from '../../src/remediate/land';
import {
  branchHolding,
  readOpenStandingPr,
  readRemediateBranchStates,
  type LaneBranchState,
} from '../../src/remediate/standing-branch';
import { executeTask, type ExecutorSeams } from '../../src/remediate/cli';
import { runRemediateLand } from '../../src/remediate/land-cli';
import {
  DEFERRED_LANDING_ENV,
  LANDING_RECORD_SCHEMA,
  readLandingRecord,
  writeLandingRecord,
  type LandingRecord,
} from '../../src/remediate/landing-record';
import { prepareResume } from '../../src/remediate/resume';
import { publishOrderRows, writeLocalOrderLedger } from '../../src/remediate/order-outcomes';
import {
  isRemediateOutcome,
  isSalvageLanding,
  REMEDIATE_OUTCOMES,
} from '../../src/remediate/outcome';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';
import type { Exec } from '../../src/land-refresh';
import {
  landingRow,
  orderLedgerPath,
  parseOrderRows,
  serializeOrderRows,
  type OrderOutcomeRow,
} from '../../src/lanes/order-ledger';

const TASK = 'write-docs';
const PAIR = remediateBranchesFor(TASK);
const STANDING = PAIR.standing;
const ATTEMPT = PAIR.attempt;
const FILE = orderLedgerPath('remediate', TASK);
const STANDING_URL = 'https://example.test/pr/20';
const ATTEMPT_URL = 'https://example.test/pr/21';
const CREATED_URL = 'https://example.test/pr/22';
const STAMP = { dxkitVersion: '4.4.8', policyHash: 'hash' };

/** The ledger body a PR of the given outcome carries. */
function ledgerBody(outcome: string): string {
  return `## dxkit remediate: ${TASK}\n\nTask: **${TASK}** ... outcome: **${outcome}**\n`;
}

/** A landing marker row for a branch. */
function marker(branch: string, outcome: string, timestamp = '2026-09-01T00:00:00.000Z') {
  return landingRow(TASK, { timestamp, outcome, branch, ...STAMP });
}

/** An ordinary order row (breaker evidence). */
function orderRow(orderId: string, timestamp: string): OrderOutcomeRow {
  return {
    schema_version: 1,
    timestamp,
    lane: 'remediate',
    task: TASK,
    orderId,
    class: 'dep-advisory',
    tier: 'recipe',
    outcome: 'verified',
    ...STAMP,
  };
}

interface BranchFixture {
  /** The branch's ledger rows at its tip; undefined = no ledger file. */
  readonly rows?: readonly OrderOutcomeRow[];
  /** The open PR (null / absent = none). */
  readonly pr?: { readonly body?: string; readonly isDraft?: boolean; readonly url?: string };
  /** Exists on origin (default: iff rows or a PR were given). */
  readonly exists?: boolean;
}
interface Fixture {
  readonly standing?: BranchFixture;
  readonly attempt?: BranchFixture;
  /** gh itself fails (no CLI, no auth, a 5xx). */
  readonly ghFails?: boolean;
  /** `git fetch` fails for every branch (offline object read). */
  readonly fetchFails?: boolean;
}

/** A recording exec over a scripted origin + gh. Every git write succeeds
 *  silently; reads answer from the fixture. */
function recordingExec(fx: Fixture): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const branchOf = (b: string): BranchFixture | undefined =>
    b === STANDING ? fx.standing : b === ATTEMPT ? fx.attempt : undefined;
  const exists = (b: string): boolean => {
    const f = branchOf(b);
    return f ? (f.exists ?? (f.rows !== undefined || f.pr !== undefined)) : false;
  };
  const urlOf = (b: string): string => (b === STANDING ? STANDING_URL : ATTEMPT_URL);
  let fetched = '';
  const exec: Exec = (bin, args, opts) => {
    calls.push([bin, ...args]);
    if (bin === 'gh') {
      if (fx.ghFails) {
        if (opts?.allowFail) return '';
        throw new Error('gh: HTTP 502');
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const head = args[args.indexOf('--head') + 1];
        const pr = branchOf(head)?.pr;
        if (!pr) return '[]';
        return JSON.stringify([
          {
            url: pr.url ?? urlOf(head),
            ...(pr.body !== undefined ? { body: pr.body } : {}),
            ...(pr.isDraft !== undefined ? { isDraft: pr.isDraft } : {}),
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'create') return CREATED_URL;
      return '';
    }
    switch (args[0]) {
      case 'ls-remote':
        return args
          .slice(3)
          .filter(exists)
          .map((b) => `deadbeef\trefs/heads/${b}`)
          .join('\n');
      case 'fetch':
        if (fx.fetchFails) throw new Error('fetch failed');
        if (!exists(args[2])) throw new Error(`no such branch ${args[2]}`);
        fetched = args[2];
        return '';
      case 'rev-parse':
        return `head-of-${fetched}\n`;
      case 'show': {
        const rows = branchOf(fetched)?.rows;
        if (rows === undefined) throw new Error('no ledger file');
        return serializeOrderRows(rows);
      }
      case 'hash-object':
        return 'blobsha\n';
      case 'write-tree':
        return 'treesha\n';
      default:
        if (args.includes('commit-tree')) return 'metacommit\n';
        return '';
    }
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
function ghListsOf(calls: string[][], branch: string): number {
  return gh(calls, 'list').filter((c) => c[c.indexOf('--head') + 1] === branch).length;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-standing-'));
  dirs.push(dir);
  return dir;
}
function ledgerRowsIn(cwd: string): OrderOutcomeRow[] {
  return parseOrderRows(fs.readFileSync(path.join(cwd, FILE), 'utf8'));
}

function land(fx: Fixture, outcome: RemediateResult['outcome'], draft?: boolean) {
  const cwd = tempRepo();
  const { exec, calls } = recordingExec(fx);
  const result = landRemediateHead({
    cwd,
    taskId: TASK,
    defaultBranch: 'main',
    outcome,
    prTitle: 't',
    prBody: 'THE LEDGER',
    ...(draft !== undefined ? { draft } : {}),
    exec,
  });
  return { result, calls, cwd };
}

/** A LaneBranchState for the pure decision tests. */
function state(over: Partial<LaneBranchState> = {}): LaneBranchState {
  return { branch: STANDING, exists: true, rows: [], foreign: [], ledger: 'read', ...over };
}
const VERIFIED_MARKER = { outcome: 'partially-landed', timestamp: '2026-09-01T00:00:00.000Z' };
const RED_MARKER = { outcome: 'guardrail-red', timestamp: '2026-09-02T00:00:00.000Z' };

describe('decideLandingTarget (the one policy, pure; ledger first, PR as corroboration)', () => {
  it('a verified landing always rebuilds the standing branch, whatever it holds', () => {
    for (const s of [
      state({ landed: VERIFIED_MARKER, pr: { url: STANDING_URL, outcome: 'verified' } }),
      state({ prUnreadable: 'gh: HTTP 502' }),
      undefined,
    ]) {
      expect(decideLandingTarget(TASK, 'verified', s).kind).toBe('standing');
      expect(decideLandingTarget(TASK, 'partially-landed', s).kind).toBe('standing');
    }
  });

  it('no PR + a verified ledger marker: a salvage diverts (the branch is the evidence)', () => {
    const t = decideLandingTarget(
      TASK,
      'guardrail-red',
      state({ landed: VERIFIED_MARKER, pr: null }),
    );
    expect(t.kind).toBe('attempt');
    expect(t.branch).toBe(ATTEMPT);
    if (t.kind === 'attempt') {
      expect(t.preserved.standingOutcome).toBe('partially-landed');
      expect(t.preserved.prUrl).toBeUndefined();
      expect(t.preserved.evidence).toContain('ledger at the tip');
    }
  });

  it('gh unreadable + a verified ledger marker: diverts', () => {
    const t = decideLandingTarget(
      TASK,
      'budget-exhausted',
      state({ landed: VERIFIED_MARKER, prUnreadable: 'gh: HTTP 502' }),
    );
    expect(t.kind).toBe('attempt');
  });

  it('gh unreadable + no marker over an EXISTING branch: unknown, never force-pushed over', () => {
    const t = decideLandingTarget(TASK, 'guardrail-red', state({ prUnreadable: 'gh: HTTP 502' }));
    expect(t.kind).toBe('attempt');
    if (t.kind === 'attempt') {
      expect(t.preserved.standingOutcome).toBe('unknown');
      expect(t.preserved.evidence).toContain('could not be read');
    }
    // ... but an ABSENT branch has nothing to protect.
    expect(
      decideLandingTarget(
        TASK,
        'guardrail-red',
        state({ exists: false, ledger: 'absent', prUnreadable: 'gh: HTTP 502' }),
      ).kind,
    ).toBe('standing');
  });

  it('no PR + no verified ledger: rebuilds (the pre-#372 behaviour)', () => {
    expect(decideLandingTarget(TASK, 'guardrail-red', state({ pr: null })).kind).toBe('standing');
    expect(
      decideLandingTarget(
        TASK,
        'guardrail-red',
        state({ exists: false, ledger: 'absent', pr: null }),
      ).kind,
    ).toBe('standing');
  });

  it('the ledger wins over a stale PR body, both directions', () => {
    // Marker says red, body says verified: replaceable.
    expect(
      decideLandingTarget(
        TASK,
        'guardrail-red',
        state({ landed: RED_MARKER, pr: { url: STANDING_URL, outcome: 'verified' } }),
      ).kind,
    ).toBe('standing');
    // Marker says verified, body says red: protected.
    expect(
      decideLandingTarget(
        TASK,
        'guardrail-red',
        state({ landed: VERIFIED_MARKER, pr: { url: STANDING_URL, outcome: 'guardrail-red' } }),
      ).kind,
    ).toBe('attempt');
    // No marker: the body corroborates.
    expect(
      decideLandingTarget(
        TASK,
        'guardrail-red',
        state({ pr: { url: STANDING_URL, outcome: 'partially-landed' } }),
      ).kind,
    ).toBe('attempt');
    // A body with no ledger line is not evidence.
    expect(
      decideLandingTarget(TASK, 'guardrail-red', state({ pr: { url: STANDING_URL } })).kind,
    ).toBe('standing');
  });

  it('branchHolding phrases every kind', () => {
    expect(branchHolding(state({ landed: VERIFIED_MARKER })).kind).toBe('verified');
    expect(branchHolding(state({ landed: RED_MARKER })).kind).toBe('salvage');
    expect(branchHolding(state({ prUnreadable: 'x' })).kind).toBe('unknown');
    expect(branchHolding(state({ pr: null })).kind).toBe('free');
  });
});

describe('landRemediateHead: the standing-branch guard (#372)', () => {
  it('verified standing PR + red attempt: standing untouched, attempt draft pushed, marker + disclosure written', () => {
    const { result, calls, cwd } = land(
      { standing: { pr: { body: ledgerBody('partially-landed'), isDraft: false } } },
      'guardrail-red',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    // The standing branch is only READ (ls-remote, fetch); no WRITE names
    // it. An exact-suffix check: the attempt branch name CONTAINS the
    // standing one.
    const writes = calls.filter(
      (c) => c[0] === 'git' && (c.includes('push') || c.includes('commit')),
    );
    expect(writes.some((c) => c.some((a) => a.endsWith(STANDING)))).toBe(false);
    expect(gh(calls, 'edit')).toEqual([]);
    expect(gh(calls, 'ready')).toEqual([]);
    expect(gh(calls, 'close')).toEqual([]);
    const create = gh(calls, 'create')[0];
    expect(create).toContain('--draft');
    expect(create[create.indexOf('--head') + 1]).toBe(ATTEMPT);
    expect(result.branch).toBe(ATTEMPT);
    expect(result.outcome).toBe('pr-opened');
    expect(result.prUrl).toBe(CREATED_URL);
    expect(result.preserved?.standingOutcome).toBe('partially-landed');
    expect(result.preserved?.prUrl).toBe(STANDING_URL);
    const body = create[create.indexOf('--body') + 1];
    expect(body.startsWith(`> standing PR ${STANDING_URL} holds a verified landing`)).toBe(true);
    expect(body).toContain('THE LEDGER');
    // The landing marker names the branch actually pushed and this outcome.
    const rows = ledgerRowsIn(cwd);
    expect(rows.map((r) => r.landing)).toEqual([{ outcome: 'guardrail-red', branch: ATTEMPT }]);
    // One PR list per branch: the state read is reused by the PR mechanics.
    expect(ghListsOf(calls, STANDING)).toBe(1);
    expect(ghListsOf(calls, ATTEMPT)).toBe(1);
  });

  it('no PR + a verified marker at the standing tip: diverts on the ledger alone', () => {
    const { result, calls } = land(
      { standing: { rows: [marker(STANDING, 'verified')] } },
      'budget-exhausted',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    expect(result.preserved?.prUrl).toBeUndefined();
    expect(result.preserved?.evidence).toContain('ledger at the tip');
    const body = gh(calls, 'create')[0];
    expect(body[body.indexOf('--body') + 1]).toContain(`standing branch '${STANDING}' holds`);
  });

  it('gh fails + a verified marker: diverts; gh fails + no marker over an existing branch: diverts as unknown', () => {
    const a = land(
      { standing: { rows: [marker(STANDING, 'verified')] }, ghFails: true },
      'guardrail-red',
    );
    expect(pushRefspecs(a.calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    expect(a.result.outcome).toBe('branch-pushed-no-pr');
    expect(a.result.preserved?.standingOutcome).toBe('verified');

    const b = land(
      { standing: { rows: [orderRow('o', '2026-08-01T00:00:00.000Z')] }, ghFails: true },
      'guardrail-red',
    );
    expect(pushRefspecs(b.calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    expect(b.result.preserved?.standingOutcome).toBe('unknown');
    expect(b.result.preserved?.evidence).toContain('could not be read');
  });

  it('no PR + no verified ledger: the standing branch is rebuilt', () => {
    const noBranch = land({}, 'guardrail-red', true);
    expect(pushRefspecs(noBranch.calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(noBranch.result.preserved).toBeUndefined();
    const redTip = land(
      { standing: { rows: [marker(STANDING, 'guardrail-red')] } },
      'guardrail-red',
      true,
    );
    expect(pushRefspecs(redTip.calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    // gh fails but the branch does not exist: nothing to protect.
    const absent = land({ ghFails: true }, 'guardrail-red', true);
    expect(pushRefspecs(absent.calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
  });

  it('red standing PR + verified attempt: rebuilt, no state read at all (lazy), marker names standing', () => {
    const { result, calls, cwd } = land(
      { standing: { pr: { body: ledgerBody('guardrail-red') } } },
      'verified',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(calls.some((c) => c[0] === 'git' && (c[1] === 'ls-remote' || c[1] === 'fetch'))).toBe(
      false,
    );
    expect(gh(calls, 'edit')[0][3]).toBe(STANDING);
    expect(gh(calls, 'ready')).toEqual([]);
    expect(result.branch).toBe(STANDING);
    expect(result.preserved).toBeUndefined();
    expect(ledgerRowsIn(cwd).map((r) => r.landing)).toEqual([
      { outcome: 'verified', branch: STANDING },
    ]);
  });

  it('verified standing + verified attempt: rebuilt (it supersedes)', () => {
    const { result, calls } = land(
      {
        standing: {
          rows: [marker(STANDING, 'partially-landed')],
          pr: { body: ledgerBody('partially-landed') },
        },
      },
      'partially-landed',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(result.preserved).toBeUndefined();
  });

  it('a standing rebuild closes an open attempt PR as superseded, keeping its branch', () => {
    const { result, calls } = land(
      {
        standing: { pr: { body: ledgerBody('guardrail-red') } },
        attempt: { pr: { body: ledgerBody('guardrail-red'), isDraft: true } },
      },
      'verified',
    );
    const close = gh(calls, 'close')[0];
    expect(close.slice(0, 4)).toEqual(['gh', 'pr', 'close', ATTEMPT]);
    expect(close[close.indexOf('--comment') + 1]).toBe(`superseded by ${STANDING_URL}`);
    expect(close).not.toContain('--delete-branch');
    expect(result.supersededAttemptPr).toBe(ATTEMPT_URL);
    // A divert never closes anything; a rebuild with no attempt PR closes nothing.
    const divert = land(
      {
        standing: { pr: { body: ledgerBody('verified') } },
        attempt: { pr: { body: ledgerBody('guardrail-red') } },
      },
      'guardrail-red',
    );
    expect(gh(divert.calls, 'close')).toEqual([]);
    expect(gh(land({}, 'verified').calls, 'close')).toEqual([]);
  });

  it('a salvage updating a READY standing PR flips it back to draft and says so; an already-draft PR is silent', () => {
    const ready = land(
      { standing: { pr: { body: ledgerBody('guardrail-red'), isDraft: false } } },
      'guardrail-red',
      true,
    );
    expect(gh(ready.calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', STANDING]);
    expect(ready.result.draftFlipped).toContain('marked ready for review on a previous head');
    expect(ready.result.draftFlipped).toContain('returned the PR to draft');
    const draft = land(
      { standing: { pr: { body: ledgerBody('guardrail-red'), isDraft: true } } },
      'guardrail-red',
      true,
    );
    expect(gh(draft.calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', STANDING]);
    expect(draft.result.draftFlipped).toBeUndefined();
  });

  it('a diverted salvage updating an existing attempt PR converts it to draft in place', () => {
    const { result, calls } = land(
      {
        standing: { rows: [marker(STANDING, 'verified')] },
        attempt: { pr: { body: ledgerBody('guardrail-red'), isDraft: true } },
      },
      'budget-exhausted',
    );
    expect(pushRefspecs(calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);
    expect(gh(calls, 'edit')[0][3]).toBe(ATTEMPT);
    expect(gh(calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', ATTEMPT]);
    expect(result.outcome).toBe('pr-updated');
    expect(result.prUrl).toBe(ATTEMPT_URL);
  });
});

describe('readOpenStandingPr / readRemediateBranchStates (the one reader)', () => {
  it('null without an open PR; url + ledger facts + isDraft with one; throws when gh fails', () => {
    expect(readOpenStandingPr(recordingExec({}).exec, STANDING)).toBeNull();
    const body = ledgerBody('guardrail-red') + 'Blocking findings:\n- secret in a.ts\n';
    expect(
      readOpenStandingPr(
        recordingExec({ standing: { pr: { body, isDraft: true } } }).exec,
        STANDING,
      ),
    ).toEqual({
      url: STANDING_URL,
      outcome: 'guardrail-red',
      blockingContext: '- secret in a.ts',
      isDraft: true,
    });
    expect(() => readOpenStandingPr(recordingExec({ ghFails: true }).exec, STANDING)).toThrow();
  });

  it('reads the pair with one remote probe; degraded reads land on the state, never thrown', () => {
    const fx: Fixture = {
      standing: { rows: [marker(STANDING, 'verified')], pr: { body: ledgerBody('verified') } },
      attempt: { rows: [marker(ATTEMPT, 'guardrail-red')] },
      ghFails: true,
    };
    const { exec, calls } = recordingExec(fx);
    const states = readRemediateBranchStates(TASK, exec);
    expect(calls.filter((c) => c[1] === 'ls-remote')).toHaveLength(1);
    expect(states.standing.landed?.outcome).toBe('verified');
    expect(states.attempt.landed?.outcome).toBe('guardrail-red');
    expect(states.standing.prUnreadable).toContain('502');
    expect(states.standing.pr).toBeUndefined();
    const offline = readRemediateBranchStates(
      TASK,
      recordingExec({ ...fx, ghFails: false, fetchFails: true }).exec,
    );
    expect(offline.standing.ledger).toBe('unreachable');
    expect(offline.standing.pr?.outcome).toBe('verified');
  });
});

describe('the order ledger composes the PAIR and never lands bookkeeping on a preserved branch', () => {
  it('attempt rows survive a second salvage: the compose unions standing + attempt rows', () => {
    const cwd = tempRepo();
    const fx: Fixture = {
      standing: {
        rows: [
          marker(STANDING, 'verified', '2026-07-31T00:00:00.000Z'),
          orderRow('s-1', '2026-08-01T00:00:00.000Z'),
        ],
      },
      attempt: {
        rows: [
          marker(ATTEMPT, 'guardrail-red', '2026-08-02T00:00:00.000Z'),
          orderRow('a-1', '2026-08-02T12:00:00.000Z'),
        ],
      },
    };
    const rel = writeLocalOrderLedger(
      cwd,
      TASK,
      [orderRow('a-2', '2026-08-03T00:00:00.000Z')],
      recordingExec(fx).exec,
    );
    expect(rel).toBe(FILE);
    // Oldest first, both branches' markers kept (distinct identities).
    const ids = ledgerRowsIn(cwd).map((r) =>
      r.landing ? `landing@${r.landing.branch}` : r.orderId,
    );
    expect(ids).toEqual([`landing@${STANDING}`, 's-1', `landing@${ATTEMPT}`, 'a-1', 'a-2']);
  });

  it('a metadata push targets the attempt branch while the standing branch holds verified work', () => {
    const cwd = tempRepo();
    const held = recordingExec({
      standing: { rows: [marker(STANDING, 'partially-landed')] },
      attempt: { rows: [] },
    });
    expect(
      publishOrderRows(cwd, TASK, [orderRow('x', '2026-09-03T00:00:00.000Z')], held.exec).published,
    ).toBe(true);
    expect(pushRefspecs(held.calls)).toEqual([`metacommit:refs/heads/${ATTEMPT}`]);
    const parent = held.calls.find((c) => c.includes('commit-tree'))!;
    expect(parent[parent.indexOf('-p') + 1]).toBe(`head-of-${ATTEMPT}`);
    // Replaceable standing branch: the metadata commit rides it as before.
    const free = recordingExec({ standing: { rows: [marker(STANDING, 'guardrail-red')] } });
    publishOrderRows(cwd, TASK, [orderRow('y', '2026-09-03T00:00:00.000Z')], free.exec);
    expect(pushRefspecs(free.calls)).toEqual([`metacommit:refs/heads/${STANDING}`]);
  });
});

describe('resume sees the pair', () => {
  const ON = { resume: true, salvage: 'draft-pr' } as const;

  it('an attempt-branch budget-exhausted verified partial IS a resume anchor; its attempt row rides the attempt branch', () => {
    const cwd = tempRepo();
    const { exec, calls } = recordingExec({
      standing: {
        rows: [marker(STANDING, 'partially-landed')],
        pr: { body: ledgerBody('partially-landed') },
      },
      attempt: {
        rows: [marker(ATTEMPT, 'budget-exhausted')],
        pr: { body: ledgerBody('budget-exhausted'), isDraft: true },
      },
    });
    const d = prepareResume(cwd, TASK, ON, exec);
    expect(d.resumed).toBe(true);
    expect(d.branch).toBe(ATTEMPT);
    expect(d.attempt).toBe(1);
    expect(calls.find((c) => c[0] === 'git' && c[1] === 'fetch' && c[3] === ATTEMPT)).toBeDefined();
    expect(calls.find((c) => c[0] === 'git' && c[1] === 'checkout')).toEqual([
      'git',
      'checkout',
      '--detach',
      'FETCH_HEAD',
    ]);
    // The counter row never lands on the preserved standing branch.
    expect(pushRefspecs(calls)).toEqual([`metacommit:refs/heads/${ATTEMPT}`]);
  });

  it("a guardrail-red attempt draft's blocking findings carry as the negative constraint; the cap message names the PR, not 'the draft'", () => {
    const body = ledgerBody('guardrail-red') + 'Blocking findings:\n- leaked key in b.ts\n';
    const { exec } = recordingExec({
      standing: {
        rows: [marker(STANDING, 'verified')],
        pr: { body: ledgerBody('verified'), isDraft: false },
      },
      attempt: { pr: { body, isDraft: true } },
    });
    const d = prepareResume(tempRepo(), TASK, ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.blockingContext).toBe('- leaked key in b.ts');
    expect(d.note).toContain('negative constraint');
    expect(d.note).not.toContain('the draft PR');
  });
});

describe('records (#372 findings 7, 8)', () => {
  it('a landing record with an absent or foreign outcome is refused, remedy named', () => {
    const cwd = tempRepo();
    const base: LandingRecord = {
      schema: LANDING_RECORD_SCHEMA,
      task: TASK,
      action: 'land',
      branch: STANDING,
      head: 'bbbb2222',
      outcome: 'verified',
      defaultBranch: 'main',
      prTitle: 't',
      prBody: 'b',
      orderRows: [],
    };
    writeLandingRecord(cwd, { ...base, outcome: 'bogus' as LandingRecord['outcome'] });
    const foreign = readLandingRecord(cwd, TASK);
    expect(foreign && 'error' in foreign && foreign.error).toContain(
      "outcome 'bogus' is not a remediate outcome",
    );
    writeLandingRecord(cwd, { ...base, outcome: undefined as unknown as LandingRecord['outcome'] });
    const absent = readLandingRecord(cwd, TASK);
    expect(absent && 'error' in absent && absent.error).toContain('re-run the task');
    writeLandingRecord(cwd, base);
    expect(readLandingRecord(cwd, TASK)).toEqual({ record: base });
  });

  it('isRemediateOutcome covers the vocabulary and nothing else', () => {
    for (const o of REMEDIATE_OUTCOMES) expect(isRemediateOutcome(o)).toBe(true);
    expect(isRemediateOutcome('landed')).toBe(false);
    expect(isRemediateOutcome(undefined)).toBe(false);
  });
});

describe('one partition: draft is exactly a land-eligible salvage (#372 finding 10)', () => {
  it('for every RemediateOutcome, landEligible && draft <=> isSalvageLanding', () => {
    for (const outcome of REMEDIATE_OUTCOMES) {
      const e = landingEligibility({ outcome, guardrailRan: true }, 'draft-pr');
      expect(e.landEligible && e.draft, outcome).toBe(isSalvageLanding(outcome));
      // Under discard a salvage never lands and nothing is a draft.
      const d = landingEligibility({ outcome, guardrailRan: true }, 'discard');
      expect(d.draft, outcome).toBe(false);
      expect(d.landEligible, outcome).toBe(
        outcome === 'verified' || outcome === 'partially-landed',
      );
    }
    // A guardrail that never ran earns no red draft; a failed restore stays local.
    expect(landingEligibility({ outcome: 'guardrail-red' }, 'draft-pr').landEligible).toBe(false);
    expect(
      landingEligibility(
        {
          outcome: 'guardrail-red',
          guardrailRan: true,
          containment: { restoreFailed: true } as never,
        },
        'draft-pr',
      ).landEligible,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parity: the inline landing and the deferred `remediate land` step route
// through the one lander, so both preserve the standing branch identically.
// ---------------------------------------------------------------------------

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

const VERIFIED_STANDING: Fixture = {
  standing: {
    rows: [marker(STANDING, 'partially-landed')],
    pr: { body: ledgerBody('partially-landed'), isDraft: false },
  },
};
const RED_STANDING: Fixture = {
  standing: {
    rows: [marker(STANDING, 'guardrail-red')],
    pr: { body: ledgerBody('guardrail-red'), isDraft: false },
  },
};

describe('parity: inline landing and deferred `remediate land` decide identically', () => {
  it('both push the red attempt to the attempt branch and record the branch reached + the disclosure', async () => {
    const inlineRepo = tempRepo();
    const inline = recordingExec(VERIFIED_STANDING);
    const run = await executeTask(inlineRepo, config(), TASK, 'pr', seams(inline.exec));
    expect(run.landed).toBe(true);
    expect(run.prUrl).toBe(CREATED_URL);
    expect(run.landedBranch).toBe(ATTEMPT);
    expect(run.standingPreserved).toContain(`standing PR ${STANDING_URL} holds a verified landing`);
    expect(run.standingPreserved).toContain(ATTEMPT);
    expect(attemptRecord(inlineRepo)).toMatchObject({
      branch: ATTEMPT,
      standingPreserved: run.standingPreserved,
      draftFlipped: null,
      supersededAttemptPr: null,
    });
    expect(pushRefspecs(inline.calls)).toEqual([`HEAD:refs/heads/${ATTEMPT}`]);

    const deferredRepo = tempRepo();
    const deferred = recordingExec(VERIFIED_STANDING);
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
    // The record was written BEFORE anything landed: no branch reached yet.
    expect(attemptRecord(deferredRepo).branch).toBeNull();
    const out = runRemediateLand(deferredRepo, TASK, {
      head: () => 'bbbb2222',
      writeOrderLedger: () => null,
      landHead: (o) => landRemediateHead({ ...o, exec: deferred.exec }),
    });
    expect(out).toMatchObject({
      outcome: 'landed',
      landedBranch: ATTEMPT,
      standingPreserved: run.standingPreserved,
    });
    expect(attemptRecord(deferredRepo)).toMatchObject({
      branch: ATTEMPT,
      standingPreserved: run.standingPreserved,
    });
    expect(pushRefspecs(deferred.calls)).toEqual(pushRefspecs(inline.calls));
    expect(gh(deferred.calls, 'create')[0]).toEqual(gh(inline.calls, 'create')[0]);
  });

  it('both rebuild a red standing branch, flip its ready PR to draft, and disclose the flip', async () => {
    const inlineRepo = tempRepo();
    const inline = recordingExec(RED_STANDING);
    const run = await executeTask(inlineRepo, config(), TASK, 'pr', seams(inline.exec));
    expect(run.landedBranch).toBe(STANDING);
    expect(run.standingPreserved).toBeUndefined();
    expect(run.draftFlipped).toContain('returned the PR to draft');
    expect(attemptRecord(inlineRepo)).toMatchObject({
      branch: STANDING,
      standingPreserved: null,
      draftFlipped: run.draftFlipped,
    });
    expect(pushRefspecs(inline.calls)).toEqual([`HEAD:refs/heads/${STANDING}`]);
    expect(gh(inline.calls, 'ready')[0]).toEqual(['gh', 'pr', 'ready', '--undo', STANDING]);

    const deferredRepo = tempRepo();
    const deferred = recordingExec(RED_STANDING);
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
    expect(out).toMatchObject({
      outcome: 'landed',
      landedBranch: STANDING,
      draftFlipped: run.draftFlipped,
    });
    expect(out).not.toHaveProperty('standingPreserved');
    expect(pushRefspecs(deferred.calls)).toEqual(pushRefspecs(inline.calls));
    expect(gh(deferred.calls, 'ready')).toEqual(gh(inline.calls, 'ready'));
  });

  it('the preflight refuses an attempt-only block only while the standing branch holds verified work', async () => {
    const attemptBlocked = () => ({
      probes: [
        { branch: STANDING, verdict: 'ok' as const, evidence: 'no rules apply' },
        {
          branch: ATTEMPT,
          verdict: 'blocked' as const,
          evidence: `an active branch-creation ruleset covers "${ATTEMPT}"`,
          remedy: 'exclude it',
        },
      ],
      anyBlocked: true,
      unverifiable: false,
    });
    // Replaceable standing branch: a warning, the run proceeds and lands.
    const free = recordingExec(RED_STANDING);
    const proceeded = await executeTask(
      tempRepo(),
      config(),
      TASK,
      'pr',
      seams(free.exec, {
        probeDelivery: attemptBlocked,
        readBranchStates: (t, e) => readRemediateBranchStates(t, free.exec),
      }),
    );
    expect(proceeded.result.outcome).toBe('guardrail-red');
    expect(proceeded.landed).toBe(true);
    // Verified standing branch: the attempt branch is the only target, refused and named.
    const held = recordingExec(VERIFIED_STANDING);
    let spawned = false;
    const refused = await executeTask(
      tempRepo(),
      config(),
      TASK,
      'pr',
      seams(held.exec, {
        probeDelivery: attemptBlocked,
        readBranchStates: (t) => readRemediateBranchStates(t, held.exec),
        runTask: async () => {
          spawned = true;
          return redResult();
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(refused.result.outcome).toBe('refused');
    expect(refused.result.note).toContain('only landing target');
    expect(refused.result.note).toContain(ATTEMPT);
  });
});
