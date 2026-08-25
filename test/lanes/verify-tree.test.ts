import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  describeInstall,
  runFrozenInstall,
  verifyTree,
  type InstallOutcome,
  type VerifyTreeOptions,
  type VerifyTreeSeams,
} from '../../src/lanes/verify-tree';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AnalysisTrustContext } from '../../src/analysis-trust';

/**
 * The ONE tree verification (4.4.5): a clean worktree of the candidate, the
 * repo's frozen install, the diff-scoped floor attributed vs entry, the
 * guardrail. Every step is injected here so the COMPOSITION is what is
 * pinned: an install that fails is its own verdict and nothing downstream
 * runs; an infrastructure failure is a disclosed step failure, never a pass
 * and never a false block; and the floor sees the worktree + the real diff,
 * not the lane's dirty cwd with an empty changed-set.
 */

const TRUSTED = { repoExecutionAllowed: true, source: 'local-workspace' } as AnalysisTrustContext;
const GREEN: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED: CorrectnessFloorResult = {
  ran: true,
  checks: [{ pack: 'typescript', label: 'typecheck', bin: 'npx', status: 'fail' }],
  blocks: true,
};
const INSTALLED: InstallOutcome = { status: 'installed', argv: ['npm', 'ci'] };

function seams(over: Partial<VerifyTreeSeams> = {}): VerifyTreeSeams {
  return {
    worktree: async (_o, fn) => fn('/tmp/dxkit-fake-worktree'),
    install: () => INSTALLED,
    changedFiles: () => ['src/a.ts'],
    runFloor: () => GREEN,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    ...over,
  };
}

function opts(over: Partial<VerifyTreeOptions> = {}): VerifyTreeOptions {
  return {
    cwd: '/tmp/fake-repo',
    head: 'head1111',
    baseHead: 'base0000',
    trust: TRUSTED,
    entryFloor: GREEN,
    absentMeans: 'net-new',
    seams: seams(),
    ...over,
  };
}

describe('verifyTree', () => {
  it('verified: install ok, floor net-new-clean, guardrail passes', async () => {
    const r = await verifyTree(opts());
    expect(r.verdict).toBe('verified');
    expect(r.install).toEqual(INSTALLED);
    expect(r.changedFiles).toEqual(['src/a.ts']);
    expect(r.guardrail?.verdict).toBe('PASSED');
    expect(r.failure).toBeUndefined();
  });

  it('install-failed: a failed frozen install is its own verdict and NOTHING downstream runs', async () => {
    let floorRan = false;
    let guardrailRan = false;
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => ({
            status: 'failed',
            argv: ['npm', 'ci', '--legacy-peer-deps'],
            output: 'npm ERR! code EUSAGE\nnot in sync',
          }),
          runFloor: () => {
            floorRan = true;
            return GREEN;
          },
          runGuardrail: async () => {
            guardrailRan = true;
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('install-failed');
    expect(r.install?.status).toBe('failed');
    expect(floorRan).toBe(false);
    expect(guardrailRan).toBe(false);
    expect(describeInstall(r.install)).toContain('FAILED on a clean checkout');
  });

  it('the fallback install is disclosed, never silent', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => ({
            status: 'installed',
            argv: ['npm', 'ci'],
            fallback: { argv: ['npm', 'ci', '--legacy-peer-deps'], reason: 'peer conflict' },
          }),
        }),
      }),
    );
    expect(r.verdict).toBe('verified');
    expect(describeInstall(r.install)).toContain('`npm ci --legacy-peer-deps` succeeded');
    expect(describeInstall(r.install)).toContain('peer conflict');
  });

  it('floor-red: a NET-NEW failure vs the entry floor blocks; the guardrail is not consulted', async () => {
    let guardrailRan = false;
    const r = await verifyTree(
      opts({
        seams: seams({
          runFloor: () => RED,
          runGuardrail: async () => {
            guardrailRan = true;
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('floor-red');
    expect(r.floorAttribution?.some((a) => a.attribution === 'net-new')).toBe(true);
    expect(guardrailRan).toBe(false);
  });

  it('pre-existing floor debt (red at entry too) does not block', async () => {
    const r = await verifyTree(opts({ entryFloor: RED, seams: seams({ runFloor: () => RED }) }));
    expect(r.verdict).toBe('verified');
    expect(r.floorAttribution?.every((a) => a.attribution === 'pre-existing')).toBe(true);
  });

  it('the floor runs IN THE WORKTREE with the REAL diff, diff-scoped (never cwd + [])', async () => {
    let seen: { cwd: string; changedFiles: readonly string[] } | undefined;
    const r = await verifyTree(
      opts({
        seams: seams({
          worktree: async (o, fn) => {
            expect(o).toEqual({ cwd: '/tmp/fake-repo', ref: 'head1111' });
            return fn('/tmp/wt-xyz');
          },
          changedFiles: (wt, base) => {
            expect(wt).toBe('/tmp/wt-xyz');
            expect(base).toBe('base0000');
            return ['package.json', 'src/b.ts'];
          },
          runFloor: (args) => {
            seen = args;
            return GREEN;
          },
          runGuardrail: async (wt) => {
            expect(wt).toBe('/tmp/wt-xyz');
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('verified');
    expect(seen).toEqual({ cwd: '/tmp/wt-xyz', changedFiles: ['package.json', 'src/b.ts'] });
  });

  it('guardrail-red: a BLOCKED guardrail', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
        }),
      }),
    );
    expect(r.verdict).toBe('guardrail-red');
  });

  it('error: a worktree that cannot be created is a DISCLOSED step failure, never a pass', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          worktree: async () => {
            throw new Error('Cannot resolve baseline ref head1111.');
          },
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure).toEqual({
      step: 'worktree',
      message: 'Cannot resolve baseline ref head1111.',
    });
    expect(r.install).toBeUndefined();
  });

  it('error: a package manager missing from the environment names the install step', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => {
            throw new Error('pnpm is not available in the verification environment');
          },
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure?.step).toBe('install');
    expect(r.failure?.message).toContain('pnpm is not available');
  });

  it('error: an unrunnable guardrail names the guardrail step', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          runGuardrail: async () => ({
            verdict: 'unavailable (boom)',
            ran: false,
            passesGate: false,
          }),
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure).toEqual({ step: 'guardrail', message: 'unavailable (boom)' });
  });

  it('reports steps in order through onStep', async () => {
    const steps: string[] = [];
    await verifyTree(opts({ onStep: (s) => steps.push(s) }));
    expect(steps).toEqual([
      'worktree',
      'install',
      'changed-files',
      'floor',
      'attribution',
      'guardrail',
    ]);
  });
});

describe('runFrozenInstall', () => {
  function repo(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-vt-'));
    for (const f of files) writeFileSync(join(dir, f), '{}');
    return dir;
  }

  it('primary succeeds → installed with the primary argv', () => {
    const dir = repo(['package.json', 'package-lock.json']);
    try {
      const argvs: string[] = [];
      const r = runFrozenInstall(dir, (cmd) => {
        argvs.push([cmd.bin, ...cmd.args].join(' '));
        return { available: true, code: 0, output: '' };
      });
      expect(r).toEqual({ status: 'installed', argv: ['npm', 'ci'] });
      expect(argvs).toEqual(['npm ci']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('primary fails, fallback succeeds → installed with the fallback disclosed (the CI `a || b`)', () => {
    const dir = repo(['package.json', 'package-lock.json']);
    try {
      const r = runFrozenInstall(dir, (cmd) =>
        cmd.args.includes('--legacy-peer-deps')
          ? { available: true, code: 0, output: '' }
          : { available: true, code: 1, output: 'npm ERR! code ERESOLVE' },
      );
      expect(r.status).toBe('installed');
      if (r.status === 'installed')
        expect(r.fallback?.argv).toEqual(['npm', 'ci', '--legacy-peer-deps']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both fail → failed, both outputs kept (the stale-lockfile class)', () => {
    const dir = repo(['package.json', 'package-lock.json']);
    try {
      const r = runFrozenInstall(dir, () => ({
        available: true,
        code: 1,
        output: 'npm ERR! code EUSAGE\nnpm ERR! package.json and package-lock.json are not in sync',
      }));
      expect(r.status).toBe('failed');
      if (r.status === 'failed') {
        expect(r.argv).toEqual(['npm', 'ci', '--legacy-peer-deps']);
        expect(r.output).toContain('EUSAGE');
        expect(r.output).toContain('--- fallback');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a package manager not on PATH throws (infrastructure, the caller discloses the step)', () => {
    const dir = repo(['package.json', 'pnpm-lock.yaml']);
    try {
      expect(() =>
        runFrozenInstall(dir, () => ({ available: false, code: -1, output: 'pnpm: not found' })),
      ).toThrow(/pnpm is not available/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no package.json → nothing to install, no command runs', () => {
    const dir = repo([]);
    try {
      let ran = false;
      const r = runFrozenInstall(dir, () => {
        ran = true;
        return { available: true, code: 0, output: '' };
      });
      expect(r).toEqual({ status: 'nothing-to-install' });
      expect(ran).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
