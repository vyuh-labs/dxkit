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

/**
 * Switched lanes honour their off switch at run time. `update` installs a
 * lane's workflow when its policy switch is turned on and never deletes it
 * when the switch is turned off, so before this the schedule (or push, or
 * comment) kept firing and the lane kept running. Every switched lane now
 * asks `jobs enabled <workflow>` first; the answer comes from the same
 * switch list install uses (LANE_SWITCHES).
 */
import * as yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { laneEnabled } from '../src/jobs-cli';
import { LANE_SWITCHES, laneSwitchFor } from '../src/managed-artifacts-detect';
import { MANAGED_SHIP_SURFACES } from '../src/managed-artifacts';
import type { ManifestInstallFlags } from '../src/types';
import {
  installCiExtensionsRefresh,
  installCiFlowRefresh,
  installCiGraphRefresh,
  installCiReportsRefresh,
} from '../src/ship-installers';

describe('lane off switches, read at run time', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-lanes-'));
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const policy = (p: unknown) =>
    writeFileSync(join(repo, '.dxkit', 'policy.json'), JSON.stringify(p));

  it('jobs enabled follows each policy switch; a workflow no switch governs is always on', () => {
    const cases: ReadonlyArray<[string, unknown, unknown]> = [
      ['dxkit-dep-bump.yml', { depBump: { enabled: true } }, { depBump: { enabled: false } }],
      [
        'dxkit-reports-refresh.yml',
        { reports: { onMerge: true } },
        { reports: { onMerge: false } },
      ],
      ['dxkit-flow-refresh.yml', { flow: { onMergeRefresh: true } }, { flow: {} }],
      ['dxkit-graph-refresh.yml', { graph: { refresh: 'cache' } }, { graph: { refresh: 'off' } }],
      ['dxkit-remediate.yml', { remediate: { enabled: true } }, { remediate: { enabled: false } }],
      [
        'dxkit-comment-defer.yml',
        { newAdvisories: { commentCommands: true } },
        { newAdvisories: { commentCommands: false } },
      ],
    ];
    for (const [wf, on, off] of cases) {
      policy(on);
      expect({ wf, on: laneEnabled(repo, wf) }).toEqual({ wf, on: true });
      policy(off);
      expect({ wf, on: laneEnabled(repo, wf) }).toEqual({ wf, on: false });
    }
    policy({});
    expect(laneEnabled(repo, 'dxkit-guardrails.yml')).toBe(true);
    expect(laneSwitchFor('dxkit-guardrails.yml')).toBeUndefined();
  });

  it('jobs rows say when an installed lane is switched off', () => {
    policy({ depBump: { enabled: false } });
    installCiDepBump(repo);
    const bump = collectJobs(repo, { lastRunProbe: () => undefined }).find(
      (r) => r.workflow === 'dxkit-dep-bump.yml',
    )!;
    expect(bump.enabled).toBe(false);
    expect(bump.switchName).toBe('depBump.enabled');
  });

  it('every switched lane workflow checks its switch first and gates every later step on it', () => {
    policy({});
    installCiDepBump(repo);
    installCiGraphRefresh(repo);
    installCiReportsRefresh(repo);
    installCiFlowRefresh(repo);
    installCiExtensionsRefresh(repo);
    for (const wf of [
      'dxkit-dep-bump.yml',
      'dxkit-graph-refresh.yml',
      'dxkit-reports-refresh.yml',
      'dxkit-flow-refresh.yml',
      'dxkit-extensions-refresh.yml',
    ]) {
      const doc = yaml.load(readFileSync(join(repo, '.github', 'workflows', wf), 'utf8')) as {
        jobs: Record<string, { steps: Array<{ id?: string; if?: string; run?: string }> }>;
      };
      const steps = Object.values(doc.jobs)[0].steps;
      const at = steps.findIndex((s) => s.id === 'lane');
      expect({ wf, at: at >= 0 }).toEqual({ wf, at: true });
      expect(steps[at].run).toContain(`jobs enabled ${wf}`);
      const later = steps.slice(at + 1);
      expect(later.length).toBeGreaterThan(0);
      for (const s of later) {
        expect({ wf, if: s.if ?? '' }).toEqual({
          wf,
          if: expect.stringContaining("steps.lane.outputs.on == 'true'"),
        });
      }
    }
  });

  it('every lane in the switch list is enforced somewhere (a new lane cannot skip it)', () => {
    // The workflows above check the switch themselves; remediate and comment
    // commands check it inside the command the workflow calls (the scheduled
    // matrix is empty; the comment is refused), so already-installed copies
    // of those two need no regeneration.
    const inWorkflow = new Set([
      'withDepBump',
      'withGraphRefresh',
      'withReportsRefresh',
      'withFlowRefresh',
      'withExtensionsRefresh',
    ]);
    const inCommand = new Set(['withRemediate', 'withCommentDefer']);
    for (const lane of LANE_SWITCHES) {
      expect({
        flag: lane.flag,
        enforced: inWorkflow.has(lane.flag) || inCommand.has(lane.flag),
      }).toEqual({ flag: lane.flag, enforced: true });
      const surface = MANAGED_SHIP_SURFACES.find(
        (s) => s.gate.kind === 'flag' && s.gate.flag === lane.flag,
      );
      const wf = surface?.artifacts({} as ManifestInstallFlags)[0] ?? '';
      expect(laneSwitchFor(wf)?.flag).toBe(lane.flag);
    }
  });
});
