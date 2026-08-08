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
