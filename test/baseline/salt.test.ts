import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSalt } from '../../src/analyzers/tools/salt';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-salt-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  // Per-fixture commit message so two repos produced back-to-back
  // don't hash to the same SHA when the wall-clock second is shared
  // (initial-commit SHA goes into the deterministic salt; collisions
  // there would make the "different repos → different salts" property
  // appear to fail).
  execFileSync('git', ['commit', '-q', '-m', `initial in ${dir}`], { cwd: dir });
  return dir;
}

describe('resolveSalt', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = makeRepo();
    savedEnv = process.env.DXKIT_BASELINE_SALT;
    delete process.env.DXKIT_BASELINE_SALT;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DXKIT_BASELINE_SALT;
    else process.env.DXKIT_BASELINE_SALT = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the env var over file and deterministic modes', () => {
    process.env.DXKIT_BASELINE_SALT = 'env-supplied-salt-value';
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'salt'), 'file-supplied-salt');
    const out = resolveSalt(dir);
    expect(out.mode).toBe('env-var');
    expect(out.salt).toBe('env-supplied-salt-value');
  });

  it('falls back to the .dxkit/salt file when no env var is set', () => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'salt'), 'file-supplied-salt\n');
    const out = resolveSalt(dir);
    expect(out.mode).toBe('file');
    expect(out.salt).toBe('file-supplied-salt');
  });

  it('falls through to deterministic when env and file are absent', () => {
    const out = resolveSalt(dir);
    expect(out.mode).toBe('deterministic');
    expect(out.salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same deterministic salt for the same repo across calls', () => {
    const a = resolveSalt(dir);
    const b = resolveSalt(dir);
    expect(a.salt).toBe(b.salt);
  });

  it('produces different deterministic salts for two different repos', () => {
    const other = makeRepo();
    try {
      const a = resolveSalt(dir).salt;
      const b = resolveSalt(other).salt;
      expect(a).not.toBe(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('treats an empty env var as not set', () => {
    process.env.DXKIT_BASELINE_SALT = '';
    const out = resolveSalt(dir);
    expect(out.mode).toBe('deterministic');
  });

  it('throws on a non-git directory with no env var or file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dxkit-salt-bare-'));
    try {
      expect(() => resolveSalt(empty)).toThrow(/Cannot derive a baseline salt/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
