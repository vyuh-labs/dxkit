/**
 * The lockfile-sync recipe: applied (resync install + the pack's frozen
 * dry-run confirms), refused (no lockfile, ambiguous root, unverifiable
 * pack), failed (dry-run still red), and the declared peer-conflict
 * fallback doctrine.
 */
import { describe, it, expect } from 'vitest';
import { executeLockfileSync } from '../../../src/remediate/recipes/lockfile-sync';
import { fakeExec, floorFinding, makeCtx, makeOrder, tempRepo } from './helpers';

const PKG = JSON.stringify({ name: 'fx', version: '1.0.0' });

function staleOrder(paths: string[] = ['package.json', 'package-lock.json']) {
  return makeOrder({
    id: 'stale-lockfile:typescript',
    class: 'stale-lockfile',
    findings: [floorFinding('typescript/lockfile-sync', 'typescript', 'lockfile-sync')],
    envelope: { paths, manifests: true },
  });
}

describe('lockfile-sync recipe', () => {
  it('applies: runs the lock-writing install, then the frozen dry-run confirms', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const outcome = await executeLockfileSync(staleOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.changedFiles).toEqual(['package-lock.json']);
    expect(calls[0].cmd.bin).toBe('npm');
    expect(calls[0].cmd.args).toEqual(['install', '--no-audit', '--no-fund']);
    // The verify is npm's non-installing frozen dry-run, from the ts pack.
    const verify = calls[calls.length - 1].cmd;
    expect(verify.args).toContain('--dry-run');
    expect(verify.args).toContain('ci');
  });

  it('retries under --legacy-peer-deps ONLY for a peer-conflict-shaped failure', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args.includes('install') && !cmd.args.includes('--legacy-peer-deps')) {
        return { code: 1, output: 'npm error ERESOLVE unable to resolve dependency tree' };
      }
      return undefined;
    });
    const outcome = await executeLockfileSync(staleOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    expect(calls.some((c) => c.cmd.args.includes('--legacy-peer-deps'))).toBe(true);
  });

  it('a non-peer install failure is a named failure, not a blanket retry', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args.includes('install')) return { code: 1, output: 'EACCES broken cache' };
      return undefined;
    });
    const outcome = await executeLockfileSync(staleOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.step).toBe('install');
    expect(calls.some((c) => c.cmd.args.includes('--legacy-peer-deps'))).toBe(false);
  });

  it('fails (never claims) when the frozen dry-run still rejects the tree', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec((cmd) => {
      if (cmd.args.includes('--dry-run')) return { code: 1, output: 'EUSAGE lock out of sync' };
      return undefined;
    });
    const outcome = await executeLockfileSync(staleOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.step).toBe('verify-lockfile-sync');
  });

  it('refuses when no lockfile exists (nothing to re-sync)', async () => {
    const cwd = tempRepo({ 'package.json': PKG });
    const { exec, calls } = fakeExec();
    const outcome = await executeLockfileSync(staleOrder(['package.json']), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('refuses an envelope naming two roots (ambiguous owner)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeLockfileSync(
      staleOrder(['package.json', 'sub/package.json']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('exactly one package.json');
  });

  it('a shrinkwrap-only root reports npm-shrinkwrap.json in changedFiles (4.4.7 review fix)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'npm-shrinkwrap.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeLockfileSync(
      staleOrder(['package.json', 'npm-shrinkwrap.json']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.changedFiles).toEqual(['npm-shrinkwrap.json']);
  });

  it('refuses a pack with no lockfile-sync check to verify with', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const order = makeOrder({
      id: 'stale-lockfile:go',
      class: 'stale-lockfile',
      findings: [floorFinding('go/lockfile-sync', 'go', 'lockfile-sync')],
    });
    const outcome = await executeLockfileSync(order, makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('go');
  });
});
