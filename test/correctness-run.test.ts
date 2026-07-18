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
      // Satisfiable everywhere (Rule 20) — these tests exercise the exec
      // policy, not the environment gate (that lives in test/execution/).
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
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

  it('an unavailable skip CARRIES its reason, and the disclosure surfaces it (T2.4)', async () => {
    // The rollout class: ./gradlew committed without the exec bit
    // spawned EACCES in 0.2s and read as "kotlin compile failed" with EMPTY
    // output — an environment problem reported as broken code, undiagnosable
    // from the gate log. The exec now reports it unavailable WITH the remedy;
    // the runner must carry that through and the skip disclosure must name it.
    const reason =
      './gradlew exists but is not executable — restore the executable bit (chmod +x ./gradlew; committed to git: git update-index --chmod=+x ./gradlew)';
    const exec: CommandExec = () => ({ available: false, code: -1, output: reason });
    const r = runCorrectnessFloor({
      ...base,
      packs: [pack('kotlin', cmd('compile', './gradlew'), cmd('affected-tests', './gradlew'))],
      exec,
    });
    expect(r.blocks).toBe(false); // infrastructure, never a block
    expect(r.checks.every((c) => c.status === 'skipped-unavailable')).toBe(true);
    expect(r.checks[0].output).toBe(reason);
    const { describeEnvironmentSkips } = await import('../src/analyzers/correctness/run');
    const lines = describeEnvironmentSkips(r);
    expect(lines.some((l) => l.includes('not executable'))).toBe(true);
  });

  it('makeCommandExec: a path-like bin WITHOUT the exec bit is unavailable, resolved vs the command cwd', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-noexec-'));
    try {
      writeFileSync(join(dir, 'wrapper'), '#!/bin/sh\necho hi\n'); // mode 644
      const exec = makeCommandExec();
      const out = exec({ bin: './wrapper', args: [] }, dir);
      expect(out.available).toBe(false);
      expect(out.output).toContain('not executable');
      expect(out.output).toContain('git update-index --chmod=+x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
