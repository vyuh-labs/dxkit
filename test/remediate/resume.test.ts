/**
 * Resume-from-salvage (opt-in): the eligibility ladder, the resume cap, and
 * the attribution law (entry floor anchored to the pristine base) through
 * the runner.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_RESUME_ATTEMPTS,
  prepareResume,
  resumePromptNote,
  type ResumeExec,
} from '../../src/remediate/resume';
import {
  RESUME_ATTEMPT_ORDER,
  resumeAttemptRow,
  serializeOrderRows,
} from '../../src/lanes/order-ledger';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';

const STAMP = { dxkitVersion: '4.4.5', policyHash: 'hash-a' };

/** Scripted plumbing exec: the gh probe, the order ledger's branch read
 *  (`markers` = resume-attempt rows already on the standing branch), and the
 *  ledger's non-landing publish channel. `published` captures every ledger
 *  file content the publish channel hashed. */
function fakeExec(opts: {
  openPr?: boolean;
  markers?: number;
  failFetch?: boolean;
  failPush?: boolean;
  prBody?: string;
  /** Serve the branch rows under this task instead of the ledger path's. */
  rowsTask?: string;
}): {
  exec: ResumeExec;
  calls: string[][];
  published: string[];
} {
  const calls: string[][] = [];
  const published: string[] = [];
  const branchRows = Array.from({ length: opts.markers ?? 0 }, (_, i) =>
    resumeAttemptRow('fix-build', {
      timestamp: `2026-08-1${i}T00:00:00.000Z`,
      ...STAMP,
    }),
  );
  const exec: ResumeExec = (bin, args, execOpts) => {
    calls.push([bin, ...args]);
    if (bin === 'gh') {
      if (!opts.openPr) return '[]';
      // Default body: a budget-exhausted verified partial — the ONE outcome
      // that is a resume anchor (design F).
      return JSON.stringify([
        { url: 'https://x/pr/1', body: opts.prBody ?? 'outcome: **budget-exhausted**' },
      ]);
    }
    if (bin !== 'git') return '';
    switch (args[0]) {
      case 'ls-remote':
        return args
          .slice(3)
          .map((b) => `deadbeef\trefs/heads/${b}`)
          .join('\n');
      case 'fetch':
        if (opts.failFetch) throw new Error('fetch failed');
        return '';
      case 'rev-parse':
        return 'branchhead\n';
      case 'show':
        // The task under test is always the row's task: a foreign task's
        // rows must never count, so serve them under whatever task the
        // ledger path names.
        return serializeOrderRows(
          branchRows.map((r) => ({
            ...r,
            task: opts.rowsTask ?? String(args[1]).split('remediate-')[1]!.split('.')[0]!,
          })),
        );
      case 'hash-object':
        published.push(execOpts?.input ?? '');
        return 'blobsha\n';
      case 'write-tree':
        return 'treesha\n';
      case 'push':
        if (opts.failPush) throw new Error('push rejected');
        return '';
      default:
        if (args.includes('commit-tree')) return 'marker5678';
        return '';
    }
  };
  return { exec, calls, published };
}

const ON = { resume: true, salvage: 'draft-pr' } as Pick<RemediateConfig, 'resume' | 'salvage'>;

describe('prepareResume — the eligibility ladder', () => {
  it('knob off → fresh run, silently', () => {
    const d = prepareResume('/repo', 'fix-build', { resume: false, salvage: 'draft-pr' });
    expect(d).toEqual({ resumed: false });
  });

  it('salvage: discard → nothing lands to resume from (disclosed)', () => {
    const d = prepareResume('/repo', 'fix-build', { resume: true, salvage: 'discard' });
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('salvage');
  });

  it('no open draft PR → fresh run (disclosed)', () => {
    const { exec } = fakeExec({ openPr: false });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('no open draft PR');
  });

  it('at the resume cap → fresh run with the review remedy (a doomed branch cannot burn budget forever)', () => {
    const { exec } = fakeExec({ openPr: true, markers: MAX_RESUME_ATTEMPTS });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('cap');
  });

  it('eligible → detached checkout + a resume-attempt ledger row, attempt = prior rows + 1', () => {
    const { exec, calls, published } = fakeExec({ openPr: true, markers: 1 });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d).toEqual({ resumed: true, attempt: 2 });
    expect(calls.some((c) => c[0] === 'git' && c.includes('--detach'))).toBe(true);
    // No marker commit anywhere: the counter is a ledger row, not history.
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'commit')).toBe(false);
    // The published ledger carries the branch's prior row AND this attempt.
    expect(published).toHaveLength(1);
    const rows = published[0]!
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { outcome: string; orderId: string });
    expect(rows.filter((r) => r.outcome === 'resumed')).toHaveLength(2);
    expect(rows.every((r) => r.orderId === RESUME_ATTEMPT_ORDER)).toBe(true);
  });

  it('the attempt row is PUBLISHED before the checkout, parented on the REMOTE branch head; a no-op resume still consumes an attempt', () => {
    // Observed live (twice): a marker commit only reached the remote when a
    // landing force-pushed, then the next landing's force-push from the
    // default head ERASED it, so the MAX_RESUME_ATTEMPTS cap was
    // unreachable on a guardrail-red chain. The ledger channel composes
    // the branch's rows before every write, so a landing carries the
    // count forward instead of erasing it.
    const { exec, calls } = fakeExec({ openPr: true, markers: 0 });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(true);
    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push');
    expect(push).toBeDefined();
    expect(push!.join(' ')).toContain('marker5678:refs/heads/dxkit/remediate-fix-build');
    const commitTree = calls.find((c) => c[0] === 'git' && c.includes('commit-tree'))!;
    expect(commitTree).toContain('branchhead'); // never the local HEAD
    const checkoutIdx = calls.findIndex((c) => c[0] === 'git' && c.includes('--detach'));
    expect(calls.indexOf(push!)).toBeLessThan(checkoutIdx);
  });

  it('a failed attempt-row publish still resumes, with the cap risk disclosed', () => {
    const { exec } = fakeExec({ openPr: true, markers: 0, failPush: true });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(true);
    expect(d.note).toContain('attempt counter could not advance');
  });

  it('rows of ANOTHER task on the ledger never count toward this task', () => {
    const { exec } = fakeExec({
      openPr: true,
      markers: MAX_RESUME_ATTEMPTS,
      rowsTask: 'fix-vulns',
    });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d).toEqual({ resumed: true, attempt: 1 });
  });

  it('carries the prior attempt blocking findings from the draft-PR ledger into the decision', () => {
    const body =
      'outcome: **budget-exhausted**\n\nBlocking findings:\n- [dep-vuln] form-data GHSA-1\n- [test-gap] src/x.js\n\nrest';
    const { exec } = fakeExec({ openPr: true, markers: 0, prBody: body });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(true);
    expect(d.blockingContext).toContain('form-data GHSA-1');
    expect(d.blockingContext).toContain('src/x.js');
    // and it reaches the resumed prompt
    expect(resumePromptNote(d.attempt!, d.blockingContext)).toContain('BLOCKED by the guardrail');
  });

  it('a guardrail-red draft is NOT a resume anchor: fresh run, blocking set carried as a negative constraint, counter ADVANCED', () => {
    const body =
      'Task: **fix-vulns** — outcome: **guardrail-red**\n\nBlocking findings:\n- [secret] src/config.ts\n';
    const { exec, calls } = fakeExec({ openPr: true, markers: 0, prBody: body });
    const d = prepareResume('/repo', 'fix-vulns', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('guardrail-red');
    expect(d.note).toContain('budget-exhausted');
    expect(d.note).toContain('attempt 1 of');
    expect(d.attempt).toBe(1);
    expect(d.blockingContext).toContain('src/config.ts');
    // No checkout: the tree is untouched on a refused resume — but the
    // attempt counter STILL advances (a ledger row on the non-landing channel,
    // pushed), or a guardrail-red chain never reaches the escalation cap
    // and re-spends a full budget on the same unfixable finding forever.
    expect(calls.some((c) => c[0] === 'git' && c.includes('--detach'))).toBe(false);
    expect(calls.some((c) => c[0] === 'git' && c.includes('commit-tree'))).toBe(true);
    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push');
    expect(push).toBeDefined();
    expect(push!.join(' ')).toContain('marker5678:refs/heads/');
  });

  it('a guardrail-red chain reaches the attempt cap: human escalation, no more attempt spend', () => {
    const body = 'Task: **fix-vulns** — outcome: **guardrail-red**\n';
    const { exec, calls } = fakeExec({
      openPr: true,
      markers: MAX_RESUME_ATTEMPTS,
      prBody: body,
    });
    const d = prepareResume('/repo', 'fix-vulns', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('review or close the draft PR');
    expect(d.note).toContain(`cap ${MAX_RESUME_ATTEMPTS}`);
    expect(calls.some((c) => c[0] === 'git' && c.includes('commit-tree'))).toBe(false);
  });

  it('an open PR whose ledger outcome is verified (or unreadable) starts fresh, disclosed', () => {
    const { exec } = fakeExec({ openPr: true, markers: 0, prBody: 'outcome: **verified**' });
    const d = prepareResume('/repo', 'fix-vulns', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain("'verified'");
    const unreadable = fakeExec({ openPr: true, markers: 0, prBody: 'no ledger here' });
    const d2 = prepareResume('/repo', 'fix-vulns', ON, unreadable.exec);
    expect(d2.resumed).toBe(false);
    expect(d2.note).toContain('unknown');
  });

  it('extractLedgerOutcome is anchored to the ledger line, never a prose mention of an outcome word', () => {
    const prose =
      '- earlier attempt discussion mentions outcome: **verified** in passing\n' +
      'Task: **fix-vulns** — outcome: **budget-exhausted**\n';
    const { exec } = fakeExec({ openPr: true, markers: 0, prBody: prose });
    // The mid-line prose mention must not win: the real ledger line says
    // budget-exhausted, so this RESUMES.
    const d = prepareResume('/repo', 'fix-vulns', ON, exec);
    expect(d.resumed).toBe(true);
  });

  it('any git/gh failure → fresh run, never a throw', () => {
    const { exec } = fakeExec({ openPr: true, failFetch: true });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(false);
    expect(d.note).toContain('resume unavailable');
  });
});

// ─── The attribution law through the runner ─────────────────────────────────

const TRUSTED = { repoExecutionAllowed: true, source: 'local-workspace' } as AnalysisTrustContext;
const GREEN: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED: CorrectnessFloorResult = {
  ran: true,
  checks: [{ pack: 'typescript', label: 'tests', bin: 'npx', status: 'fail' }] as never,
  blocks: true,
};

function fakeGit(): RemediateGit {
  let head = 'salvage00';
  return {
    head: () => head,
    sweepLeftovers: () => undefined,
    scrubRuntimeArtifacts: () => [],
    enforceEnvelope: () => ({ dropped: [] }),
    resetTo: () => {},
    changedPaths: () => [],
    commitPaths: () => {},
    cleanPaths: () => {},
    revertPaths: () => {},
    revertRange: () => {},
    hasDiff: () => {
      head = 'salvage01';
      return true;
    },
  };
}

function fakeDriver(): AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } {
  const driver: AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      driver.lastRun = opts;
      return { completed: true, timedOut: false, transcriptTail: '' } as AgentRunResult;
    },
  };
  return driver;
}

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-vulns'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'draft-pr',
    agent: { driver: 'fake-agent', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    maxOrdersPerRun: 0,
    pauseAfterFailures: 0,
    resume: true,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

describe('runRemediateTask — resumed attempts', () => {
  it('uses the PRE-CAPTURED pristine entry floor: a partial that broke the build reads NET-NEW', async () => {
    // Entry (pristine base) was GREEN; the verify floor on the salvage tree is
    // RED — resuming must attribute that as net-new (floor-red), never
    // grandfather it as pre-existing.
    const r = await runRemediateTask({
      cwd: '/tmp/fake',
      trust: TRUSTED,
      taskId: 'fix-vulns',
      config: config(),
      drivers: [fakeDriver()],
      git: fakeGit(),
      entryFloor: GREEN,
      resume: { attempt: 1 },
      runFloor: () => RED, // only the verify side runs — entry came in
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
      verifySeams: {
        worktree: async <T>(_o: unknown, fn: (wt: string) => Promise<T>) =>
          fn('/tmp/fake-worktree'),
        install: () => ({
          status: 'installed' as const,
          steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
        }),
        changedFiles: () => ['src/a.ts'],
      },
    });
    expect(r.outcome).toBe('floor-red');
    expect(r.resume).toEqual({ attempt: 1 });
  });

  it('tells the agent to CONTINUE, and the ledger discloses the resumed attempt', async () => {
    const driver = fakeDriver();
    const r = await runRemediateTask({
      cwd: '/tmp/fake',
      trust: TRUSTED,
      taskId: 'fix-vulns',
      config: config(),
      drivers: [driver],
      git: fakeGit(),
      entryFloor: GREEN,
      resume: { attempt: 2 },
      runFloor: () => GREEN,
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
      verifySeams: {
        worktree: async <T>(_o: unknown, fn: (wt: string) => Promise<T>) =>
          fn('/tmp/fake-worktree'),
        install: () => ({
          status: 'installed' as const,
          steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
        }),
        changedFiles: () => ['src/a.ts'],
      },
    });
    expect(r.outcome).toBe('verified');
    expect(driver.lastRun?.prompt).toContain('RESUMED ATTEMPT #2');
    expect(driver.lastRun?.prompt).toContain('do not redo');
    expect(r.ledger).toContain('Resumed budget-bounded attempt #2');
  });

  it('the prompt-note helper names the attempt and the notes file', () => {
    const note = resumePromptNote(1);
    expect(note).toContain('#1');
    expect(note).toContain('DXKIT-REMEDIATION-NOTES.md');
  });
});
