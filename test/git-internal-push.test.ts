import { describe, it, expect } from 'vitest';
import { internalGitPushArgs } from '../src/git-internal-push';

/**
 * The one constructor for a dxkit-internal machine push (gh #156). Its whole job
 * is to GUARANTEE `--no-verify` so the push never fires the repo's pre-push
 * guardrail hook. The arch-check bans a raw `['push', …]` git argv elsewhere, so
 * this is the single place the flag can be present or absent — pin it hard.
 */
describe('internalGitPushArgs (gh #156 — --no-verify is guaranteed)', () => {
  it('always emits --no-verify, immediately after push', () => {
    const args = internalGitPushArgs('HEAD:refs/heads/main');
    expect(args.slice(0, 2)).toEqual(['push', '--no-verify']);
    expect(args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/main']);
  });

  it('adds --force for a replace-all / non-fast-forward push, still with --no-verify', () => {
    expect(internalGitPushArgs('sha:refs/heads/dxkit-baselines', { force: true })).toEqual([
      'push',
      '--no-verify',
      '--force',
      'origin',
      'sha:refs/heads/dxkit-baselines',
    ]);
  });

  it('honors a custom remote', () => {
    expect(internalGitPushArgs('feature', { remote: 'upstream' })).toEqual([
      'push',
      '--no-verify',
      'upstream',
      'feature',
    ]);
  });

  it('--no-verify is present in EVERY shape (force × remote matrix)', () => {
    for (const force of [true, false]) {
      for (const remote of [undefined, 'origin', 'upstream']) {
        const args = internalGitPushArgs('ref', { force, ...(remote ? { remote } : {}) });
        expect(args[0]).toBe('push');
        expect(args).toContain('--no-verify');
      }
    }
  });
});
