import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import {
  BASELINE_SCHEMA_VERSION,
  pathForBaseline,
  readBaselineFile,
} from '../../src/baseline/baseline-file';

/**
 * Build a small git repo. The body of these tests doesn't care what
 * the analyzer finds — just that the orchestrator wires the salt
 * resolver, baseline-file writer, and producer hand-off correctly.
 * The security analyzer running on an empty repo produces an empty
 * aggregate, which is sufficient to exercise the orchestration path.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-create-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

describe('createBaseline (integration)', () => {
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

  it('writes a baseline file with the canonical schema banner', async () => {
    const result = await createBaseline({ cwd: dir });
    expect(result.path).toBe(pathForBaseline(dir, 'main'));
    expect(existsSync(result.path)).toBe(true);
    const file = readBaselineFile(result.path);
    expect(file.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
    expect(file.name).toBe('main');
    expect(file.repo.root).toBe(dir);
    expect(file.repo.branch).toBe('main');
    expect(file.repo.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(file.saltMode).toBe('deterministic');
    expect(file.findings).toEqual([]);
  });

  it('uses the supplied --name to pick the filename', async () => {
    const result = await createBaseline({ cwd: dir, name: 'release' });
    expect(result.path).toBe(pathForBaseline(dir, 'release'));
    expect(result.file.name).toBe('release');
  });

  it('reflects an env-var salt mode in the written file', async () => {
    process.env.DXKIT_BASELINE_SALT = 'explicit-salt';
    const result = await createBaseline({ cwd: dir });
    expect(result.file.saltMode).toBe('env-var');
  });

  it('refuses to overwrite an existing file without force', async () => {
    await createBaseline({ cwd: dir });
    await expect(createBaseline({ cwd: dir })).rejects.toThrow(/already exists/);
  });

  it('overwrites when force is true', async () => {
    await createBaseline({ cwd: dir });
    const result2 = await createBaseline({ cwd: dir, force: true });
    expect(result2.file.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
  });

  it('stamps stable hashes for missing optional metadata files', async () => {
    const result = await createBaseline({ cwd: dir });
    expect(result.file.analysis.ignoreHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.file.analysis.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.file.analysis.policyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.file.analysis.toolchainHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reflects .dxkit-ignore presence in the ignore hash', async () => {
    const first = await createBaseline({ cwd: dir });
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit-ignore'), 'tmp/\n');
    const second = await createBaseline({ cwd: dir, force: true });
    expect(second.file.analysis.ignoreHash).not.toBe(first.file.analysis.ignoreHash);
  });
});
