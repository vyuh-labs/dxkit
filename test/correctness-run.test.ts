/**
 * Tests for the correctness-floor runner (src/analyzers/correctness/run.ts).
 * Command execution is injected, so these exercise the fail-open / fail-closed
 * policy without a real toolchain, driven by synthetic packs.
 */

import { describe, it, expect } from 'vitest';
import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
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
