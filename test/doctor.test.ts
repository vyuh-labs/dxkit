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

function runDoctor(cwd: string): DoctorRun {
  try {
    const stdout = execFileSync('node', [cliPath, 'doctor'], {
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
    expect(r.stdout).toContain('Run `vyuh-dxkit init`');
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
