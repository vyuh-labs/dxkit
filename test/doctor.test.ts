/**
 * Tests for the two-tier doctor (F-UX-1).
 *
 * Pre-2.4.7, `dxkit doctor` on a fresh repo without `.claude/` reported
 * "Fail: 10" — making users think dxkit was broken when actually the
 * reports CLI worked fine. The two-tier split (Reports prerequisites vs
 * Agent DX prerequisites) keeps the diagnostic value of the DX
 * checks but stops it from gating the exit code.
 *
 * These tests shell out to the built CLI rather than calling runDoctor()
 * directly so we observe the user-visible behavior (exit code + output
 * surface).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';

const cliPath = path.resolve(__dirname, '..', 'dist', 'index.js');

interface DoctorRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runDoctor(cwd: string, args: string[] = []): DoctorRun {
  try {
    const stdout = execFileSync('node', [cliPath, 'doctor', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('doctor (F-UX-1): two-tier framing', () => {
  let bareTmp: string;
  let scaffoldedTmp: string;

  beforeAll(() => {
    // Bare repo — git only, no .claude/ scaffolding.
    bareTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-bare-'));
    execSync('git init -q', { cwd: bareTmp });

    // Scaffolded repo — adds a manifest + minimum DX files so the DX
    // tier can score above zero. Not testing the full init template
    // here, just that the scoring logic differentiates the two states.
    scaffoldedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-scaffolded-'));
    execSync('git init -q', { cwd: scaffoldedTmp });
    fs.writeFileSync(
      path.join(scaffoldedTmp, '.vyuh-dxkit.json'),
      JSON.stringify({ version: '1', mode: 'dx-only', config: {} }),
    );
    fs.writeFileSync(path.join(scaffoldedTmp, 'CLAUDE.md'), '# Project rules\n');
    fs.mkdirSync(path.join(scaffoldedTmp, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(scaffoldedTmp, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(scaffoldedTmp, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(scaffoldedTmp, '.claude', 'agents-available'), { recursive: true });
    fs.writeFileSync(path.join(scaffoldedTmp, '.claude', 'settings.json'), '{}');
  });

  afterAll(() => {
    if (bareTmp) fs.rmSync(bareTmp, { recursive: true, force: true });
    if (scaffoldedTmp) fs.rmSync(scaffoldedTmp, { recursive: true, force: true });
  });

  it('exits 0 on a bare repo when the reports tier passes', () => {
    const r = runDoctor(bareTmp);
    // Pre-F-UX-1 this exit-coded non-zero because DX-tier failures
    // counted. Post-F-UX-1, DX failures are informational.
    expect(r.exitCode).toBe(0);
  });

  it('surfaces the two tiers separately in the output', () => {
    const r = runDoctor(bareTmp);
    expect(r.stdout).toContain('Reports prerequisites');
    expect(r.stdout).toContain('Agent DX prerequisites');
  });

  it('reports tier shows Node + git as passing on a viable host', () => {
    const r = runDoctor(bareTmp);
    expect(r.stdout).toMatch(/Reports:\s*2\/2/);
    expect(r.stdout).toContain('ready to run dxkit');
  });

  it('DX tier scores zero on a bare repo and hints at `init`', () => {
    const r = runDoctor(bareTmp);
    expect(r.stdout).toMatch(/Agent DX:\s*0\/\d+/);
    expect(r.stdout).toContain('Run `npx vyuh-dxkit init`');
  });

  it('DX tier scores higher when scaffolding is present', () => {
    const bare = runDoctor(bareTmp);
    const scaffolded = runDoctor(scaffoldedTmp);
    const bareMatch = bare.stdout.match(/Agent DX:\s*(\d+)\//);
    const scaffoldedMatch = scaffolded.stdout.match(/Agent DX:\s*(\d+)\//);
    expect(bareMatch).not.toBeNull();
    expect(scaffoldedMatch).not.toBeNull();
    expect(parseInt(scaffoldedMatch![1], 10)).toBeGreaterThan(parseInt(bareMatch![1], 10));
  });

  it('uses warn-style indicators (not fail) for missing DX scaffolding', () => {
    const r = runDoctor(bareTmp);
    // The summary line should say "partial scaffolding" (warn), not
    // "Fail: N" (the pre-2.4.7 framing that caused the credibility hit).
    expect(r.stdout).not.toMatch(/Fail:\s*\d+/);
    expect(r.stdout).toContain('partial scaffolding');
  });
});

describe('doctor: operational health (tier 3)', () => {
  let bareTmp: string;
  let scaffoldedTmp: string;

  beforeAll(() => {
    bareTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-op-bare-'));
    execSync('git init -q', { cwd: bareTmp });

    scaffoldedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-op-scaff-'));
    execSync('git init -q', { cwd: scaffoldedTmp });
    // Minimum scaffold the operational-tier checks key off of.
    fs.writeFileSync(
      path.join(scaffoldedTmp, '.vyuh-dxkit.json'),
      JSON.stringify({ version: '1', mode: 'full', config: { languages: {} } }),
    );
    // A pre-push hook file present but hooksPath unset — exactly the
    // D147 reproduction case.
    fs.mkdirSync(path.join(scaffoldedTmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(scaffoldedTmp, '.githooks', 'pre-push'), '#!/bin/sh\n');
  });

  afterAll(() => {
    if (bareTmp) fs.rmSync(bareTmp, { recursive: true, force: true });
    if (scaffoldedTmp) fs.rmSync(scaffoldedTmp, { recursive: true, force: true });
  });

  it('surfaces an Operational health tier when there are runtime signals to check', () => {
    const r = runDoctor(scaffoldedTmp);
    expect(r.stdout).toContain('Operational health');
  });

  it('flags hooks-not-activated when .githooks/pre-push exists but core.hooksPath is unset', () => {
    const r = runDoctor(scaffoldedTmp);
    // Exact label so dxkit-fix can parse it.
    expect(r.stdout).toContain('git hooks active');
    expect(r.stdout).toMatch(/git hooks active.*\.githooks/);
    // Fix hint surfaces the activate command.
    expect(r.stdout).toContain('npx vyuh-dxkit hooks activate');
  });

  it('flags missing baseline when manifest exists but .dxkit/baselines/main.json does not', () => {
    const r = runDoctor(scaffoldedTmp);
    expect(r.stdout).toContain('baseline captured');
    expect(r.stdout).toContain('npx vyuh-dxkit baseline create');
  });

  it('renders the Suggested fixes section when operational issues exist', () => {
    const r = runDoctor(scaffoldedTmp);
    expect(r.stdout).toContain('Suggested fixes');
    expect(r.stdout).toContain('dxkit-fix skill');
  });

  it('flags dxkit-not-a-devDependency when a hook exists but package.json omits it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-devdep-missing-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
      fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.githooks', 'pre-push'), '#!/bin/sh\n');
      const r = runDoctor(tmp);
      expect(r.stdout).toContain('dxkit in package.json devDependencies');
      expect(r.stdout).toContain('npm install --save-dev @vyuhlabs/dxkit');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes the devDependency check when dxkit is declared', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-devdep-present-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'demo', devDependencies: { '@vyuhlabs/dxkit': '^2.9.0' } }, null, 2),
      );
      fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.githooks', 'pre-push'), '#!/bin/sh\n');
      const r = runDoctor(tmp);
      // Check present and not in the fixes list for this label.
      expect(r.stdout).toContain('dxkit in package.json devDependencies');
      expect(r.stdout).not.toContain('npm install --save-dev @vyuhlabs/dxkit');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const writeAllowlist = (dir: string, entries: unknown[]) => {
    fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dxkit', 'allowlist.json'),
      JSON.stringify({ schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries }, null, 2),
    );
  };

  it('flags expired allowlist entries — the suppressed finding re-blocks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-allow-expired-'));
    try {
      execSync('git init -q', { cwd: tmp });
      writeAllowlist(tmp, [
        {
          fingerprint: 'a1a1a1a1a1a1a1a1',
          kind: 'code',
          category: 'accepted-risk',
          reason: 'temporary acceptance, now lapsed',
          addedBy: 'r@example.com',
          addedAt: '2020-01-01',
          expiresAt: '2020-02-01',
        },
      ]);
      const r = runDoctor(tmp);
      expect(r.stdout).toContain('allowlist suppressions');
      expect(r.stdout).toContain('expired');
      expect(r.stdout).toContain('npx vyuh-dxkit allowlist prune');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags allowlist entries expiring soon before they lapse', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-allow-soon-'));
    try {
      execSync('git init -q', { cwd: tmp });
      // Compute a date 5 days out so the test is stable regardless of
      // the wall-clock date it runs on (doctor uses the real `now`).
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      writeAllowlist(tmp, [
        {
          fingerprint: 'b2b2b2b2b2b2b2b2',
          kind: 'code',
          category: 'deferred',
          reason: 'fix scheduled next sprint',
          addedBy: 'r@example.com',
          addedAt: '2026-05-01',
          expiresAt: soon,
        },
      ]);
      const r = runDoctor(tmp);
      expect(r.stdout).toContain('allowlist suppressions');
      expect(r.stdout).toContain('expiring soon');
      expect(r.stdout).toContain('npx vyuh-dxkit allowlist audit');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A hook wired into core.hooksPath but left non-executable is silently
  // ignored by git — doctor must NOT report a false green here.
  it.skipIf(process.platform === 'win32')(
    'flags a wired-but-non-executable hook instead of a false green',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-hook-nonexec-'));
      try {
        execSync('git init -q', { cwd: tmp });
        execSync('git config --local core.hooksPath .githooks', { cwd: tmp });
        fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
        const hook = path.join(tmp, '.githooks', 'pre-push');
        fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(hook, 0o644); // wired but not executable
        const r = runDoctor(tmp);
        expect(r.stdout).toContain('git hooks active');
        expect(r.stdout).toContain('not executable');
        expect(r.stdout).toContain('npx vyuh-dxkit hooks activate');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'passes the hooks check when wired AND executable',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-hook-exec-'));
      try {
        execSync('git init -q', { cwd: tmp });
        execSync('git config --local core.hooksPath .githooks', { cwd: tmp });
        fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
        const hook = path.join(tmp, '.githooks', 'pre-push');
        fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(hook, 0o755);
        const r = runDoctor(tmp);
        expect(r.stdout).toContain('git hooks active');
        expect(r.stdout).not.toContain('not executable');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe('doctor --json: structured output', () => {
  let scaffoldedTmp: string;

  beforeAll(() => {
    scaffoldedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-doctor-json-'));
    execSync('git init -q', { cwd: scaffoldedTmp });
    fs.writeFileSync(
      path.join(scaffoldedTmp, '.vyuh-dxkit.json'),
      JSON.stringify({ version: '1', mode: 'full', config: { languages: {} } }),
    );
    fs.mkdirSync(path.join(scaffoldedTmp, '.githooks'), { recursive: true });
    fs.writeFileSync(path.join(scaffoldedTmp, '.githooks', 'pre-push'), '#!/bin/sh\n');
  });

  afterAll(() => {
    if (scaffoldedTmp) fs.rmSync(scaffoldedTmp, { recursive: true, force: true });
  });

  it('emits valid JSON to stdout with the doctor.v1 schema', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe('doctor.v1');
    expect(report.cwd).toBe(scaffoldedTmp);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('groups checks by tier (reports / dx / operational)', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    const report = JSON.parse(r.stdout);
    const tiers = new Set(report.checks.map((c: { tier: string }) => c.tier));
    expect(tiers.has('reports')).toBe(true);
    expect(tiers.has('dx')).toBe(true);
    expect(tiers.has('operational')).toBe(true);
  });

  it('every failing check with a known fix carries fix metadata', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    const report = JSON.parse(r.stdout);
    const failingWithFix = report.checks.filter(
      (c: { ok: boolean; fix?: unknown }) => !c.ok && c.fix,
    );
    expect(failingWithFix.length).toBeGreaterThan(0);
    for (const c of failingWithFix) {
      expect(c.fix.hint).toBeTruthy();
      // Commands are optional but when present, must be non-empty strings.
      if (c.fix.command !== undefined) expect(typeof c.fix.command).toBe('string');
    }
  });

  it('exposes a fixable[] array in summary that dxkit-fix consumes', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    const report = JSON.parse(r.stdout);
    expect(Array.isArray(report.summary.fixable)).toBe(true);
    // Every entry in fixable must have ok=false and a fix block.
    for (const c of report.summary.fixable) {
      expect(c.ok).toBe(false);
      expect(c.fix).toBeDefined();
    }
  });

  it('summarizes per-tier status (ok / partial / fail / absent)', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    const report = JSON.parse(r.stdout);
    expect(['ok', 'fail']).toContain(report.summary.reports.status);
    expect(['ok', 'partial', 'absent']).toContain(report.summary.dx.status);
    expect(['ok', 'partial', 'fail']).toContain(report.summary.operational.status);
  });

  it('does not include prose output on stdout in --json mode', () => {
    const r = runDoctor(scaffoldedTmp, ['--json']);
    // Prose headers route to stderr via setJsonMode. stdout should be pure JSON.
    expect(r.stdout).not.toContain('vyuh-dxkit doctor');
    expect(r.stdout).not.toContain('━━━');
  });
});
