/**
 * The execution-environment platform (CLAUDE.md Rule 20) — unit layer.
 *
 * Pins the ONE satisfaction predicate both directions, the host mapping, the
 * repo-derived C# host narrowing (the dpl-studio class), and the runners'
 * pre-spawn environment consultation. The registry-driven flow (synthetic
 * pack → spec → runner) lives in `test/recipe-playbook.test.ts`; the per-pack
 * declaration contract lives in `test/languages-contract.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  classifyEnvironmentFailure,
  currentEnvironment,
  describeUnmetRequirement,
  hostOf,
  toolchainForBinary,
  toolchainHealthProblem,
  toolchainInstallHint,
  TOOLCHAIN_DEFS,
  unmetRequirement,
  type ExecutionEnvironment,
  type ExecutionRequirement,
  type ToolchainDef,
} from '../../src/execution';
import { csharp } from '../../src/languages/csharp';
import { runCorrectnessFloor, describeEnvironmentSkips } from '../../src/analyzers/correctness/run';
import { runCustomChecks } from '../../src/analyzers/custom-checks/run';
import type { LanguageSupport } from '../../src/languages/types';

const env = (host: 'linux' | 'macos' | 'windows', toolchains: string[]): ExecutionEnvironment => ({
  host,
  hasToolchain: (id) => toolchains.includes(id),
});

const req = (over: Partial<ExecutionRequirement>): ExecutionRequirement => ({
  hosts: ['any'],
  toolchains: [],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
  ...over,
});

describe('unmetRequirement — the one satisfaction predicate', () => {
  it('an unconstrained requirement is satisfied anywhere', () => {
    expect(unmetRequirement(req({}), env('linux', []))).toBeNull();
    expect(unmetRequirement(req({}), env('windows', []))).toBeNull();
  });

  it('a concrete host requirement is satisfied only on that host', () => {
    const windowsOnly = req({ hosts: ['windows'] });
    expect(unmetRequirement(windowsOnly, env('windows', []))).toBeNull();
    expect(unmetRequirement(windowsOnly, env('linux', []))).toEqual({
      kind: 'wrong-host',
      requiredHosts: ['windows'],
      currentHost: 'linux',
    });
  });

  it("'any' alongside a concrete host means no constraint", () => {
    expect(unmetRequirement(req({ hosts: ['windows', 'any'] }), env('linux', []))).toBeNull();
  });

  it('missing toolchains are reported together, present ones are not', () => {
    const needs = req({ toolchains: ['dotnet-sdk', 'node'] });
    expect(unmetRequirement(needs, env('linux', ['dotnet-sdk', 'node']))).toBeNull();
    expect(unmetRequirement(needs, env('linux', ['node']))).toEqual({
      kind: 'missing-toolchain',
      toolchains: ['dotnet-sdk'],
    });
  });

  it('the wrong host is reported before toolchains (more fundamental)', () => {
    const both = req({ hosts: ['windows'], toolchains: ['dotnet-sdk'] });
    expect(unmetRequirement(both, env('linux', []))?.kind).toBe('wrong-host');
  });

  it('descriptions name the need AND where it runs — never a bare error', () => {
    const wrongHost = describeUnmetRequirement({
      kind: 'wrong-host',
      requiredHosts: ['windows'],
      currentHost: 'linux',
    });
    expect(wrongHost).toContain('windows');
    expect(wrongHost).toContain('linux');
    expect(wrongHost).toContain('CI job');
    expect(
      describeUnmetRequirement({ kind: 'missing-toolchain', toolchains: ['dotnet-sdk'] }),
    ).toContain('dotnet-sdk');
  });
});

describe('environment model', () => {
  it('hostOf maps node platforms to execution hosts (POSIX → linux)', () => {
    expect(hostOf('win32')).toBe('windows');
    expect(hostOf('darwin')).toBe('macos');
    expect(hostOf('linux')).toBe('linux');
    expect(hostOf('freebsd')).toBe('linux');
  });

  it('every toolchain declares binaries, a fallback install, and per-host hints', () => {
    for (const def of Object.values(TOOLCHAIN_DEFS)) {
      expect(def.binaries.length).toBeGreaterThan(0);
      expect(def.install.fallback).toMatch(/^https?:\/\//);
      // The hint never comes back empty — an unknown host gets the fallback
      // URL, so a raw "'<pm>' is not recognized" is unconstructible from here.
      for (const host of ['linux', 'macos', 'windows'] as const) {
        expect(toolchainInstallHint(def.id as keyof typeof TOOLCHAIN_DEFS, host)).toBeTruthy();
      }
    }
  });
});

describe('csharp host narrowing (the dpl-studio class)', () => {
  function csprojRepo(csprojContent: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-exec-csharp-'));
    fs.writeFileSync(path.join(dir, 'App.csproj'), csprojContent);
    return dir;
  }

  const project = (props: string) =>
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props}</PropertyGroup></Project>`;

  it('a net*-windows TFM narrows every build-based capability to windows', () => {
    const dir = csprojRepo(project('<TargetFramework>net9.0-windows</TargetFramework>'));
    try {
      for (const r of [
        csharp.correctness.execution(dir),
        csharp.lintGate!.execution(dir),
        csharp.deepSast!.execution(dir),
      ]) {
        expect(r.hosts).toEqual(['windows']);
        expect(r.needsBuild).toBe(true);
        expect(r.toolchains).toContain('dotnet-sdk');
      }
      // A root .csproj is a target dotnet can discover itself.
      expect(csharp.correctness.execution(dir).buildTarget).toBe('discovered');
      // The dependency audit stays host-agnostic BY DESIGN — the osv half
      // reads manifests without dotnet, so auditing works where the Windows
      // build cannot run.
      expect(csharp.capabilities!.depVulns!.execution(dir).hosts).toEqual(['any']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an explicit WinForms/WPF opt-in narrows to windows too', () => {
    const dir = csprojRepo(
      project('<TargetFramework>net48</TargetFramework><UseWindowsForms>true</UseWindowsForms>'),
    );
    try {
      expect(csharp.correctness.execution(dir).hosts).toEqual(['windows']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cross-platform TFM stays host-agnostic', () => {
    const dir = csprojRepo(project('<TargetFramework>net9.0</TargetFramework>'));
    try {
      expect(csharp.correctness.execution(dir).hosts).toEqual(['any']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no discoverable root target reads as configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-exec-csharp-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'App.csproj'),
        project('<TargetFramework>net9.0</TargetFramework>'),
      );
      expect(csharp.correctness.execution(dir).buildTarget).toBe('configured');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('correctness runner honors declarations (Rule 20, both directions)', () => {
  const windowsPack = {
    id: 'winonly',
    displayName: 'WinOnly (synthetic)',
    correctness: {
      execution: () => req({ hosts: ['windows'], needsBuild: true, weight: 'build' }),
      syntaxCheck: () => ({ label: 'build', bin: 'winbuild', args: [] }),
      affectedTests: () => null,
    },
  } as unknown as LanguageSupport;

  it('an unmet requirement is a disclosed skip, decided BEFORE the spawn', () => {
    const exec = vi.fn(() => ({ available: true, code: 0, output: '' }));
    const result = runCorrectnessFloor({
      cwd: '/nonexistent-repo',
      changedFiles: [],
      scope: 'full',
      packs: [windowsPack],
      exec,
      env: env('linux', []),
    });
    expect(exec).not.toHaveBeenCalled();
    expect(result.ran).toBe(false);
    expect(result.blocks).toBe(false);
    expect(result.checks[0].status).toBe('skipped-environment');
    expect(result.checks[0].unmet?.kind).toBe('wrong-host');
    const skips = describeEnvironmentSkips(result);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('winonly');
    expect(skips[0]).toContain('windows');
  });

  it('a satisfied requirement executes normally (no over-skip)', () => {
    const exec = vi.fn(() => ({ available: true, code: 0, output: '' }));
    const result = runCorrectnessFloor({
      cwd: '/nonexistent-repo',
      changedFiles: [],
      scope: 'full',
      packs: [windowsPack],
      exec,
      env: env('windows', []),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.ran).toBe(true);
    expect(result.checks[0].status).toBe('pass');
    expect(describeEnvironmentSkips(result)).toEqual([]);
  });
});

describe('toolchain health (Rule 20, the F-14 present-but-unusable class)', () => {
  it('every declared health probe + failure signature is well-formed', () => {
    for (const def of Object.values(TOOLCHAIN_DEFS) as ToolchainDef[]) {
      for (const sig of [
        ...(def.health?.failures ?? []),
        ...(def.environmentFailurePatterns ?? []),
      ]) {
        expect(() => new RegExp(sig.pattern, 'i'), `${def.id}/${sig.id}`).not.toThrow();
        expect(sig.problem.length, `${def.id}/${sig.id}: problem`).toBeGreaterThan(0);
        expect(sig.remedy.length, `${def.id}/${sig.id}: remedy`).toBeGreaterThan(0);
      }
      if (def.health) {
        expect(def.health.probe.bin.length).toBeGreaterThan(0);
        expect(def.health.fallback.problem.length).toBeGreaterThan(0);
        expect(def.health.fallback.remedy.length).toBeGreaterThan(0);
      }
    }
  });

  it('a healthy probe (exit 0) reports no problem', () => {
    expect(toolchainHealthProblem('dotnet-sdk', () => ({ code: 0, output: '9.0.315' }))).toBeNull();
  });

  it('a failed probe matching a signature names that diagnosis', () => {
    const p = toolchainHealthProblem('dotnet-sdk', () => ({
      code: 1,
      output: 'A fatal error occurred. The required library libhostfxr.so could not be found.',
    }));
    expect(p?.problem).toContain('cannot find its runtime');
    expect(p?.remedy).toContain('dotnet-install.sh');
  });

  it('a failed probe matching nothing still names the fallback boundary', () => {
    const p = toolchainHealthProblem('dotnet-sdk', () => ({
      code: 134,
      output: 'Segmentation fault',
    }));
    expect(p?.problem).toContain('not functional');
  });

  it('a toolchain with no declared probe is healthy without spawning', () => {
    const exec = vi.fn(() => ({ code: 1, output: 'never' }));
    expect(toolchainHealthProblem('node', exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('the dotnet probe mirrors the pack spawn env (invariant globalization)', () => {
    // dxkit self-heals the libicu class for its own dotnet spawns
    // (ensureDotnetInvariant), so the probe must answer for THAT env — a
    // libicu-less host it heals is healthy, not a false boundary.
    expect(TOOLCHAIN_DEFS['dotnet-sdk'].health?.probe.env).toMatchObject({
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
    });
  });

  it('currentEnvironment memoizes the health probe per toolchain', () => {
    const exec = vi.fn(() => ({ code: 1, output: 'broken' }));
    const e = currentEnvironment(exec);
    e.toolchainProblem?.('dotnet-sdk');
    e.toolchainProblem?.('dotnet-sdk');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('unmetRequirement mints unhealthy-toolchain from a health-aware env', () => {
    const needsDotnet = req({ toolchains: ['dotnet-sdk'] });
    const unhealthyEnv: ExecutionEnvironment = {
      host: 'linux',
      hasToolchain: () => true,
      toolchainProblem: () => ({ problem: 'broken SDK', remedy: 'reinstall it' }),
    };
    const unmet = unmetRequirement(needsDotnet, unhealthyEnv);
    expect(unmet).toEqual({
      kind: 'unhealthy-toolchain',
      toolchain: 'dotnet-sdk',
      problem: 'broken SDK',
      remedy: 'reinstall it',
    });
    // The description carries the remedy — a boundary is never a dead end.
    expect(describeUnmetRequirement(unmet!)).toContain('reinstall it');
    // An env that cannot answer health (no toolchainProblem) skips the tier.
    expect(unmetRequirement(needsDotnet, env('linux', ['dotnet-sdk']))).toBeNull();
  });
});

describe('classifyEnvironmentFailure (the F-14 post-failure tier)', () => {
  const NETSDK_OUTPUT =
    'error NETSDK1045: The current .NET SDK does not support targeting .NET 9.0.';
  const COMPILE_ERROR = 'Program.cs(12,5): error CS1002: ; expected';

  it('an environment-shaped failure on a declared toolchain is classified', () => {
    const hit = classifyEnvironmentFailure(['dotnet-sdk'], NETSDK_OUTPUT);
    expect(hit?.toolchain).toBe('dotnet-sdk');
    expect(hit?.problem).toContain('newer .NET');
  });

  it('the same output against a different toolchain is NOT classified', () => {
    expect(classifyEnvironmentFailure(['node'], NETSDK_OUTPUT)).toBeNull();
  });

  it('a real compile error is never reclassified (false-negative bias)', () => {
    expect(classifyEnvironmentFailure(['dotnet-sdk'], COMPILE_ERROR)).toBeNull();
    expect(classifyEnvironmentFailure(['dotnet-sdk'], '')).toBeNull();
  });

  it('rust: a missing platform linker is environment, not a finding (VERIFY-40 F-10)', () => {
    // The exact output cargo emitted on the axum eval repo: rustc present,
    // no C toolchain — every build script fails before the user's code is
    // judged. Pre-fix this minted a lint finding AND failed the floor.
    const CC_MISSING = 'error: linker `cc` not found\n  = note: No such file or directory';
    const hit = classifyEnvironmentFailure(['rust'], CC_MISSING);
    expect(hit?.toolchain).toBe('rust');
    expect(hit?.problem).toContain('linker');
    expect(hit?.remedy).toContain('build-essential');
    // windows spelling of the same boundary
    expect(classifyEnvironmentFailure(['rust'], 'error: linker `link.exe` not found')).toBeTruthy();
    // crate pinned to a newer rustc
    expect(
      classifyEnvironmentFailure(['rust'], 'package `foo v1.0.0` requires rustc 1.99 or newer'),
    ).toBeTruthy();
    // a real rust compile error is never reclassified
    expect(
      classifyEnvironmentFailure(['rust'], 'error[E0308]: mismatched types\n --> src/main.rs:3:5'),
    ).toBeNull();
  });

  it('missing-toolchain descriptions name the per-host install (root remedy)', () => {
    const line = describeUnmetRequirement(
      { kind: 'missing-toolchain', toolchains: ['dotnet-sdk'] },
      'linux',
    );
    expect(line).toContain('dotnet-install.sh');
  });

  it('toolchainForBinary maps a driver binary to its registry toolchain', () => {
    expect(toolchainForBinary('dotnet')?.id).toBe('dotnet-sdk');
    expect(toolchainForBinary('definitely-not-a-toolchain')).toBeNull();
  });
});

describe('runners reclassify environment-shaped failures (F-14, both directions)', () => {
  const NETSDK_FAIL = {
    available: true,
    code: 1,
    output: 'error NETSDK1045: The current .NET SDK does not support targeting .NET 9.0.',
  };
  const REAL_FAIL = { available: true, code: 1, output: 'Program.cs(12,5): error CS1002' };

  const dotnetPack = {
    id: 'csharp',
    correctness: {
      execution: () => req({ toolchains: ['dotnet-sdk'], needsBuild: true, weight: 'build' }),
      syntaxCheck: () => ({ label: 'build', bin: 'dotnet', args: ['build'] }),
      affectedTests: () => null,
    },
  } as unknown as LanguageSupport;
  const healthyEnv: ExecutionEnvironment = { host: 'linux', hasToolchain: () => true };

  it('floor: an SDK-shaped failure is a boundary, not a block', () => {
    const result = runCorrectnessFloor({
      cwd: '/nonexistent-repo',
      changedFiles: [],
      scope: 'full',
      packs: [dotnetPack],
      exec: () => NETSDK_FAIL,
      env: healthyEnv,
    });
    expect(result.blocks).toBe(false);
    expect(result.checks[0].status).toBe('skipped-environment');
    expect(result.checks[0].unmet?.kind).toBe('unhealthy-toolchain');
  });

  it('floor: a real compile error still blocks', () => {
    const result = runCorrectnessFloor({
      cwd: '/nonexistent-repo',
      changedFiles: [],
      scope: 'full',
      packs: [dotnetPack],
      exec: () => REAL_FAIL,
      env: healthyEnv,
    });
    expect(result.blocks).toBe(true);
    expect(result.checks[0].status).toBe('fail');
  });

  const lintSpec = {
    name: 'lint:csharp',
    command: { bin: 'dotnet', args: ['build'] },
    blocking: true,
    expectedExit: 0,
    parse: { mode: 'regex' as const, pattern: '^(?<file>.+?)\\((?<line>\\d+),\\d+\\): warning' },
    execution: req({ toolchains: ['dotnet-sdk'], needsBuild: true, weight: 'build' }),
  };

  it('lint gate: an SDK-shaped failure is a disclosed boundary, never a binary finding', () => {
    const result = runCustomChecks({
      cwd: '/nonexistent-repo',
      specs: [lintSpec],
      exec: () => NETSDK_FAIL,
      env: healthyEnv,
    });
    expect(result.results[0].status).toBe('skipped-environment');
    expect(result.results[0].reason).toContain('newer .NET');
    expect(result.findings).toEqual([]);
  });

  it('lint gate: a non-environment failure still yields the binary finding', () => {
    const result = runCustomChecks({
      cwd: '/nonexistent-repo',
      specs: [lintSpec],
      exec: () => REAL_FAIL,
      env: healthyEnv,
    });
    expect(result.results[0].status).toBe('fail');
    expect(result.findings).toHaveLength(1);
  });
});

describe('custom-check runner: declaration-less checks keep the plain path', () => {
  it('a user check (no execution declared) is never environment-skipped', () => {
    const exec = vi.fn(() => ({ available: true, code: 0, output: '' }));
    const result = runCustomChecks({
      cwd: '/nonexistent-repo',
      specs: [
        {
          name: 'user-check',
          command: { bin: 'make', args: ['lint'] },
          blocking: true,
          expectedExit: 0,
          parse: { mode: 'exit' },
        },
      ],
      exec,
      // An environment that satisfies nothing — must not matter without a
      // declaration: dxkit cannot know what `make lint` needs, and inventing
      // a requirement would be worse than admitting the limit.
      env: env('linux', []),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.results[0].status).toBe('pass');
  });
});
