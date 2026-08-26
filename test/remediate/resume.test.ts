/**
 * Resume-from-salvage (opt-in): the eligibility ladder, the resume cap, and
 * the attribution law (entry floor anchored to the pristine base) through
 * the runner.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_RESUME_ATTEMPTS,
  RESUME_MARKER,
  prepareResume,
  resumePromptNote,
  type ResumeExec,
} from '../../src/remediate/resume';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';

function fakeExec(opts: {
  openPr?: boolean;
  markers?: number;
  failFetch?: boolean;
  failPush?: boolean;
  prBody?: string;
}): {
  exec: ResumeExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ResumeExec = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'gh') {
      if (!opts.openPr) return '[]';
      // Default body: a budget-exhausted verified partial — the ONE outcome
      // that is a resume anchor (design F).
      return JSON.stringify([
        { url: 'https://x/pr/1', body: opts.prBody ?? 'outcome: **budget-exhausted**' },
      ]);
    }
    if (bin === 'git' && args[0] === 'fetch') {
      if (opts.failFetch) throw new Error('fetch failed');
      return '';
    }
    if (bin === 'git' && args[0] === 'push') {
      if (opts.failPush) throw new Error('push rejected');
      return '';
    }
    if (bin === 'git' && args[0] === 'rev-list') return String(opts.markers ?? 0);
    if (bin === 'git' && args.includes('rev-parse')) return 'tree1234';
    if (bin === 'git' && args.includes('commit-tree')) return 'marker5678';
    return '';
  };
  return { exec, calls };
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

  it('eligible → detached checkout + a marker commit, attempt = priors + 1', () => {
    const { exec, calls } = fakeExec({ openPr: true, markers: 1 });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d).toEqual({ resumed: true, attempt: 2 });
    expect(calls.some((c) => c[0] === 'git' && c.includes('--detach'))).toBe(true);
    const commit = calls.find((c) => c[0] === 'git' && c.includes('commit'));
    expect(commit).toBeDefined();
    expect(commit!.join(' ')).toContain(RESUME_MARKER);
    expect(commit!.join(' ')).toContain('--allow-empty');
  });

  it('the attempt marker is PUSHED immediately — a no-op resume still consumes an attempt', () => {
    // Observed live: the marker only reached the remote when a landing
    // force-pushed, so runs 2 and 3 both announced attempt #1 and the
    // MAX_RESUME_ATTEMPTS cap was unreachable — a doomed branch resumed
    // (and spent) forever.
    const { exec, calls } = fakeExec({ openPr: true, markers: 0 });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(true);
    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push');
    expect(push).toBeDefined();
    expect(push!.join(' ')).toContain('HEAD:refs/heads/');
    // The push happens AFTER the marker commit — it carries the counter.
    const commitIdx = calls.findIndex((c) => c[0] === 'git' && c.includes('commit'));
    expect(calls.indexOf(push!)).toBeGreaterThan(commitIdx);
  });

  it('a failed marker push still resumes, with the cap risk disclosed', () => {
    const { exec } = fakeExec({ openPr: true, markers: 0, failPush: true });
    const d = prepareResume('/repo', 'fix-build', ON, exec);
    expect(d.resumed).toBe(true);
    expect(d.note).toContain('attempt marker could not be pushed');
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
    // attempt counter STILL advances (a content-free commit-tree marker,
    // pushed), or a guardrail-red chain never reaches the escalation cap
    // and re-spends a full budget on the same unfixable finding forever.
    expect(calls.some((c) => c[0] === 'git' && c.includes('--detach'))).toBe(false);
    expect(calls.some((c) => c[0] === 'git' && c.includes('commit-tree'))).toBe(true);
    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push');
    expect(push).toBeDefined();
    expect(push!.join(' ')).toContain('marker5678:refs/heads/');
  });

  it('a guardrail-red chain reaches the attempt cap: human escalation, no more marker spend', () => {
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
        install: () => ({ status: 'installed' as const, argv: ['npm', 'ci'] }),
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
        install: () => ({ status: 'installed' as const, argv: ['npm', 'ci'] }),
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
