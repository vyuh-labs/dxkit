/**
 * `vyuh-dxkit jobs` — the "which jobs run here, when, did they work" view
 * (4.3.4). Rows come from the dxkit-owned workflow namespace on disk, so a
 * future lane appears the day its workflow is installed. Pins: the cron
 * next-fire math over the strict 5-field grammar (including the OR semantics
 * when both day fields are restricted), trigger parsing from real rendered
 * templates, the gh-absent degradation, and the injectable last-run probe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { collectJobs, nextCronFireUtc, parseWorkflow } from '../src/jobs-cli';
import { installCiBaselineRefresh, installCiDepBump } from '../src/ship-installers';

describe('nextCronFireUtc', () => {
  const now = new Date('2026-07-30T12:00:00Z'); // a Thursday

  it('daily at 06:00 — tomorrow morning', () => {
    expect(nextCronFireUtc('0 6 * * *', now)?.toISOString()).toBe('2026-07-31T06:00:00.000Z');
  });

  it('weekly Monday 07:00 — the coming Monday', () => {
    expect(nextCronFireUtc('0 7 * * 1', now)?.toISOString()).toBe('2026-08-03T07:00:00.000Z');
  });

  it('same-day fire when the time is still ahead', () => {
    expect(nextCronFireUtc('30 23 * * *', now)?.toISOString()).toBe('2026-07-30T23:30:00.000Z');
  });

  it('never fires AT now — strictly after', () => {
    expect(nextCronFireUtc('0 12 * * *', now)?.toISOString()).toBe('2026-07-31T12:00:00.000Z');
  });

  it('lists, ranges, steps', () => {
    expect(nextCronFireUtc('0 6,18 * * *', now)?.toISOString()).toBe('2026-07-30T18:00:00.000Z');
    expect(nextCronFireUtc('*/15 13 * * *', now)?.toISOString()).toBe('2026-07-30T13:00:00.000Z');
    expect(nextCronFireUtc('0 9 * * 1-5', now)?.toISOString()).toBe('2026-07-31T09:00:00.000Z');
  });

  it('dom+dow both restricted → OR (standard cron)', () => {
    // Next 15th is 2026-08-15; next Monday is 2026-08-03 — OR picks the Monday.
    expect(nextCronFireUtc('0 6 15 * 1', now)?.toISOString()).toBe('2026-08-03T06:00:00.000Z');
  });

  it('dow 7 means Sunday', () => {
    expect(nextCronFireUtc('0 6 * * 7', now)?.toISOString()).toBe('2026-08-02T06:00:00.000Z');
  });

  it('unparseable → null, never a guess', () => {
    expect(nextCronFireUtc('whenever', now)).toBeNull();
    expect(nextCronFireUtc('0 6 * *', now)).toBeNull();
    expect(nextCronFireUtc('61 6 * * *', now)).toBeNull();
  });
});

describe('collectJobs (real rendered templates)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-jobs-'));
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('rows from installed workflows: name, triggers, cron, next run, dispatchability', () => {
    writeFileSync(join(repo, '.dxkit', 'policy.json'), '{"baseline":{"anchor":"branch"}}');
    installCiBaselineRefresh(repo, { policyAnchor: 'branch' });
    installCiDepBump(repo);
    const rows = collectJobs(repo, {
      now: new Date('2026-07-30T12:00:00Z'),
      lastRunProbe: () => undefined, // gh-absent shape
    });
    const files = rows.map((r) => r.workflow);
    expect(files).toContain('dxkit-baseline-refresh.yml');
    expect(files).toContain('dxkit-dep-bump.yml');

    const bump = rows.find((r) => r.workflow === 'dxkit-dep-bump.yml')!;
    expect(bump.crons).toEqual(['0 7 * * 1']);
    expect(bump.nextRunUtc).toBe('2026-08-03 07:00');
    expect(bump.dispatchable).toBe(true);
    expect(bump.lastRun).toBeUndefined();

    const refresh = rows.find((r) => r.workflow === 'dxkit-baseline-refresh.yml')!;
    expect(refresh.triggers.join(',')).toContain('push');
    expect(refresh.triggers.join(',')).toContain('cron');
  });

  it('an injected probe carries the last outcome through', () => {
    installCiDepBump(repo);
    const rows = collectJobs(repo, {
      lastRunProbe: () => ({ conclusion: 'success', updatedAt: '2026-07-28T07:03:00Z' }),
    });
    expect(rows[0]?.lastRun?.conclusion).toBe('success');
  });

  it('no workflows dir → empty, never a throw', () => {
    expect(collectJobs(repo, { lastRunProbe: () => undefined })).toEqual([]);
  });
});

describe('parseWorkflow', () => {
  it('reads event triggers without schedules', () => {
    const parsed = parseWorkflow('name: x\non:\n  pull_request:\n  issue_comment:\n');
    expect(parsed.triggers).toEqual(['pull_request', 'issue_comment']);
    expect(parsed.crons).toEqual([]);
    expect(parsed.dispatchable).toBe(false);
  });
});
