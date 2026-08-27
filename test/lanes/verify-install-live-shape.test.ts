import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describeInstall, runDeclaredInstall, verifyTree } from '../../src/lanes/verify-tree';
import { getLanguage } from '../../src/languages';
import { resolveTolerances } from '../../src/install/tolerances';
import { installFailedNote } from '../../src/remediate/verify';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';

/**
 * The live shape (the first real remediate run on a customer-shaped estate,
 * 2026-08-27), replayed through the REAL node strategy, the REAL executor
 * and the REAL verification composition with npm's recorded outputs:
 *
 *   - the estate's default branch carries a peer conflict its own install
 *     tolerates: `npm ci` fails with ERESOLVE, `npm ci --legacy-peer-deps`
 *     installs;
 *   - a candidate with an applied override pin (lockfile re-synced) has the
 *     same shape and must VERIFY, via the disclosed fallback, never
 *     `install-failed`;
 *   - a candidate whose lockfile was hand-edited fails `npm ci` with EUSAGE
 *     ("Missing: ... from lock file"): no fallback answers that, the failure
 *     is reported against the PRIMARY (the live ledger named the fallback,
 *     which read as "the peer-conflict fallback is missing"), and the base
 *     probe attributes it net-new because the base installs;
 *   - with the peer-conflict tolerance withdrawn by policy, the same base
 *     fails on both sides identically and reads pre-existing, with the
 *     policy remedy named.
 */

const TS = getLanguage('typescript')!;
const TRUSTED = { repoExecutionAllowed: true, source: 'local-workspace' } as AnalysisTrustContext;
const GREEN: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };

// Recorded from the live run (package names are the real ones npm printed).
const ERESOLVE = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE could not resolve',
  'npm error peer @react-three/fiber@"^9.0.0" from @react-three/drei@10.7.7',
  'npm error Conflicting peer dependency: @react-three/fiber@9.7.0',
  'npm error Fix the upstream dependency conflict, or retry',
  'npm error this command with --force or --legacy-peer-deps',
].join('\n');
const EUSAGE = [
  'npm error code EUSAGE',
  'npm error',
  'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
  'npm error Missing: memfs@4.68.1 from lock file',
  'npm error Missing: @jsonjoy.com/base64@1.1.2 from lock file',
  'npm error',
  'npm error Clean install a project',
].join('\n');

/** A fake npm keyed on the worktree: the base and the pinned candidate carry
 *  the tolerated peer conflict; the hand-edited candidate carries drift. */
function fakeNpm(drifted: ReadonlySet<string>): { exec: CommandExec; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd, cwd) => {
      const argv = [cmd.bin, ...cmd.args].join(' ');
      calls.push(`${cwd}: ${argv}`);
      if (drifted.has(cwd)) return { available: true, code: 1, output: EUSAGE };
      if (argv === 'npm ci') return { available: true, code: 1, output: ERESOLVE };
      return { available: true, code: 0, output: 'added 2 packages' };
    },
  };
}

function repo(policy?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-live-shape-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"estate","overrides":{"ws":"8.18.0"}}');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  if (policy !== undefined) {
    mkdirSync(join(dir, '.dxkit'));
    writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy));
  }
  return dir;
}

describe('the live shape: a tolerated peer conflict, an applied pin, a hand-edited lockfile', () => {
  it('the base and a pinned candidate install through the disclosed fallback; the verdict proceeds normally', async () => {
    const dir = repo();
    const { exec, calls } = fakeNpm(new Set());
    try {
      const r = await verifyTree({
        cwd: dir,
        head: 'head1111',
        baseHead: 'base0000',
        trust: TRUSTED,
        entryFloor: GREEN,
        absentMeans: 'net-new',
        seams: {
          worktree: async (_o, fn) => fn(dir),
          install: (wt) => runDeclaredInstall(wt, exec, [TS], resolveTolerances(wt)),
          changedFiles: () => ['package.json', 'package-lock.json'],
          runFloor: () => GREEN,
          runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
        },
      });
      expect(r.verdict).toBe('verified');
      expect(calls).toEqual([`${dir}: npm ci`, `${dir}: npm ci --legacy-peer-deps`]);
      expect(r.install?.status).toBe('installed');
      const line = describeInstall(r.install)!;
      expect(line).toContain('`npm ci` failed, `npm ci --legacy-peer-deps` succeeded');
      expect(line).toContain('peer-conflict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hand-edited lockfile is install-failed against `npm ci` (lockfile-drift), net-new because the base installs', async () => {
    const candidate = repo();
    const base = repo();
    const { exec, calls } = fakeNpm(new Set([candidate]));
    try {
      const r = await verifyTree({
        cwd: candidate,
        head: 'head1111',
        baseHead: 'base0000',
        trust: TRUSTED,
        entryFloor: GREEN,
        absentMeans: 'net-new',
        seams: {
          worktree: async (o, fn) => fn(o.ref === 'base0000' ? base : candidate),
          install: (wt) => runDeclaredInstall(wt, exec, [TS], resolveTolerances(wt)),
          changedFiles: () => ['package-lock.json'],
          runFloor: () => GREEN,
          runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
        },
      });
      expect(r.verdict).toBe('install-failed');
      // The candidate ran the PRIMARY only (no fallback answers drift); the
      // base probe ran the primary and its fallback and installed.
      expect(calls).toEqual([
        `${candidate}: npm ci`,
        `${base}: npm ci`,
        `${base}: npm ci --legacy-peer-deps`,
      ]);
      expect(r.install?.status).toBe('failed');
      if (r.install?.status === 'failed') {
        expect(r.install.argv).toEqual(['npm', 'ci']);
        expect(r.install.classification).toBe('lockfile-drift');
        expect(r.install.attribution).toBe('net-new');
        expect(r.install.base?.status).toBe('installed');
      }
      const line = describeInstall(r.install)!;
      expect(line).toContain('`npm ci` FAILED');
      expect(line).toContain('lockfile-drift');
      expect(line).toContain('The base installs');
      // The lane's own note names the primary, never the fallback.
      const note = installFailedNote(r);
      expect(note).toContain('(`npm ci` failed, lockfile-drift)');
      expect(note).not.toContain('--legacy-peer-deps` failed');
      expect(note).toContain('Missing: memfs@4.68.1 from lock file');
    } finally {
      rmSync(candidate, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('with the tolerance withdrawn by policy, an identical failure on both sides is pre-existing and names the remedy', async () => {
    const policy = { dependencies: { tolerate: [] } };
    const candidate = repo(policy);
    const base = repo(policy);
    const { exec, calls } = fakeNpm(new Set());
    try {
      const r = await verifyTree({
        cwd: candidate,
        head: 'head1111',
        baseHead: 'base0000',
        trust: TRUSTED,
        entryFloor: GREEN,
        absentMeans: 'net-new',
        seams: {
          worktree: async (o, fn) => fn(o.ref === 'base0000' ? base : candidate),
          install: (wt) => runDeclaredInstall(wt, exec, [TS], resolveTolerances(wt)),
          changedFiles: () => ['package.json'],
          runFloor: () => GREEN,
          runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
        },
      });
      // Nothing retried on either side: the class is not authorized.
      expect(calls).toEqual([`${candidate}: npm ci`, `${base}: npm ci`]);
      expect(r.verdict).toBe('verified');
      expect(r.floorSkipped?.reason).toBe('unprovisioned');
      if (r.install?.status === 'failed') {
        expect(r.install.classification).toBe('peer-conflict');
        expect(r.install.attribution).toBe('pre-existing');
        expect(r.install.unauthorizedRemedy).toContain('dependencies.tolerate');
      }
      expect(describeInstall(r.install)).toContain('peer-conflict on both sides');
      expect(describeInstall(r.install)).toContain('dependencies.tolerate');
    } finally {
      rmSync(candidate, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
