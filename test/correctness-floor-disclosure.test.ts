/**
 * Floor disclosure — a failing build must be impossible to miss in a PR,
 * even (especially) when it is pre-existing and therefore NOT blocking.
 * Pins the tier vocabulary across both outputs (PR-comment markdown and
 * GitHub check annotations), the approver call-out for a broken base
 * branch, the reproduction commands, and silence on a green floor.
 */
import { describe, it, expect } from 'vitest';
import {
  floorDisclosureMarkdown,
  githubAnnotations,
} from '../src/analyzers/correctness/floor-disclosure';
import type { SurfaceFloorOutcome } from '../src/analyzers/correctness/surface-run';
import type { CorrectnessCheckResult } from '../src/analyzers/correctness/run';

function check(
  pack: string,
  label: string,
  status: CorrectnessCheckResult['status'],
  output?: string,
): CorrectnessCheckResult {
  return {
    pack: pack as CorrectnessCheckResult['pack'],
    label,
    bin: 'runner',
    args: ['--flag'],
    status,
    ...(output ? { output } : {}),
  };
}

function outcome(partial: Partial<SurfaceFloorOutcome>): SurfaceFloorOutcome {
  return {
    surface: 'ci',
    enabled: true,
    reason: 'test',
    ran: true,
    blocks: false,
    summary: '',
    ...partial,
  } as SurfaceFloorOutcome;
}

describe('floorDisclosureMarkdown', () => {
  it('is silent on a green floor', () => {
    const o = outcome({
      result: { ran: true, blocks: false, checks: [check('ts', 'typecheck', 'pass')] },
    });
    expect(floorDisclosureMarkdown(o)).toBeNull();
    expect(githubAnnotations(o)).toEqual([]);
  });

  it('pre-existing failures get the LOUD approver call-out, with repro + output', () => {
    const failing = check('ts', 'affected-tests', 'fail', '3 tests failed');
    const o = outcome({
      result: { ran: true, blocks: true, checks: [failing] },
      blocks: false, // attributed away — not blocking
      attributed: [{ check: failing, attribution: 'pre-existing' }],
    });
    const md = floorDisclosureMarkdown(o)!;
    expect(md).toContain('BASE BRANCH BUILD/TESTS ARE BROKEN');
    expect(md).toContain('Approvers, read this before approving');
    expect(md).toContain('merging onto a broken build');
    expect(md).toContain('vyuh-dxkit debt');
    expect(md).toContain('`runner --flag`');
    expect(md).toContain('3 tests failed');
    const ann = githubAnnotations(o);
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatch(/^::warning /);
    expect(ann[0]).toContain('BASE BRANCH is broken');
  });

  it('net-new failures get the error tier in both outputs', () => {
    const failing = check('ts', 'typecheck', 'fail', 'error TS2304');
    const o = outcome({
      result: { ran: true, blocks: true, checks: [failing] },
      blocks: true,
      attributed: [{ check: failing, attribution: 'net-new' }],
    });
    const md = floorDisclosureMarkdown(o)!;
    expect(md).toContain('this PR breaks the build/tests');
    expect(md).toContain('BLOCKING');
    const ann = githubAnnotations(o);
    expect(ann[0]).toMatch(/^::error /);
    expect(ann[0]).toContain('NET-NEW');
  });

  it('unattributed failures are disclosed as warnings, never blamed', () => {
    const failing = check('kotlin', 'compile', 'fail');
    const o = outcome({
      result: { ran: true, blocks: true, checks: [failing] },
      blocks: false,
      attributed: [{ check: failing, attribution: 'unattributed' }],
    });
    expect(floorDisclosureMarkdown(o)).toContain('could not attribute');
    expect(githubAnnotations(o)[0]).toMatch(/^::warning /);
  });

  it('a point-in-time failure (no attribution ran) still gets an error annotation', () => {
    const failing = check('go', 'compile', 'fail', 'syntax error');
    const o = outcome({
      result: { ran: true, blocks: true, checks: [failing] },
      blocks: true,
      // no `attributed` — push to the default branch / no base resolvable
    });
    expect(floorDisclosureMarkdown(o)).toContain('no merge-base to attribute against');
    expect(githubAnnotations(o)[0]).toMatch(/^::error /);
  });

  it('all three tiers coexist in one report, blocking tiers first', () => {
    const a = check('ts', 'typecheck', 'fail');
    const b = check('ts', 'affected-tests', 'fail');
    const c = check('kotlin', 'compile', 'fail');
    const o = outcome({
      result: { ran: true, blocks: true, checks: [a, b, c] },
      blocks: true,
      attributed: [
        { check: a, attribution: 'net-new' },
        { check: b, attribution: 'pre-existing' },
        { check: c, attribution: 'unattributed' },
      ],
    });
    const md = floorDisclosureMarkdown(o)!;
    const netNewAt = md.indexOf('this PR breaks');
    const preAt = md.indexOf('BASE BRANCH');
    const unAt = md.indexOf('could not attribute');
    expect(netNewAt).toBeGreaterThanOrEqual(0);
    expect(preAt).toBeGreaterThan(netNewAt);
    expect(unAt).toBeGreaterThan(preAt);
    expect(githubAnnotations(o)).toHaveLength(3);
  });
});
