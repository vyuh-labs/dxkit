/**
 * Tests for the correctness-floor runner (src/analyzers/correctness/run.ts).
 * Command execution is injected, so these exercise the fail-open / fail-closed
 * policy without a real toolchain, driven by synthetic packs.
 */

import { describe, it, expect } from 'vitest';
import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
  makeCommandExec,
  type CommandExec,
} from '../src/analyzers/correctness/run';
import type { LanguageSupport } from '../src/languages/types';
import type {
  CorrectnessCommand,
  CorrectnessContext,
} from '../src/languages/capabilities/correctness';

/** A synthetic pack whose provider returns fixed commands (or null). */
function pack(
  id: string,
  syntax: CorrectnessCommand | null,
  affected: CorrectnessCommand | null,
): LanguageSupport {
  return {
    id,
    correctness: {
      syntaxCheck: (_ctx: CorrectnessContext) => syntax,
      affectedTests: (_ctx: CorrectnessContext) => affected,
    },
  } as unknown as LanguageSupport;
}

const cmd = (label: string, bin: string): CorrectnessCommand => ({ label, bin, args: [] });

const base = { cwd: '/repo', changedFiles: ['a.ts'], scope: 'affected' as const };

describe('runCorrectnessFloor', () => {
  it('passes when every command exits 0', () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), cmd('affected-tests', 'vitest'))],
      exec,
    });
    expect(r.ran).toBe(true);
    expect(r.blocks).toBe(false);
    expect(r.checks.map((c) => c.status)).toEqual(['pass', 'pass']);
  });

  it('fail-CLOSED: a non-zero exit blocks and captures output', () => {
    const exec: CommandExec = (c) =>
      c.bin === 'tsc'
        ? { available: true, code: 2, output: 'error TS1005' }
        : { available: true, code: 0, output: '' };
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), cmd('affected-tests', 'vitest'))],
      exec,
    });
    expect(r.blocks).toBe(true);
    const failed = r.checks.find((c) => c.status === 'fail');
    expect(failed?.label).toBe('typecheck');
    expect(failed?.output).toContain('TS1005');
  });

  it('fail-OPEN: a missing binary is skipped, not failed', () => {
    const exec: CommandExec = () => ({ available: false, code: -1, output: '' });
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), null)],
      exec,
    });
    expect(r.ran).toBe(false); // nothing actually executed
    expect(r.blocks).toBe(false);
    expect(r.checks[0].status).toBe('skipped-unavailable');
  });

  it('fail-OPEN: a timed-out command is skipped, not failed (a slow suite is not a broken one)', () => {
    const exec: CommandExec = (c) =>
      c.bin === 'vitest'
        ? { available: true, timedOut: true, code: -1, output: 'killed' }
        : { available: true, code: 0, output: '' };
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), cmd('affected-tests', 'vitest'))],
      exec,
    });
    expect(r.blocks).toBe(false); // timeout does NOT block
    const at = r.checks.find((c) => c.label === 'affected-tests');
    expect(at?.status).toBe('skipped-timeout');
    // The typecheck still ran and passed, so the floor did run something.
    expect(r.ran).toBe(true);
  });

  it('skips a check a pack declines (null command)', () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), null)],
      exec,
    });
    expect(r.checks).toHaveLength(1); // only syntaxCheck ran
    expect(r.checks[0].label).toBe('typecheck');
  });

  it('ignores packs without a correctness provider', () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
    const plain = { id: 'go' } as unknown as LanguageSupport;
    const r = runCorrectnessFloor({
      ...base,
      packs: [plain, pack('ts', cmd('typecheck', 'tsc'), null)],
      exec,
    });
    expect(r.checks.map((c) => c.pack)).toEqual(['ts']);
  });

  it('makeCommandExec: a real command exceeding the budget reports timedOut (fail-open)', () => {
    // `sleep 5` under a 200ms budget must be killed and reported as a timeout,
    // NOT as a non-zero-exit failure.
    const exec = makeCommandExec(200);
    const out = exec({ bin: 'sleep', args: ['5'] }, process.cwd());
    expect(out.available).toBe(true);
    expect(out.timedOut).toBe(true);
  });

  it('makeCommandExec: a fast command completes normally under the budget', () => {
    const exec = makeCommandExec(10_000);
    const out = exec({ bin: 'node', args: ['-e', 'process.exit(0)'] }, process.cwd());
    expect(out.timedOut).toBeFalsy();
    expect(out.code).toBe(0);
  });

  it('describes a floor result', () => {
    const exec: CommandExec = (c) =>
      c.bin === 'tsc'
        ? { available: true, code: 1, output: 'x' }
        : { available: true, code: 0, output: '' };
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), cmd('affected-tests', 'vitest'))],
      exec,
    });
    expect(describeCorrectnessFloor(r)).toContain('ts typecheck');
    const clean = runCorrectnessFloor({
      ...base,
      packs: [pack('ts', cmd('typecheck', 'tsc'), null)],
      exec: () => ({ available: true, code: 0, output: '' }),
    });
    expect(describeCorrectnessFloor(clean)).toContain('all checks passed');
  });
});
