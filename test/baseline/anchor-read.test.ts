/**
 * The anchor READ discipline (Rule 11 applied to the one side-ref reader):
 * the network step is bounded (hard timeout) and prompt-free (both git
 * prompt paths disabled via noPromptGitEnv), because this read sits on the
 * pre-push guardrail path (the trend/projection history fetch), where a
 * stalled remote must degrade, never hang the push. Plus the per-process
 * absent-ref memo: a repo with no reports history pays the fetch attempt
 * once per process, and a publish invalidates the memo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readFromAnchorRef,
  publishFilesToAnchorRef,
  _resetAnchorReadMemo,
  type AnchorReadExec,
} from '../../src/baseline/anchor-publish';

beforeEach(() => {
  _resetAnchorReadMemo();
});

/** An exec spy that fails everything (no remote, no local refs). */
function failingExec(calls: Array<{ args: string[]; opts: Parameters<AnchorReadExec>[1] }>) {
  const exec: AnchorReadExec = (args, opts) => {
    calls.push({ args, opts });
    throw new Error('no such ref');
  };
  return exec;
}

describe('readFromAnchorRef exec discipline', () => {
  it('every git invocation carries the no-prompt env and a bounded timeout', () => {
    const calls: Array<{ args: string[]; opts: Parameters<AnchorReadExec>[1] }> = [];
    const out = readFromAnchorRef(
      '/repo-a',
      'dxkit-reports',
      'report-history.jsonl',
      failingExec(calls),
    );
    expect(out).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    for (const { opts } of calls) {
      // Bounded: a stalled remote fails fast instead of hanging the push.
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(opts.timeoutMs).toBeLessThanOrEqual(60_000);
      // Prompt-free: HTTPS credential prompt off; the SSH side rides
      // noPromptGitEnv's GIT_SSH_COMMAND when configured.
      expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(opts.cwd).toBe('/repo-a');
    }
    // The fetch is the first call and targets the explicit private refspec.
    expect(calls[0].args[0]).toBe('fetch');
    expect(calls[0].args).toContain('--depth=1');
  });

  it('memoizes an ABSENT ref per process: the second read makes no git calls at all', () => {
    const calls: Array<{ args: string[]; opts: Parameters<AnchorReadExec>[1] }> = [];
    const exec = failingExec(calls);
    expect(readFromAnchorRef('/repo-b', 'dxkit-reports', 'report-history.jsonl', exec)).toBeNull();
    const afterFirst = calls.length;
    expect(readFromAnchorRef('/repo-b', 'dxkit-reports', 'latest/impact.md', exec)).toBeNull();
    expect(calls.length).toBe(afterFirst); // nothing re-probed
  });

  it('does NOT memoize when the ref exists but the file is absent (another path must still read)', () => {
    const calls: Array<{ args: string[]; opts: Parameters<AnchorReadExec>[1] }> = [];
    const exec: AnchorReadExec = (args, opts) => {
      calls.push({ args, opts });
      if (args[0] === 'rev-parse') return 'deadbeef\n'; // the ref exists
      throw new Error(args[0] === 'show' ? 'path does not exist' : 'offline');
    };
    expect(readFromAnchorRef('/repo-c', 'dxkit-reports', 'missing.json', exec)).toBeNull();
    const afterFirst = calls.length;
    // A second read probes again: the ref was there, only the file was not.
    expect(readFromAnchorRef('/repo-c', 'dxkit-reports', 'other.json', exec)).toBeNull();
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('a publish to the same cwd+ref invalidates the absent memo', () => {
    const calls: Array<{ args: string[]; opts: Parameters<AnchorReadExec>[1] }> = [];
    const exec = failingExec(calls);
    expect(readFromAnchorRef('/repo-d', 'dxkit-reports', 'x', exec)).toBeNull();
    const afterFirst = calls.length;
    // The publish attempt (even one that fails internally) must clear the
    // memo so the next read probes again.
    publishFilesToAnchorRef({
      cwd: '/repo-d',
      anchorRef: 'dxkit-reports',
      files: [{ path: 'x', content: 'y' }],
      message: 'test',
      _exec: () => {
        throw new Error('not a repo');
      },
    });
    expect(readFromAnchorRef('/repo-d', 'dxkit-reports', 'x', exec)).toBeNull();
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});
