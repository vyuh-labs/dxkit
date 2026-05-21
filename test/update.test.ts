/**
 * Tests for `vyuh-dxkit update` — the refresh path for customers who
 * initialized with an older dxkit version. Pre-Sprint-2 update only
 * drove the template generator and silently skipped the dxkit-* skills
 * + per-stack devcontainer + hooks + CI workflows. Customers on 2.5.1
 * had no path to receive 2.5.2's scaffold changes.
 *
 * These tests shell out to the built CLI so they observe the actual
 * end-to-end behavior the customer would see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { detectInstallFlags } from '../src/update';

const cliPath = path.resolve(__dirname, '..', 'dist', 'index.js');

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(cwd: string, args: string[]): CliRun {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

describe('detectInstallFlags', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-detect-flags-'));
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns all-false on an empty workspace', () => {
    const flags = detectInstallFlags(tmp);
    expect(flags.withDxkitAgents).toBe(false);
    expect(flags.withHooks).toBe(false);
    expect(flags.withPrecommit).toBe(false);
    expect(flags.withDevcontainer).toBe(false);
    expect(flags.withCiGuardrails).toBe(false);
    expect(flags.withBaselineRefresh).toBe(false);
    expect(flags.withPrReview).toBe(false);
  });

  it('detects withDxkitAgents when dxkit-learn skill is present', () => {
    const skillDir = path.join(tmp, '.claude', 'skills', 'dxkit-learn');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'stub');
    expect(detectInstallFlags(tmp).withDxkitAgents).toBe(true);
  });

  it('detects withHooks when .githooks/pre-push exists', () => {
    const hookDir = path.join(tmp, '.githooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'pre-push'), '#!/bin/sh\n');
    expect(detectInstallFlags(tmp).withHooks).toBe(true);
    // Pre-commit absence is independent of pre-push presence.
    expect(detectInstallFlags(tmp).withPrecommit).toBe(false);
    fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\n');
    expect(detectInstallFlags(tmp).withPrecommit).toBe(true);
  });

  it('detects withDevcontainer when .devcontainer/devcontainer.json exists', () => {
    const dcDir = path.join(tmp, '.devcontainer');
    fs.mkdirSync(dcDir, { recursive: true });
    fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), '{}');
    expect(detectInstallFlags(tmp).withDevcontainer).toBe(true);
  });

  it('detects CI workflows independently', () => {
    const wfDir = path.join(tmp, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'dxkit-guardrails.yml'), 'name: x');
    expect(detectInstallFlags(tmp).withCiGuardrails).toBe(true);
    expect(detectInstallFlags(tmp).withBaselineRefresh).toBe(false);
    fs.writeFileSync(path.join(wfDir, 'dxkit-baseline-refresh.yml'), 'name: x');
    expect(detectInstallFlags(tmp).withBaselineRefresh).toBe(true);
  });
});

describe('vyuh-dxkit update: end-to-end refresh', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-update-e2e-'));
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email t@t.t', { cwd: tmp });
    execSync('git config user.name t', { cwd: tmp });
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'test', version: '0.0.0' }, null, 2),
    );
    execSync('git add . && git commit -q -m init', { cwd: tmp });

    // Simulate a 2.5.1-era full install — let dxkit's own init drop the
    // full scaffold here so we observe a realistic baseline.
    runCli(tmp, ['init', '--full', '--yes']);
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('init landed the marquee 2.5.1 surfaces (six dxkit-* skills + devcontainer + hooks)', () => {
    // Pre-check: confirm the scaffold we're testing against. Without
    // these, the update assertions below have nothing to refresh.
    expect(fs.existsSync(path.join(tmp, '.vyuh-dxkit.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.claude', 'skills', 'dxkit-learn', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmp, '.githooks', 'pre-push'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.devcontainer', 'devcontainer.json'))).toBe(true);
  });

  it('update detects installed surfaces and reports them up front', () => {
    const r = runCli(tmp, ['update']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Detected install surfaces:/);
    expect(r.stdout).toContain('withDxkitAgents');
    expect(r.stdout).toContain('withDevcontainer');
    expect(r.stdout).toContain('withHooks');
  });

  it('update with --force refreshes the devcontainer.json (picks up per-stack extensions)', () => {
    // Mutate the devcontainer.json to a stale shape so we can verify
    // refresh actually overwrote it.
    const dcPath = path.join(tmp, '.devcontainer', 'devcontainer.json');
    fs.writeFileSync(dcPath, '{ "name": "stale" }\n');

    const r = runCli(tmp, ['update', '--force']);
    expect(r.exitCode).toBe(0);

    // After --force update, the file should be regenerated and contain
    // the canonical dxkit shape.
    const refreshed = fs.readFileSync(dcPath, 'utf-8');
    expect(refreshed).toContain('dxkit dev environment');
    expect(refreshed).not.toContain('"stale"');
  });

  it('update completes without errors on a real init-tree (smoke)', () => {
    const r = runCli(tmp, ['update']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Update complete');
  });
});
