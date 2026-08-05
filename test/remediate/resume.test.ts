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

function fakeExec(opts: { openPr?: boolean; markers?: number; failFetch?: boolean }): {
  exec: ResumeExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ResumeExec = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'gh') return opts.openPr ? '[{"url":"https://x/pr/1"}]' : '[]';
    if (bin === 'git' && args[0] === 'fetch') {
      if (opts.failFetch) throw new Error('fetch failed');
      return '';
    }
    if (bin === 'git' && args[0] === 'rev-list') return String(opts.markers ?? 0);
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
    resume: true,
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
