/**
 * The placement resolver + host-gate generation (CLAUDE.md Rule 20, 4.0
 * increment 3), including the placement/honesty PARITY test: the resolver
 * ("what runs where") and the runners' disclosure ("what is unmeasured here")
 * are two consumers of ONE concept holding different shapes — exactly the
 * semantic-divergence class an arch-check grep cannot see, so they are pinned
 * against each other on shared fixtures.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolvePlacement,
  unmetRequirement,
  type CapabilityRequirement,
  type ExecutionEnvironment,
  type ExecutionRequirement,
} from '../../src/execution';
import { collectExecutionRequirements } from '../../src/languages';
import { csharp } from '../../src/languages/csharp';
import { typescript } from '../../src/languages/typescript';
import { installCiHostGates, repoPlacementPlan } from '../../src/ship-installers';

const req = (over: Partial<ExecutionRequirement>): ExecutionRequirement => ({
  hosts: ['any'],
  toolchains: [],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
  ...over,
});

const cap = (
  pack: string,
  capability: CapabilityRequirement['capability'],
  over: Partial<ExecutionRequirement>,
): CapabilityRequirement => ({ pack, capability, requirement: req(over) });

describe('resolvePlacement', () => {
  it('host-agnostic capabilities stay on the primary job', () => {
    const plan = resolvePlacement([
      cap('typescript', 'correctness', {}),
      cap('python', 'lintGate', { hosts: ['linux', 'macos', 'windows'] }),
    ]);
    expect(plan.hostJobs).toEqual([]);
    expect(plan.primary).toHaveLength(2);
  });

  it('a windows-only capability is routed to a windows job with the right runner', () => {
    const plan = resolvePlacement([
      cap('typescript', 'correctness', {}),
      cap('csharp', 'correctness', { hosts: ['windows'], needsBuild: true }),
      cap('csharp', 'lintGate', { hosts: ['windows'], needsBuild: true }),
    ]);
    expect(plan.hostJobs).toHaveLength(1);
    const job = plan.hostJobs[0];
    expect(job.host).toBe('windows');
    expect(job.runner).toBe('windows-latest');
    expect(job.packs).toEqual(['csharp']); // deduped across capabilities
    expect(job.capabilities).toHaveLength(2);
    expect(plan.primary.map((c) => c.pack)).toEqual(['typescript']);
  });

  it('multiple constrained hosts produce jobs in deterministic order (windows, macos)', () => {
    const plan = resolvePlacement([
      cap('swift', 'correctness', { hosts: ['macos'] }),
      cap('csharp', 'correctness', { hosts: ['windows'] }),
    ]);
    expect(plan.hostJobs.map((j) => j.host)).toEqual(['windows', 'macos']);
  });

  it('a capability declaring several viable hosts goes to its FIRST preference', () => {
    const plan = resolvePlacement([cap('x', 'correctness', { hosts: ['macos', 'windows'] })]);
    expect(plan.hostJobs.map((j) => j.host)).toEqual(['macos']);
  });
});

describe('placement/honesty parity (one concept, two consumers)', () => {
  // An environment on the primary host with EVERY toolchain present and
  // healthy, so the only reason the runner could skip is the HOST dimension —
  // the dimension placement decides. On these shared inputs the two consumers
  // must partition capabilities identically: off-primary-placed ⇔ wrong-host
  // skipped. If either side re-derived the concept with weaker logic (the
  // gate-vs-join class), this is the test that catches it.
  const primaryEnvAllToolchains: ExecutionEnvironment = {
    host: 'linux',
    hasToolchain: () => true,
  };

  function assertParity(caps: readonly CapabilityRequirement[]): void {
    const plan = resolvePlacement(caps);
    const placedOff = new Set(
      plan.hostJobs.flatMap((j) => j.capabilities.map((c) => `${c.pack}/${c.capability}`)),
    );
    for (const c of caps) {
      const unmet = unmetRequirement(c.requirement, primaryEnvAllToolchains);
      const key = `${c.pack}/${c.capability}`;
      if (unmet?.kind === 'wrong-host') {
        expect(
          placedOff.has(key),
          `${key}: runner discloses wrong-host but placement kept it primary`,
        ).toBe(true);
      } else {
        expect(
          placedOff.has(key),
          `${key}: placement moved it off-primary but the runner would run it`,
        ).toBe(false);
      }
    }
  }

  it('agrees on a real windows-targeting C# repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-parity-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-windows</TargetFramework></PropertyGroup></Project>',
      );
      const caps = collectExecutionRequirements(dir, [csharp, typescript]);
      expect(caps.length).toBeGreaterThan(4);
      assertParity(caps);
      // And the concrete expectation: exactly csharp's build-based capabilities move.
      const plan = resolvePlacement(caps);
      expect(plan.hostJobs.map((j) => j.host)).toEqual(['windows']);
      expect(plan.hostJobs[0].packs).toEqual(['csharp']);
      expect(plan.hostJobs[0].capabilities.map((c) => c.capability).sort()).toEqual([
        'correctness',
        'deepSast',
        'lintGate',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees on a cross-platform repo (nothing moves)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-parity-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
      );
      const caps = collectExecutionRequirements(dir, [csharp, typescript]);
      assertParity(caps);
      expect(resolvePlacement(caps).hostJobs).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installCiHostGates (generated per-host gate jobs)', () => {
  function winformsRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-hostgate-'));
    fs.writeFileSync(
      path.join(dir, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>',
    );
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'Main.cs'), 'class Program { static void Main() {} }');
    return dir;
  }

  it('generates a windows gate for a windows-targeting repo — and never a VS install path', () => {
    const dir = winformsRepo();
    try {
      const result = installCiHostGates(dir, {});
      const rel = path.join('.github', 'workflows', 'dxkit-gate-windows.yml');
      expect(result.installed).toContain(rel);
      const content = fs.readFileSync(path.join(dir, rel), 'utf8');
      expect(content).toContain('runs-on: windows-latest');
      expect(content).toContain('name: dxkit-gate-windows');
      expect(content).toContain('--packs csharp');
      expect(content).toContain('actions/setup-dotnet');
      // The load-bearing generator lesson (ROADMAP §exec-env, learned on the
      // real customer PR): a hardcoded Visual Studio install path broke on
      // the runner's VS roll. Setup actions only — pinned here forever.
      expect(content).not.toMatch(/Visual Studio.{0,4}\d{4}/);
      expect(content).not.toContain('DisableOutOfProcBuild');
      // No macos job for this repo.
      expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'dxkit-gate-macos.yml'))).toBe(
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent (second run skips, byte-identical)', () => {
    const dir = winformsRepo();
    try {
      installCiHostGates(dir, {});
      const rel = path.join('.github', 'workflows', 'dxkit-gate-windows.yml');
      const second = installCiHostGates(dir, {});
      expect(second.installed).toEqual([]);
      expect(second.skipped).toContain(rel);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires a generated gate when the stack stops needing its host', () => {
    const dir = winformsRepo();
    try {
      installCiHostGates(dir, {});
      // The repo drops its windows-only target.
      fs.writeFileSync(
        path.join(dir, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
      );
      const result = installCiHostGates(dir, {});
      expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'dxkit-gate-windows.yml'))).toBe(
        false,
      );
      expect(result.notes.some((n) => n.includes('Removed'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never deletes a user-owned file at the gate path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-hostgate-'));
    try {
      const rel = path.join(dir, '.github', 'workflows', 'dxkit-gate-windows.yml');
      fs.mkdirSync(path.dirname(rel), { recursive: true });
      fs.writeFileSync(rel, 'name: my own workflow\njobs: {}\n');
      installCiHostGates(dir, {});
      expect(fs.readFileSync(rel, 'utf8')).toContain('my own workflow');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces nothing on a host-agnostic repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-hostgate-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
      const result = installCiHostGates(dir, {});
      expect(result.installed).toEqual([]);
      expect(repoPlacementPlan(dir).hostJobs).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
