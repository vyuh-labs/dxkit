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

  it('records real tool versions in the tools map (D143 closure)', async () => {
    const result = await createBaseline({ cwd: dir });
    // No security findings on the bare fixture so the tools map can
    // be empty; the assertion that matters is "no value is the
    // literal 'unknown' string sentinel for tools that DID run."
    // In-process scanners (tls-bypass-registry; grep-secrets when
    // gitleaks isn't installed — surfaces on the CI runner, which
    // ships without gitleaks) carry the dxkit-prefixed tag.
    const inProcessTools = new Set(['tls-bypass-registry', 'grep-secrets']);
    for (const [tool, version] of Object.entries(result.file.tools)) {
      expect(version, `${tool} version`).not.toBe('unknown');
      if (inProcessTools.has(tool)) {
        expect(version, `${tool} should carry the dxkit-version tag`).toMatch(/^dxkit-/);
      }
    }
    // toolchainHash must reflect the tools map content
    expect(result.file.analysis.toolchainHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces byte-identical tools maps across two back-to-back captures (D144 closure)', async () => {
    // D144: `findTool`'s subprocess version probe can complete with
    // empty stdout under load, causing `resolveToolVersion` to
    // surface the `'present'` sentinel instead of the parsed semver.
    // Two back-to-back captures inside the same process would then
    // produce different tools maps, and the matcher's `tooling_drift`
    // gate would fire spuriously on a `guardrail check` immediately
    // after `baseline create`. The fix caches resolved versions
    // per-process; this test asserts the cache holds across two
    // sequential captures.
    const { clearToolVersionCache } = await import('../../src/baseline/create');
    clearToolVersionCache();
    const first = await createBaseline({ cwd: dir });
    const second = await createBaseline({ cwd: dir, force: true });
    expect(second.file.tools).toEqual(first.file.tools);
    expect(second.file.analysis.toolchainHash).toBe(first.file.analysis.toolchainHash);
  });

  it('picks up stale + large-file findings from the fixture repo', async () => {
    // Commit a stale on-disk artifact and a >500-line source file.
    writeFileSync(join(dir, 'leftover.bak'), 'old\n');
    const bigLines: string[] = [];
    for (let i = 0; i < 600; i++) bigLines.push(`const v${i} = ${i};`);
    writeFileSync(join(dir, 'huge.ts'), bigLines.join('\n') + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add fixture content'], { cwd: dir });

    const result = await createBaseline({ cwd: dir });
    const kinds = new Set(result.file.findings.map((f) => f.kind));
    expect(kinds.has('stale-file')).toBe(true);
    expect(kinds.has('large-file')).toBe(true);

    const stale = result.file.findings.find((f) => f.kind === 'stale-file');
    if (!stale || stale.kind !== 'stale-file') throw new Error('shape');
    expect(stale.suffix).toBe('bak');

    const large = result.file.findings.find((f) => f.kind === 'large-file');
    if (!large || large.kind !== 'large-file') throw new Error('shape');
    expect(large.file).toBe('huge.ts');
  });
});
