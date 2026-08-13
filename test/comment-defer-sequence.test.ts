import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { workingTreeSignature } from '../src/loop/gate-cache';

/**
 * #282 — the comment-defer workflow defeated its own same-tree contract:
 * its steps redirected scratch output (a stderr log, the defer JSON) into
 * the repo root, and the defer's freshness key (`workingTreeSignature`)
 * is deliberately content-complete over untracked files — so the check's
 * own scratch files perturbed the signature and the defer refused
 * STRUCTURALLY, every run. Two pins:
 *
 *   1. the workflow-sequence property, on the signature itself: writing
 *      scratch OUTSIDE the repo leaves it stable (the shipped sequence
 *      can defer); an untracked file INSIDE still perturbs it (a
 *      genuinely edited tree still refuses — the contract is intact);
 *   2. the shipped template's redirects all target $RUNNER_TEMP — no
 *      bare redirect into the checkout can return.
 */

describe('comment-defer same-tree sequence (#282)', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-defer-seq-'));
    outside = mkdtempSync(join(tmpdir(), 'dxkit-defer-tmp-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('scratch files OUTSIDE the repo leave the signature stable; INSIDE perturbs it', () => {
    const before = workingTreeSignature(dir);
    expect(before).not.toBeNull();

    // The FIXED sequence: check writes stderr + JSON to $RUNNER_TEMP.
    writeFileSync(join(outside, 'guardrail-stderr.log'), 'noise\n');
    writeFileSync(join(outside, 'comment-defer.json'), '{}');
    expect(workingTreeSignature(dir)).toBe(before);

    // The BROKEN sequence (and any genuine edit): an untracked file in
    // the checkout MUST still change the signature — the same-tree
    // contract is the point, not the casualty.
    writeFileSync(join(dir, 'guardrail-stderr.log'), 'noise\n');
    expect(workingTreeSignature(dir)).not.toBe(before);
  });

  it('the shipped template writes ALL scratch output to $RUNNER_TEMP', () => {
    const template = readFileSync(
      join(__dirname, '..', 'src-templates', '.github', 'workflows', 'dxkit-comment-defer.yml'),
      'utf8',
    );
    // Every redirect of the two scratch names targets $RUNNER_TEMP.
    for (const line of template.split('\n')) {
      if (
        /[>]\s*"?[^"]*guardrail-stderr\.log/.test(line) ||
        /[>]\s*"?[^"]*comment-defer/.test(line)
      ) {
        expect(line).toContain('$RUNNER_TEMP');
      }
    }
    // And the reply body is read back from the same place.
    expect(template).toContain('--body-file "$RUNNER_TEMP/comment-defer-reply.md"');
    // Positive control: the redirects still exist at all (the loop above
    // must have had something to check).
    expect(template).toContain('$RUNNER_TEMP/guardrail-stderr.log');
    expect(template).toContain('$RUNNER_TEMP/comment-defer.json');
  });
});

describe('the mismatch diagnostic names the perturbing paths (#282 residual)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-defer-diag-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function cacheVerdictNow(): Promise<void> {
    const { writeVerdict } = await import('../src/baseline/verdict-cache');
    const { DEFAULT_BROWNFIELD_POLICY } = await import('../src/baseline/policy');
    writeVerdict(dir, DEFAULT_BROWNFIELD_POLICY, {
      blocks: true,
      warns: false,
      blockingCount: 1,
      unattributableCount: 0,
      warningCount: 0,
      markdown: '## dxkit signals',
      ranAt: '2026-08-13T00:00:00.000Z',
      blockingFindings: [{ fingerprint: 'aaaa000011112222', kind: 'dep-vuln', status: 'added' }],
    });
  }

  it('a scratch file written after the check is NAMED in the miss explanation', async () => {
    const { explainVerdictMiss } = await import('../src/baseline/verdict-cache');
    await cacheVerdictNow();
    expect(explainVerdictMiss(dir)).toBeNull(); // tree unchanged → no miss
    writeFileSync(join(dir, 'guardrail-stderr.log'), 'noise\n');
    const miss = explainVerdictMiss(dir)!;
    expect(miss).not.toBeNull();
    expect(miss.newPaths).toEqual(['guardrail-stderr.log']);
    expect(miss.clearedPaths).toEqual([]);
  });

  it('the full lifecycle: check → scratch INSIDE the repo → defer refuses NAMING the path', async () => {
    const { executeDefer } = await import('../src/allowlist/defer-core');
    await cacheVerdictNow();
    // The broken workflow sequence: a scratch file lands in the checkout
    // between check and defer.
    writeFileSync(join(dir, 'comment-defer.json'), '{}');
    const result = executeDefer(dir, {
      reason: 'advisory wave',
      expires: '+7d',
      fromLastCheck: true,
      addedBy: 't@example.com',
      mode: 'full',
    });
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.message;
    expect(message).toContain('No cached guardrail verdict');
    // The 30-second diagnosis: the perturbing path is NAMED, with the cause.
    expect(message).toContain('comment-defer.json');
    expect(message).toContain('write them outside the repo');
  });

  it('the fixed lifecycle: check → scratch OUTSIDE → defer succeeds', async () => {
    const { executeDefer } = await import('../src/allowlist/defer-core');
    await cacheVerdictNow();
    const result = executeDefer(dir, {
      reason: 'advisory wave',
      expires: '+7d',
      fromLastCheck: true,
      addedBy: 't@example.com',
      mode: 'full',
    });
    expect(result.ok).toBe(true);
  });
});
