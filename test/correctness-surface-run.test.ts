import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runFloorForSurface } from '../src/analyzers/correctness/surface-run';
import type { CommandExec } from '../src/analyzers/correctness/run';
import type { LanguageSupport } from '../src/languages/types';
import type { CorrectnessCommand } from '../src/languages/capabilities/correctness';

// A minimal fake pack that always emits a compile + test command, so the runner
// executes the injected exec. Only the `correctness` shape matters here.
function fakePack(): LanguageSupport {
  const cmd = (label: string): CorrectnessCommand => ({ label, bin: 'faketool', args: [label] });
  return {
    id: 'typescript', // any real LanguageId; only `correctness` is exercised
    correctness: {
      // Satisfiable everywhere (Rule 20) — these tests exercise surface
      // resolution + exec policy, not the environment gate.
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
      syntaxCheck: () => cmd('compile'),
      affectedTests: () => cmd('affected-tests'),
    },
  } as unknown as LanguageSupport;
}

const pass: CommandExec = () => ({ available: true, code: 0, output: '' });
const fail: CommandExec = () => ({ available: true, code: 1, output: 'boom' });
const missing: CommandExec = () => ({ available: false, code: -1, output: '' });

const alwaysOn = () => ({ enabled: true, reason: 'test-enabled' });
const alwaysOff = () => ({ enabled: false, reason: 'test-disabled' });

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-surfrun-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runFloorForSurface — enablement', () => {
  it('disabled surface → no-op (enabled:false, ran:false, blocks:false)', () => {
    const r = runFloorForSurface({
      surface: 'ci',
      cwd: tmp,
      packs: [fakePack()],
      exec: fail,
      resolveEnabled: alwaysOff,
    });
    expect(r.enabled).toBe(false);
    expect(r.ran).toBe(false);
    expect(r.blocks).toBe(false);
    expect(r.summary).toContain('disabled');
  });

  it('enabled but no pack provides a floor → ran:false, blocks:false', () => {
    const r = runFloorForSurface({
      surface: 'ci',
      cwd: tmp,
      packs: [],
      exec: fail,
      resolveEnabled: alwaysOn,
    });
    expect(r.enabled).toBe(true);
    expect(r.ran).toBe(false);
    expect(r.blocks).toBe(false);
    expect(r.summary).toContain('no active language pack');
  });
});

describe('runFloorForSurface — run outcomes', () => {
  it('all commands pass → ran:true, blocks:false', () => {
    const r = runFloorForSurface({
      surface: 'ci',
      cwd: tmp,
      packs: [fakePack()],
      exec: pass,
      resolveEnabled: alwaysOn,
    });
    expect(r.ran).toBe(true);
    expect(r.blocks).toBe(false);
  });

  it('a command fails → blocks:true', () => {
    const r = runFloorForSurface({
      surface: 'ci',
      cwd: tmp,
      packs: [fakePack()],
      exec: fail,
      resolveEnabled: alwaysOn,
    });
    expect(r.ran).toBe(true);
    expect(r.blocks).toBe(true);
  });

  it('toolchain missing → all skipped → ran:false, blocks:false (fail-open)', () => {
    const r = runFloorForSurface({
      surface: 'pre-push',
      cwd: tmp,
      packs: [fakePack()],
      exec: missing,
      resolveEnabled: alwaysOn,
    });
    expect(r.ran).toBe(false);
    expect(r.blocks).toBe(false);
    expect(r.summary).toContain('skipped');
  });
});

describe('runFloorForSurface — scope selection', () => {
  it('ci surface runs the packs at FULL scope (empty changedFiles)', () => {
    const seen: Array<{ scope: string; args: readonly string[] }> = [];
    const spy: CommandExec = (cmd) => {
      seen.push({ scope: 'x', args: cmd.args });
      return { available: true, code: 0, output: '' };
    };
    // A pack whose affectedTests encodes the scope it was called with, so we can
    // assert ci → full.
    const scopePack = {
      id: 'typescript',
      correctness: {
        execution: () => ({
          hosts: ['any' as const],
          toolchains: [],
          needsBuild: false,
          buildTarget: 'none' as const,
          weight: 'cheap' as const,
        }),
        syntaxCheck: () => null,
        affectedTests: (ctx: { scope: string }) => ({
          label: 'affected-tests',
          bin: 'faketool',
          args: [ctx.scope],
        }),
      },
    } as unknown as LanguageSupport;
    runFloorForSurface({
      surface: 'ci',
      cwd: tmp,
      packs: [scopePack],
      exec: spy,
      resolveEnabled: alwaysOn,
    });
    expect(seen[0].args).toEqual(['full']);
  });

  it('pre-push surface runs at AFFECTED scope', () => {
    const seen: string[][] = [];
    const spy: CommandExec = (cmd) => {
      seen.push([...cmd.args]);
      return { available: true, code: 0, output: '' };
    };
    const scopePack = {
      id: 'typescript',
      correctness: {
        execution: () => ({
          hosts: ['any' as const],
          toolchains: [],
          needsBuild: false,
          buildTarget: 'none' as const,
          weight: 'cheap' as const,
        }),
        syntaxCheck: () => null,
        affectedTests: (ctx: { scope: string }) => ({
          label: 'affected-tests',
          bin: 'faketool',
          args: [ctx.scope],
        }),
      },
    } as unknown as LanguageSupport;
    runFloorForSurface({
      surface: 'pre-push',
      cwd: tmp,
      packs: [scopePack],
      exec: spy,
      resolveEnabled: alwaysOn,
    });
    // No git base resolvable in the bare tmp dir → empty changedFiles, which the
    // contract says a pack treats as full; but the SURFACE we requested is
    // affected, so the scope handed to the pack is 'affected'.
    expect(seen[0]).toEqual(['affected']);
  });
});

describe('resolvePrePushBase (via a real git repo)', () => {
  it('returns "" in a non-git directory', async () => {
    const { resolvePrePushBase } = await import('../src/analyzers/correctness/surface-run');
    expect(resolvePrePushBase(tmp)).toBe('');
  });

  it('resolves the merge-base against an explicit ref', async () => {
    const { resolvePrePushBase } = await import('../src/analyzers/correctness/surface-run');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    // merge-base HEAD <first> is <first> itself (first is an ancestor of HEAD).
    expect(resolvePrePushBase(tmp, first)).toBe(first);
  });
});
