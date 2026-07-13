import { describe, it, expect } from 'vitest';
import {
  buildFindingBreakdown,
  formatBreakdown,
  buildInitClosing,
  type InitClosingState,
} from '../src/init-arc';
import type { BaselineEntry } from '../src/baseline/types';

/** Minimal baseline entries — only `kind` matters to the breakdown. */
const entry = (kind: string): BaselineEntry => ({ kind }) as unknown as BaselineEntry;

const base: InitClosingState = {
  gated: true,
  baselineFindings: 0,
  baselineMode: 'committed-full',
  surfaces: ['pre-push hook', 'CI guardrail'],
  incompleteScanners: [],
  elapsedMs: 48_000,
};

/** Assert no line poses a question to the user — the zero-question DoD. */
function assertNoQuestions(lines: string[]): void {
  for (const l of lines) expect(l).not.toContain('?');
}

describe('buildFindingBreakdown', () => {
  it('groups by coarse human class and totals', () => {
    const b = buildFindingBreakdown([
      entry('secret'),
      entry('secret'),
      entry('dep-vuln'),
      entry('code'),
      entry('config'),
      entry('coverage-gap'),
    ]);
    expect(b).toEqual({ secrets: 2, deps: 1, code: 2, other: 1, total: 6 });
  });

  it('is empty for no findings', () => {
    expect(buildFindingBreakdown([])).toEqual({
      secrets: 0,
      deps: 0,
      code: 0,
      other: 0,
      total: 0,
    });
  });
});

describe('formatBreakdown', () => {
  it('omits zero classes and pluralizes', () => {
    expect(formatBreakdown({ secrets: 1, deps: 0, code: 3, other: 0, total: 4 })).toBe(
      '1 secret · 3 code patterns',
    );
  });
  it('is empty when nothing to show', () => {
    expect(formatBreakdown({ secrets: 0, deps: 0, code: 0, other: 0, total: 0 })).toBe('');
  });
});

describe('buildInitClosing', () => {
  it('gated + committed findings: grandfathers, teaches the ADD rule, zero homework', () => {
    const c = buildInitClosing({ ...base, baselineFindings: 47 });
    expect(c.headline).toBe("You're gated.");
    expect(c.ready).toBe('ready in 48s');
    const body = c.body.join(' ');
    expect(body).toContain('47 findings');
    expect(body).toContain('grandfathered');
    expect(body.toLowerCase()).toContain('adds');
    // No homework: the tail already ran, so it must NOT tell the user to run
    // tools install / baseline create.
    expect(body).not.toContain('baseline create');
    expect(body).not.toContain('tools install');
    // Standing actions are always Verify + Undo.
    expect(c.actions.map((a) => a.label)).toEqual(['Verify', 'Undo']);
    expect(c.actions[0].command).toContain('doctor');
    expect(c.actions[1].command).toContain('uninstall');
    assertNoQuestions([...c.body, c.headline, c.caution ?? '']);
  });

  it('singular grandfathered finding reads naturally', () => {
    const c = buildInitClosing({ ...base, baselineFindings: 1 });
    const body = c.body.join(' ');
    expect(body).toContain('1 finding ');
    expect(body).toContain("it won't");
  });

  it('clean repo (zero findings) sets the floor without a scary count', () => {
    const c = buildInitClosing({ ...base, baselineFindings: 0 });
    const body = c.body.join(' ');
    expect(body.toLowerCase()).toContain('clean');
    expect(body).not.toContain('0 findings');
  });

  it('ref-based mode: default branch is the baseline, nothing written, no count', () => {
    const c = buildInitClosing({
      ...base,
      baselineMode: 'ref-based',
      baselineFindings: null,
    });
    const body = c.body.join(' ');
    expect(body.toLowerCase()).toContain('default branch');
    expect(body.toLowerCase()).toContain('nothing was written');
  });

  it('fail-soft (armed, no baseline count): teaches the one baseline command', () => {
    const c = buildInitClosing({ ...base, baselineFindings: null, baselineMode: null });
    const body = c.body.join('\n');
    expect(body).toContain('baseline create');
  });

  it('not gated: sells context and offers the ONE command that turns on the gate', () => {
    const c = buildInitClosing({
      ...base,
      gated: false,
      baselineFindings: null,
      baselineMode: null,
      surfaces: [],
    });
    expect(c.headline).toBe('dxkit is set up.');
    expect(c.body.join(' ')).toContain('full project context');
    expect(c.actions.map((a) => a.label)).toEqual(['Gate it', 'Undo']);
    expect(c.actions[0].command).toContain('init');
  });

  it('incomplete scanner coverage becomes a single teaching caution (the only command)', () => {
    const c = buildInitClosing({
      ...base,
      baselineFindings: 12,
      incompleteScanners: ['osv-scanner', 'semgrep'],
    });
    expect(c.caution).not.toBeNull();
    expect(c.caution).toContain('osv-scanner');
    expect(c.caution).toContain('tools install');
    // No coverage gap → no caution.
    expect(buildInitClosing({ ...base, baselineFindings: 12 }).caution).toBeNull();
  });

  it('time-to-verdict is humanized across ranges', () => {
    expect(buildInitClosing({ ...base, elapsedMs: 300 }).ready).toBe('ready in under a second');
    expect(buildInitClosing({ ...base, elapsedMs: 12_000 }).ready).toBe('ready in 12s');
    expect(buildInitClosing({ ...base, elapsedMs: 135_000 }).ready).toMatch(/ready in 2m \d+s/);
  });
});
