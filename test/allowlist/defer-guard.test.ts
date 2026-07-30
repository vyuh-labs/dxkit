/**
 * The deferral creation guard — the advisories a caller gets at the moment they
 * time-box a finding, and the one hard refusal.
 *
 * The class: a deferral is a promise ("we will fix this before <date>") and
 * nothing ever said whether the promise was keepable. On the repo that produced
 * this, 21 dependency advisories were deferred for six days with no remediation
 * lane enabled; all 21 returned on the same morning and blocked every open PR.
 * Every fact needed to see that coming was available at the keystroke.
 *
 * Pinned here: each advisory fires on its own condition, stays silent when the
 * condition does not hold (an advisory that always fires is an advisory nobody
 * reads), and reaches BOTH front-ends from the one core — the local CLI and the
 * `/dxkit defer` PR reply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { executeDefer } from '../../src/allowlist/defer-core';
import { deferAdvisories } from '../../src/allowlist/defer-guard';
import { runCommentDeferCore } from '../../src/allowlist/comment-defer';
import { loadAllowlist } from '../../src/allowlist/file';
import { DEFER_ADVISORY_EXPIRY_DAYS } from '../../src/allowlist/categories';
import { writeVerdict } from '../../src/baseline/verdict-cache';
import type { CachedBlockingFinding } from '../../src/baseline/verdict-cache';
import type { BrownfieldPolicy } from '../../src/baseline/policy';

const NOW = new Date('2026-07-22T09:00:00Z');

const tmps: string[] = [];
function mkRepo(policy?: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-defer-guard-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 'dev'], { cwd: d });
  fs.writeFileSync(path.join(d, 'app.js'), 'const x = 1;\n');
  if (policy) {
    fs.mkdirSync(path.join(d, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(d, '.dxkit', 'policy.json'), JSON.stringify(policy, null, 2));
  }
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const DEP_A: CachedBlockingFinding = {
  fingerprint: 'aaaa000000000001',
  kind: 'dep-vuln',
  status: 'newly_published_advisory',
  severity: 'high',
  locator: 'fast-uri@3.1.2 · GHSA-aaaa-bbbb-cccc',
};
const DEP_B: CachedBlockingFinding = {
  fingerprint: 'aaaa000000000002',
  kind: 'dep-vuln',
  status: 'newly_published_advisory',
  severity: 'medium',
  locator: 'svgo@1.3.2 · GHSA-dddd-eeee-ffff',
};

function seedVerdict(cwd: string, blockingFindings: CachedBlockingFinding[]): void {
  writeVerdict(cwd, {} as unknown as BrownfieldPolicy, {
    blocks: blockingFindings.length > 0,
    warns: false,
    blockingCount: blockingFindings.length,
    unattributableCount: 0,
    warningCount: 0,
    markdown: '## dxkit signals',
    ranAt: NOW.toISOString(),
    blockingFindings,
  });
}

describe('deferAdvisories', () => {
  it('names the batch-lapse property when more than one finding shares the window', () => {
    const d = mkRepo();
    const out = deferAdvisories(d, { count: 21, expiresAt: '2026-07-28', now: NOW });
    expect(out.some((a) => a.includes('All 21 findings share one expiry'))).toBe(true);
    expect(out.some((a) => a.includes('2026-07-28'))).toBe(true);
  });

  it('stays quiet about batching for a single finding', () => {
    const d = mkRepo();
    const out = deferAdvisories(d, { count: 1, expiresAt: '2026-07-28', now: NOW });
    expect(out.some((a) => a.includes('share one expiry'))).toBe(false);
  });

  it('warns when no remediation lane exists to close the findings', () => {
    const d = mkRepo();
    const out = deferAdvisories(d, { count: 9, expiresAt: '2026-07-28', now: NOW });
    const lane = out.find((a) => a.includes('No automated remediation lane'));
    expect(lane).toBeDefined();
    // States the consequence and both escape hatches, not just the fact.
    expect(lane).toContain('whoever opens a PR that day inherits them');
    expect(lane).toContain('depBump.enabled');
    expect(lane).toContain('remediate.enabled');
  });

  it('goes silent about lanes once the bump lane is enabled with a full cycle of room', () => {
    const d = mkRepo({ depBump: { enabled: true } });
    const out = deferAdvisories(d, { count: 9, expiresAt: '2026-08-05', now: NOW });
    expect(out.some((a) => a.includes('No automated remediation lane'))).toBe(false);
    expect(out.some((a) => a.includes('runs weekly'))).toBe(false);
  });

  it('warns when the window shuts before the weekly bump lane can run', () => {
    const d = mkRepo({ depBump: { enabled: true } });
    const out = deferAdvisories(d, { count: 9, expiresAt: '2026-07-25', now: NOW });
    const cadence = out.find((a) => a.includes('runs weekly'));
    expect(cadence).toBeDefined();
    expect(cadence).toContain('3-day window');
    expect(cadence).toContain(`+${DEFER_ADVISORY_EXPIRY_DAYS}d`);
  });

  it('warns that a same-day window is over tomorrow', () => {
    const d = mkRepo({ remediate: { enabled: true } });
    const out = deferAdvisories(d, { count: 1, expiresAt: '2026-07-22', now: NOW });
    expect(out.some((a) => a.includes('closes TODAY'))).toBe(true);
  });

  it('says nothing at all when the deferral is unremarkable', () => {
    const d = mkRepo({ remediate: { enabled: true } });
    expect(deferAdvisories(d, { count: 1, expiresAt: '2026-08-05', now: NOW })).toEqual([]);
  });
});

describe('executeDefer — the past-expiry refusal', () => {
  it('refuses a window that already closed rather than writing a dead entry', () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A]);
    const result = executeDefer(
      d,
      {
        fingerprints: [DEP_A.fingerprint],
        reason: 'backdated by mistake',
        expires: '2026-07-01',
        addedBy: 'dev@example.com',
        mode: 'full',
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('already in the past');
      expect(result.message).toContain('would suppress nothing');
    }
    // And nothing was written — the caller's intent failed loudly, not quietly.
    expect(loadAllowlist(d)).toBeNull();
  });

  it('accepts a window closing today (the expiry is inclusive, so it still suppresses)', () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A]);
    const result = executeDefer(
      d,
      {
        fingerprints: [DEP_A.fingerprint],
        reason: 'fix lands this afternoon',
        expires: '2026-07-22',
        addedBy: 'dev@example.com',
        mode: 'full',
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.advisories.some((a) => a.includes('closes TODAY'))).toBe(true);
  });
});

describe('both front-ends carry the advisories (one core, one set of facts)', () => {
  it('the core attaches them to a successful defer, and only when something was written', () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A, DEP_B]);
    const first = executeDefer(
      d,
      { fromLastCheck: true, reason: 'advisory batch', addedBy: 'dev@example.com', mode: 'full' },
      NOW,
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.added).toHaveLength(2);
      expect(first.advisories.some((a) => a.includes('share one expiry'))).toBe(true);
      expect(first.advisories.some((a) => a.includes('No automated remediation lane'))).toBe(true);
    }
    // A re-run writes nothing, so it chose no window and says nothing about one.
    // Explicit fingerprints, not --from-last-check: the verdict cache is
    // tree-scoped, and the allowlist write above already changed the tree.
    const second = executeDefer(
      d,
      {
        fingerprints: [DEP_A.fingerprint, DEP_B.fingerprint],
        reason: 'advisory batch',
        addedBy: 'dev@example.com',
        mode: 'full',
      },
      NOW,
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.added).toEqual([]);
      expect(second.advisories).toEqual([]);
    }
  });

  it('the PR reply carries them into the thread the reviewers read', () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A, DEP_B]);
    const payload = runCommentDeferCore(
      d,
      {
        DXKIT_COMMENT_BODY: '/dxkit defer --new-advisories --reason="advisory batch"',
        DXKIT_COMMENT_AUTHOR: 'reviewer',
        DXKIT_COMMENT_PR: '377',
      },
      NOW,
    );
    expect(payload.action).toBe('deferred');
    expect(payload.replyMarkdown).toContain('No automated remediation lane');
    expect(payload.replyMarkdown).toContain('share one expiry');
  });
});
