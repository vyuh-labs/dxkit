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
  describeUnmetRequirement,
  hostOf,
  toolchainInstallHint,
  TOOLCHAIN_DEFS,
  unmetRequirement,
  type ExecutionEnvironment,
  type ExecutionRequirement,
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
