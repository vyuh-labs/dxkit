/**
 * Tests for the correctness-floor runner (src/analyzers/correctness/run.ts).
 * Command execution is injected, so these exercise the fail-open / fail-closed
 * policy without a real toolchain, driven by synthetic packs.
 */

import { describe, it, expect } from 'vitest';
import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
  describeScopeEscalation,
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

  describe('manifest-aware scope (the dep-override under-block class)', () => {
    /** A pack that mimics the real affected-scope heuristic: at `affected`
     *  with a diff that touched no source file it declines the test run, at
     *  `full` it always runs. Declares manifest patterns like a real pack. */
    function scopedPack(id: string, patterns: string[]): LanguageSupport {
      return {
        id,
        capabilities: { depVulns: { manifestPatterns: patterns } },
        correctness: {
          execution: () => ({
            hosts: ['any' as const],
            toolchains: [],
            needsBuild: false,
            buildTarget: 'none' as const,
            weight: 'cheap' as const,
          }),
          syntaxCheck: () => null,
          affectedTests: (ctx: CorrectnessContext) => {
            const source = ctx.changedFiles.filter((f) => f.endsWith('.ts'));
            if (ctx.scope === 'affected' && ctx.changedFiles.length > 0 && source.length === 0) {
              return null; // "docs-only, nothing to run" — the heuristic D1 defeats
            }
            return cmd('affected-tests', 'vitest');
          },
        },
      } as unknown as LanguageSupport;
    }
    const ok: CommandExec = () => ({ available: true, code: 0, output: '' });

    it('a manifest-only diff escalates affected → full: the suite RUNS and the escalation is disclosed', () => {
      // The shipped class: the diff was package.json + lockfile + docs — zero
      // source files — so the pack heuristic skipped everything while the
      // lockfile change broke module resolution repo-wide. The runner must
      // escalate BEFORE the pack sees the scope.
      const r = runCorrectnessFloor({
        cwd: '/repo',
        changedFiles: ['package.json', 'package-lock.json', 'docs/x.md'],
        scope: 'affected',
        packs: [scopedPack('ts', ['package.json', 'package-lock.json'])],
        exec: ok,
      });
      expect(r.checks.map((c) => c.label)).toEqual(['affected-tests']); // ran, not skipped
      expect(r.scopeEscalated).toEqual({
        reason: 'dependency-manifest-changed',
        files: ['package.json', 'package-lock.json'],
      });
      expect(describeScopeEscalation(r)).toContain('package-lock.json');
      expect(describeScopeEscalation(r)).toContain('full suite');
    });

    it('a source-only diff stays at affected scope (no escalation)', () => {
      const r = runCorrectnessFloor({
        cwd: '/repo',
        changedFiles: ['src/a.ts'],
        scope: 'affected',
        packs: [scopedPack('ts', ['package.json', 'package-lock.json'])],
        exec: ok,
      });
      expect(r.scopeEscalated).toBeUndefined();
      expect(describeScopeEscalation(r)).toBeNull();
    });

    it('an empty changed set (undeterminable diff) is not labeled an escalation', () => {
      // Packs already treat an empty set as full per the contract; claiming
      // "dependency manifest changed" over a diff we could not read would be
      // a false disclosure.
      const r = runCorrectnessFloor({
        cwd: '/repo',
        changedFiles: [],
        scope: 'affected',
        packs: [scopedPack('ts', ['package.json'])],
        exec: ok,
      });
      expect(r.scopeEscalated).toBeUndefined();
    });

    it('a full-scope run is never re-labeled as escalated', () => {
      const r = runCorrectnessFloor({
        cwd: '/repo',
        changedFiles: ['package.json'],
        scope: 'full',
        packs: [scopedPack('ts', ['package.json'])],
        exec: ok,
      });
      expect(r.scopeEscalated).toBeUndefined();
    });

    it('fail-safe: packs with no declared manifest patterns escalate (cannot prove dependency-free), files empty', () => {
      // Mirrors the predicate's documented fail-safe. No specific file can be
      // named, but the honest default is still the full suite.
      const r = runCorrectnessFloor({
        cwd: '/repo',
        changedFiles: ['whatever.txt'],
        scope: 'affected',
        packs: [scopedPack('ts', [])],
        exec: ok,
      });
      expect(r.scopeEscalated).toEqual({ reason: 'dependency-manifest-changed', files: [] });
    });
  });

  describe('resolutionCheck integration (the import-resolution floor)', () => {
    const ok: CommandExec = () => ({ available: true, code: 0, output: '' });
    function resPack(result: unknown): LanguageSupport {
      return {
        id: 'ts',
        correctness: {
          execution: () => ({
            hosts: ['any' as const],
            toolchains: [],
            needsBuild: false,
            buildTarget: 'none' as const,
            weight: 'cheap' as const,
          }),
          syntaxCheck: () => null,
          affectedTests: () => null,
          resolutionCheck: () => {
            if (result instanceof Error) throw result;
            return result;
          },
        },
      } as unknown as LanguageSupport;
    }

    it('clean → pass', () => {
      const r = runCorrectnessFloor({
        ...base,
        packs: [resPack({ kind: 'clean', checkedSpecifiers: 42 })],
        exec: ok,
      });
      expect(r.checks).toEqual([
        { pack: 'ts', label: 'import-resolution', bin: '', status: 'pass' },
      ]);
      expect(r.blocks).toBe(false);
    });

    it('unresolved → fail, with finding-level identities keyed by specifier', () => {
      const r = runCorrectnessFloor({
        ...base,
        packs: [
          resPack({
            kind: 'unresolved',
            unresolved: [
              { specifier: 'form-data', file: 'src/upload.js' },
              { specifier: 'form-data', file: 'src/other.js' }, // same root cause
              { specifier: 'left-pad', file: 'src/pad.js' },
            ],
          }),
        ],
        exec: ok,
      });
      expect(r.blocks).toBe(true);
      const check = r.checks[0];
      expect(check.status).toBe('fail');
      expect(check.findings).toEqual(['form-data', 'left-pad']); // deduped
      expect(check.output).toContain("'form-data' does not resolve");
      expect(check.output).toContain('src/upload.js');
    });

    it('skipped → disclosed fail-open skip, surfaced by the disclosure helper', async () => {
      const r = runCorrectnessFloor({
        ...base,
        packs: [resPack({ kind: 'skipped', reason: 'dependencies are not installed' })],
        exec: ok,
      });
      expect(r.blocks).toBe(false);
      expect(r.checks[0].status).toBe('skipped-unavailable');
      const { describeEnvironmentSkips } = await import('../src/analyzers/correctness/run');
      expect(
        describeEnvironmentSkips(r).some((l) => l.includes('dependencies are not installed')),
      ).toBe(true);
    });

    it('a throwing check is infrastructure: disclosed skip, never a verdict', () => {
      const r = runCorrectnessFloor({
        ...base,
        packs: [resPack(new Error('walker exploded'))],
        exec: ok,
      });
      expect(r.blocks).toBe(false);
      expect(r.checks[0].status).toBe('skipped-unavailable');
      expect(r.checks[0].output).toContain('walker exploded');
    });

    it('a pack without the optional capability contributes no resolution check', () => {
      const r = runCorrectnessFloor({
        ...base,
        packs: [pack('go', cmd('compile', 'go'), null)],
        exec: ok,
      });
      expect(r.checks.map((c) => c.label)).toEqual(['compile']);
    });
  });

  describe('parseFailures integration (4.2 failure-level attribution)', () => {
    const failing = (label: string, parse: (o: string) => string[] | null): LanguageSupport =>
      ({
        id: 'ts',
        correctness: {
          execution: () => ({
            hosts: ['any' as const],
            toolchains: [],
            needsBuild: false,
            buildTarget: 'none' as const,
            weight: 'cheap' as const,
          }),
          syntaxCheck: () => null,
          affectedTests: () => ({ label, bin: 'npx', args: [], parseFailures: parse }),
        },
      }) as unknown as LanguageSupport;

    it('parses the FULL output, not the display tail (a truncated snapshot false-blocks later)', () => {
      // A marker early in a long stream: the display tail loses it, the
      // findings must not.
      const early = 'FAIL early.test.js';
      const output = early + '\n' + Array.from({ length: 500 }, (_, i) => `noise ${i}`).join('\n');
      const exec: CommandExec = () => ({ available: true, code: 1, output });
      const r = runCorrectnessFloor({
        ...base,
        packs: [
          failing('affected-tests', (o) =>
            o.includes(early) ? ['suite: early.test.js'] : ['MISSED'],
          ),
        ],
        exec,
      });
      expect(r.checks[0].findings).toEqual(['suite: early.test.js']);
      expect(r.checks[0].output).not.toContain(early); // the tail truncated it
    });

    it('normalizes findings: deduped, sorted, order-independent identity', () => {
      const exec: CommandExec = () => ({ available: true, code: 1, output: 'x' });
      const r = runCorrectnessFloor({
        ...base,
        packs: [failing('affected-tests', () => ['b', 'a', 'b'])],
        exec,
      });
      expect(r.checks[0].findings).toEqual(['a', 'b']);
    });

    it('a null/empty/throwing parse means check-level: no findings attached, the failure stands', () => {
      const exec: CommandExec = () => ({ available: true, code: 1, output: 'x' });
      for (const parse of [
        () => null,
        () => [],
        () => {
          throw new Error('bad reporter');
        },
      ]) {
        const r = runCorrectnessFloor({
          ...base,
          packs: [failing('affected-tests', parse as () => string[] | null)],
          exec,
        });
        expect(r.checks[0].status).toBe('fail');
        expect(r.checks[0].findings).toBeUndefined();
      }
    });

    it('never parses a passing run', () => {
      let called = false;
      const exec: CommandExec = () => ({ available: true, code: 0, output: 'all good' });
      runCorrectnessFloor({
        ...base,
        packs: [
          failing('affected-tests', () => {
            called = true;
            return ['x'];
          }),
        ],
        exec,
      });
      expect(called).toBe(false);
    });
  });

  describe('describeFloorCapturePlan (the pre-capture estimate — 4.2 evaluate-first)', () => {
    it('names the full-scope commands capture would run, without executing anything', async () => {
      const { describeFloorCapturePlan } = await import('../src/analyzers/correctness/run');
      const p = pack('ts', cmd('typecheck', 'tsc'), cmd('affected-tests', 'vitest'));
      const plan = describeFloorCapturePlan('/repo', [p]);
      expect(plan).toEqual(['ts typecheck: tsc', 'ts affected-tests: vitest']);
    });

    it('is empty when no active pack provides a floor (capture would no-op)', async () => {
      const { describeFloorCapturePlan } = await import('../src/analyzers/correctness/run');
      const plain = { id: 'go' } as unknown as LanguageSupport;
      expect(describeFloorCapturePlan('/repo', [plain])).toEqual([]);
    });

    it('notes the read-only resolution check without pretending it costs anything', async () => {
      const { describeFloorCapturePlan } = await import('../src/analyzers/correctness/run');
      const p = {
        id: 'ts',
        correctness: {
          execution: () => ({
            hosts: ['any' as const],
            toolchains: [],
            needsBuild: false,
            buildTarget: 'none' as const,
            weight: 'cheap' as const,
          }),
          syntaxCheck: () => null,
          affectedTests: () => null,
          resolutionCheck: () => ({ kind: 'clean' as const, checkedSpecifiers: 0 }),
        },
      } as unknown as LanguageSupport;
      const plan = describeFloorCapturePlan('/repo', [p]);
      expect(plan).toEqual(['ts import-resolution: read-only, sub-second']);
    });
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
