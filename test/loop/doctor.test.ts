import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildLoopDoctorReport } from '../../src/loop/doctor';

function tmpRepo(git: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-loop-doctor-'));
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  }
  return dir;
}

function writeSettings(cwd: string, obj: unknown): void {
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify(obj));
}

function writeBaseline(cwd: string): void {
  fs.mkdirSync(path.join(cwd, '.dxkit', 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.dxkit', 'baselines', 'main.json'), '{}');
}

function writeCommittedFullPolicy(cwd: string): void {
  fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
  // Pin committed-full so the baseline check looks for a file (not a ref),
  // making the test independent of repo visibility / network.
  fs.writeFileSync(
    path.join(cwd, '.dxkit', 'policy.json'),
    JSON.stringify({ baseline: { mode: 'committed-full' } }),
  );
}

function statusOf(report: ReturnType<typeof buildLoopDoctorReport>, labelFrag: string) {
  return report.checks.find((c) => c.label.includes(labelFrag))?.status;
}

describe('loop doctor', () => {
  const savedTestCmd = process.env.DXKIT_LOOP_TEST_COMMAND;
  let repo: string;

  beforeEach(() => {
    delete process.env.DXKIT_LOOP_TEST_COMMAND;
    delete process.env.DXKIT_LOOP_PRESET;
  });
  afterEach(() => {
    if (savedTestCmd === undefined) delete process.env.DXKIT_LOOP_TEST_COMMAND;
    else process.env.DXKIT_LOOP_TEST_COMMAND = savedTestCmd;
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fails when no baseline and no Stop hook are present', () => {
    repo = tmpRepo(true);
    writeCommittedFullPolicy(repo);
    const report = buildLoopDoctorReport(repo);
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'git repository')).toBe('pass');
    expect(statusOf(report, 'baseline')).toBe('fail');
    expect(statusOf(report, 'Stop-gate hook')).toBe('fail');
  });

  it('passes baseline + hook checks when both are wired (committed mode)', () => {
    repo = tmpRepo(true);
    writeCommittedFullPolicy(repo);
    writeBaseline(repo);
    writeSettings(repo, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx vyuh-dxkit hook stop-gate' }] }] },
    });
    const report = buildLoopDoctorReport(repo);
    expect(statusOf(report, 'baseline')).toBe('pass');
    expect(statusOf(report, 'Stop-gate hook')).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('does not treat an unrelated Stop hook as the gate', () => {
    repo = tmpRepo(true);
    writeCommittedFullPolicy(repo);
    writeBaseline(repo);
    writeSettings(repo, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    });
    expect(statusOf(buildLoopDoctorReport(repo), 'Stop-gate hook')).toBe('fail');
  });

  it('warns (not fails) when the postflight test command is unset', () => {
    repo = tmpRepo(true);
    writeCommittedFullPolicy(repo);
    writeBaseline(repo);
    expect(statusOf(buildLoopDoctorReport(repo), 'postflight test command')).toBe('warn');
    process.env.DXKIT_LOOP_TEST_COMMAND = 'npm test';
    expect(statusOf(buildLoopDoctorReport(repo), 'postflight test command')).toBe('pass');
  });

  it('reports the active preset and surfaces it in a check', () => {
    repo = tmpRepo(true);
    writeCommittedFullPolicy(repo);
    process.env.DXKIT_LOOP_PRESET = 'full-debt';
    const report = buildLoopDoctorReport(repo);
    expect(report.preset).toBe('full-debt');
    expect(statusOf(report, 'loop preset')).toBe('pass');
  });

  it('fails the git check outside a repo', () => {
    repo = tmpRepo(false);
    expect(statusOf(buildLoopDoctorReport(repo), 'git repository')).toBe('fail');
  });
});
