/**
 * The expiry DECISION surface — the one maintained issue that reaches a
 * deferral's owner when no PR is open.
 *
 * The hole it closes is narrow and specific. Three surfaces already warn during
 * the window (console / PR comment / JSON), so this is only about the quiet
 * week: on the repo that produced this class, the deferral was created on the
 * 22nd, the repo went quiet, and the lapse landed on the 29th inside an
 * unrelated PR whose author had never seen the findings.
 *
 * Pinned here: create / update / **close** (the self-close is what keeps the
 * surface trustworthy — an issue that outlives its facts teaches a team to
 * filter dxkit's issues, which would disable every future notice), fail-open on
 * every GitHub failure, the opt-in gate, and the permission block that must
 * carry `issues: write` exactly when the lane is on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  EXPIRY_NOTICE_MARKER,
  expiryNoticeBody,
  syncExpiryNotice,
} from '../../src/baseline/expiry-notice';
import { refreshPermissionsBlock, expiryNoticeEnabled } from '../../src/ship-installers';
import { auditAllowlist, SOON_TO_EXPIRE_DAYS } from '../../src/allowlist/file';
import type { AllowlistEntry, AllowlistFile } from '../../src/allowlist/file';
import type { Exec } from '../../src/land-refresh';

const NOW = new Date('2026-07-22T09:00:00Z');

const tmps: string[] = [];
function mkRepo(
  opts: { policy?: Record<string, unknown>; allowlist?: AllowlistFile } = {},
): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-expiry-notice-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.dxkit'), { recursive: true });
  if (opts.policy) {
    fs.writeFileSync(path.join(d, '.dxkit', 'policy.json'), JSON.stringify(opts.policy, null, 2));
  }
  if (opts.allowlist) {
    fs.writeFileSync(
      path.join(d, '.dxkit', 'allowlist.json'),
      JSON.stringify(opts.allowlist, null, 2),
    );
  }
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function entry(fingerprint: string, expiresAt?: string, over: Partial<AllowlistEntry> = {}) {
  return {
    fingerprint,
    kind: 'dep-vuln',
    category: expiresAt ? 'deferred' : 'false-positive',
    reason: 'time-boxed pending dependency remediation',
    addedBy: 'jane@corp.example',
    addedAt: '2026-07-22',
    ...(expiresAt ? { expiresAt } : {}),
    ...over,
  } as AllowlistEntry;
}

function allowlistOf(entries: AllowlistEntry[]): AllowlistFile {
  return { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries };
}

/** A recording exec seam: canned stdout per `gh <sub> <verb>`, plus a log. */
function fakeExec(responses: Record<string, string>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((bin: string, args: readonly string[]) => {
    calls.push([bin, ...args]);
    const key = `${args[0]} ${args[1]}`;
    return responses[key] ?? '';
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const LAPSING = allowlistOf([
  entry('aaaa000000000001', '2026-07-28', { acknowledgedSeverity: 'high' }),
  entry('aaaa000000000002', '2026-07-28', { acknowledgedSeverity: 'high' }),
  entry('bbbb000000000001'), // never expires — must not appear
]);

describe('expiryNoticeBody', () => {
  const soon = auditAllowlist(LAPSING, { now: NOW }).soonToExpire;

  it('carries the marker, the countdown, and one row per lapsing entry', () => {
    const body = expiryNoticeBody(soon, { horizonDays: SOON_TO_EXPIRE_DAYS });
    expect(body.startsWith(EXPIRY_NOTICE_MARKER)).toBe(true);
    expect(body).toContain('**2 allowlist suppressions lapse within 14 days**');
    expect(body).toContain('in 6 days');
    expect(body).toContain('`aaaa000000000001`');
    expect(body).toContain('`aaaa000000000002`');
    // The non-expiring entry is not a decision waiting to happen.
    expect(body).not.toContain('bbbb000000000001');
  });

  it('states the batch-lapse property when one date covers them all', () => {
    const body = expiryNoticeBody(soon, { horizonDays: SOON_TO_EXPIRE_DAYS });
    expect(body).toContain('All 2 share one expiry, so they return together on 2026-07-28');
  });

  it('names owners and says explicitly that it will not assign', () => {
    const body = expiryNoticeBody(soon, { horizonDays: SOON_TO_EXPIRE_DAYS });
    expect(body).toContain('jane@corp.example');
    expect(body).toContain('not assigned');
    expect(body).toContain('will not guess a GitHub login');
  });

  it('offers both lanes and discloses the cadence limitation', () => {
    const body = expiryNoticeBody(soon, { horizonDays: SOON_TO_EXPIRE_DAYS });
    expect(body).toContain('Fix them');
    expect(body).toContain('Renew deliberately');
    expect(body).toContain('never blocks a build');
    expect(body).toContain('slower than 14 days, the first notice can arrive late');
  });

  it('reports the acknowledged severity, which is a recorded fact rather than a re-derivation', () => {
    const body = expiryNoticeBody(soon, { horizonDays: SOON_TO_EXPIRE_DAYS });
    expect(body).toContain('| high |');
    // It never claims a block/warn consequence — that needs a classification
    // pass the refresh does not run; the guardrail check makes that claim.
    expect(body).not.toContain('will BLOCK');
  });
});

describe('syncExpiryNotice', () => {
  it('opens one issue when suppressions are lapsing and none is open', () => {
    const d = mkRepo({ allowlist: LAPSING });
    const exec = fakeExec({
      'issue list': '[]',
      'issue create': 'https://github.com/acme/repo/issues/7\n',
    });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('issue-opened');
    expect(out.lapsing).toBe(2);
    expect(out.issueUrl).toBe('https://github.com/acme/repo/issues/7');
    expect(out.note).toContain('Opened the expiry notice');
    const create = exec.calls.find((c) => c[1] === 'issue' && c[2] === 'create')!;
    expect(create.join(' ')).toContain('dxkit: allowlist suppressions expiring (2)');
  });

  it('updates the SAME issue when one carries the marker (never a second one)', () => {
    const d = mkRepo({ allowlist: LAPSING });
    const exec = fakeExec({
      'issue list': JSON.stringify([
        { number: 3, url: 'https://github.com/acme/repo/issues/3', body: 'unrelated' },
        {
          number: 7,
          url: 'https://github.com/acme/repo/issues/7',
          body: `${EXPIRY_NOTICE_MARKER}\nstale text`,
        },
      ]),
      'issue edit': 'https://github.com/acme/repo/issues/7\n',
    });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('issue-updated');
    expect(out.issueUrl).toBe('https://github.com/acme/repo/issues/7');
    expect(exec.calls.some((c) => c[2] === 'create')).toBe(false);
    const edit = exec.calls.find((c) => c[2] === 'edit')!;
    expect(edit[3]).toBe('7');
  });

  it('CLOSES the open issue once nothing is lapsing — the self-close', () => {
    const d = mkRepo({ allowlist: allowlistOf([entry('cccc000000000001', '2026-12-31')]) });
    const exec = fakeExec({
      'issue list': JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/acme/repo/issues/7',
          body: `${EXPIRY_NOTICE_MARKER}\nold`,
        },
      ]),
    });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('issue-closed');
    expect(out.lapsing).toBe(0);
    const close = exec.calls.find((c) => c[2] === 'close')!;
    expect(close[3]).toBe('7');
    expect(close.join(' ')).toContain('reopens a fresh notice');
  });

  it('stays silent when nothing is lapsing and no issue is open', () => {
    const d = mkRepo({ allowlist: allowlistOf([entry('dddd000000000001')]) });
    const exec = fakeExec({ 'issue list': '[]' });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('nothing-to-report');
    expect(exec.calls.some((c) => c[2] === 'create' || c[2] === 'close')).toBe(false);
  });

  it('fails OPEN and says why when the issue cannot be created', () => {
    // gh missing / issues disabled / token without `issues: write` — every one
    // of those surfaces as empty stdout through the allowFail exec.
    const d = mkRepo({ allowlist: LAPSING });
    const exec = fakeExec({ 'issue list': '[]', 'issue create': '' });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('unavailable');
    expect(out.lapsing).toBe(2);
    expect(out.note).toContain('issues: write');
    expect(out.note).toContain('still surfaces on every guardrail check');
  });

  it('fails OPEN when an existing issue cannot be edited, and keeps naming it', () => {
    const d = mkRepo({ allowlist: LAPSING });
    const exec = fakeExec({
      'issue list': JSON.stringify([
        { number: 7, url: 'https://github.com/acme/repo/issues/7', body: EXPIRY_NOTICE_MARKER },
      ]),
      'issue edit': '',
    });
    const out = syncExpiryNotice({ cwd: d, exec, now: NOW });
    expect(out.outcome).toBe('unavailable');
    expect(out.issueUrl).toBe('https://github.com/acme/repo/issues/7');
  });

  it('treats an unparseable issue list as "none open" rather than throwing', () => {
    const d = mkRepo({ allowlist: LAPSING });
    const exec = fakeExec({ 'issue list': 'not json', 'issue create': 'https://x/issues/1\n' });
    expect(syncExpiryNotice({ cwd: d, exec, now: NOW }).outcome).toBe('issue-opened');
  });

  it('reports nothing to do on a repo with no allowlist at all', () => {
    const d = mkRepo();
    const exec = fakeExec({ 'issue list': '[]' });
    expect(syncExpiryNotice({ cwd: d, exec, now: NOW }).outcome).toBe('nothing-to-report');
  });
});

describe('the refresh lane runs the notice independently of the advisory lane', () => {
  /** Policy that makes the advisory lane take its earliest no-op return. */
  const REF_BASED = { baseline: { mode: 'ref-based' } };

  it('syncs the notice even when the advisory lane no-ops entirely', async () => {
    const { runBaselineRefresh } = await import('../../src/baseline/refresh');
    const d = mkRepo({
      policy: { ...REF_BASED, expiryNotice: { enabled: true } },
      allowlist: LAPSING,
    });
    const exec = fakeExec({
      'issue list': '[]',
      'issue create': 'https://github.com/acme/repo/issues/9\n',
    });
    const result = await runBaselineRefresh({ cwd: d, exec, now: NOW });
    // The advisory lane did nothing (ref-based has no committed baseline) …
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('ref-based');
    // … and the notice still fired. A suppression's expiry has nothing to do
    // with whether an advisory feed moved this week.
    expect(result.expiryNotice?.outcome).toBe('issue-opened');
    expect(result.expiryNotice?.lapsing).toBe(2);
  });

  it('does not touch GitHub at all when the knob is off (the default)', async () => {
    const { runBaselineRefresh } = await import('../../src/baseline/refresh');
    const d = mkRepo({ policy: REF_BASED, allowlist: LAPSING });
    const exec = fakeExec({ 'issue list': '[]' });
    const result = await runBaselineRefresh({ cwd: d, exec, now: NOW });
    expect(result.expiryNotice).toBeUndefined();
    expect(exec.calls).toEqual([]);
  });
});

describe('the opt-in gate and the workflow permission it implies', () => {
  it('is off unless policy says otherwise', () => {
    expect(expiryNoticeEnabled(mkRepo())).toBe(false);
    expect(expiryNoticeEnabled(mkRepo({ policy: {} }))).toBe(false);
    expect(expiryNoticeEnabled(mkRepo({ policy: { expiryNotice: { enabled: false } } }))).toBe(
      false,
    );
    expect(expiryNoticeEnabled(mkRepo({ policy: { expiryNotice: { enabled: true } } }))).toBe(true);
  });

  it('grants issues: write ONLY when enabled, keeping every other repo byte-identical', () => {
    const off = mkRepo();
    expect(refreshPermissionsBlock(off, 'tree')).toBe('  contents: write');
    expect(refreshPermissionsBlock(off, 'branch')).toBe('  contents: write');
    // The cache transport writes no git object, so it never needed write.
    expect(refreshPermissionsBlock(off, 'cache')).toBe('  contents: read');

    const on = mkRepo({ policy: { expiryNotice: { enabled: true } } });
    expect(refreshPermissionsBlock(on, 'tree')).toBe('  contents: write\n  issues: write');
    expect(refreshPermissionsBlock(on, 'cache')).toBe('  contents: read\n  issues: write');
  });
});
