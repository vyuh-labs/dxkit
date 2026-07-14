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
import type { BaselineFile } from '../../src/baseline/baseline-file';
import { isSanitized } from '../../src/baseline/sanitize';

/**
 * Narrow `CreateBaselineResult.file` to non-undefined. Every test
 * in this file runs in committed-full mode (no policy.json, no
 * CLI flag, visibility-probe returns 'unknown' inside the fixture
 * git repo → committed-full default) so `file` is always present.
 * Asserting once here keeps the test bodies focused on behavior.
 */
function expectFile(result: { file?: BaselineFile }): BaselineFile {
  if (!result.file) throw new Error('expected committed-mode result; got ref-based');
  return result.file;
}

/** Companion of `expectFile` for the on-disk path. */
function expectPath(result: { path?: string }): string {
  if (!result.path) throw new Error('expected committed-mode result; got ref-based');
  return result.path;
}

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
    const resultPath = expectPath(result);
    expect(resultPath).toBe(pathForBaseline(dir, 'main'));
    expect(existsSync(resultPath)).toBe(true);
    const file = readBaselineFile(resultPath);
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
    expect(expectFile(result).name).toBe('release');
  });

  it('reflects an env-var salt mode in the written file', async () => {
    process.env.DXKIT_BASELINE_SALT = 'explicit-salt';
    const result = await createBaseline({ cwd: dir });
    expect(expectFile(result).saltMode).toBe('env-var');
  });

  it('refuses to overwrite an existing file without force', async () => {
    await createBaseline({ cwd: dir });
    await expect(createBaseline({ cwd: dir })).rejects.toThrow(/already exists/);
  });

  it('overwrites when force is true', async () => {
    await createBaseline({ cwd: dir });
    const result2 = await createBaseline({ cwd: dir, force: true });
    expect(expectFile(result2).schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
  });

  it('stamps stable hashes for missing optional metadata files', async () => {
    const file = expectFile(await createBaseline({ cwd: dir }));
    expect(file.analysis.ignoreHash).toMatch(/^[0-9a-f]{16}$/);
    expect(file.analysis.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(file.analysis.policyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(file.analysis.toolchainHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reflects .dxkit-ignore presence in the ignore hash', async () => {
    const first = expectFile(await createBaseline({ cwd: dir }));
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit-ignore'), 'tmp/\n');
    const second = expectFile(await createBaseline({ cwd: dir, force: true }));
    expect(second.analysis.ignoreHash).not.toBe(first.analysis.ignoreHash);
  });

  it('records real tool versions in the tools map (D143 closure)', async () => {
    const file = expectFile(await createBaseline({ cwd: dir }));
    // No security findings on the bare fixture so the tools map can
    // be empty; the assertion that matters is "no value is the
    // literal 'unknown' string sentinel for tools that DID run."
    // In-process scanners (tls-bypass-registry; grep-secrets when
    // gitleaks isn't installed — surfaces on the CI runner, which
    // ships without gitleaks) carry the dxkit-prefixed tag.
    const inProcessTools = new Set(['tls-bypass-registry', 'grep-secrets']);
    for (const [tool, version] of Object.entries(file.tools)) {
      expect(version, `${tool} version`).not.toBe('unknown');
      if (inProcessTools.has(tool)) {
        expect(version, `${tool} should carry the dxkit-version tag`).toMatch(/^dxkit-/);
      }
    }
    // toolchainHash must reflect the tools map content
    expect(file.analysis.toolchainHash).toMatch(/^[0-9a-f]{16}$/);
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
    const first = expectFile(await createBaseline({ cwd: dir }));
    const second = expectFile(await createBaseline({ cwd: dir, force: true }));
    expect(second.tools).toEqual(first.tools);
    expect(second.analysis.toolchainHash).toBe(first.analysis.toolchainHash);
  });

  it('picks up stale + large-file findings from the fixture repo', async () => {
    // Commit a stale on-disk artifact and a >500-line source file.
    writeFileSync(join(dir, 'leftover.bak'), 'old\n');
    const bigLines: string[] = [];
    for (let i = 0; i < 600; i++) bigLines.push(`const v${i} = ${i};`);
    writeFileSync(join(dir, 'huge.ts'), bigLines.join('\n') + '\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add fixture content'], { cwd: dir });

    const file = expectFile(await createBaseline({ cwd: dir }));
    const kinds = new Set(file.findings.map((f) => f.kind));
    expect(kinds.has('stale-file')).toBe(true);
    expect(kinds.has('large-file')).toBe(true);

    const stale = file.findings.find((f) => f.kind === 'stale-file');
    if (!stale || stale.kind !== 'stale-file' || isSanitized(stale)) throw new Error('shape');
    expect(stale.suffix).toBe('bak');

    const large = file.findings.find((f) => f.kind === 'large-file');
    if (!large || large.kind !== 'large-file' || isSanitized(large)) throw new Error('shape');
    expect(large.file).toBe('huge.ts');
  });

  describe('mode dispatch', () => {
    it('committed-full writes rich entries (default behavior)', async () => {
      writeFileSync(join(dir, 'leftover.bak'), 'old\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
      const result = await createBaseline({ cwd: dir, cliMode: 'committed-full' });
      const file = expectFile(result);
      expect(result.mode.mode).toBe('committed-full');
      expect(result.mode.source).toBe('cli');
      const stale = file.findings.find((f) => f.kind === 'stale-file');
      if (!stale || stale.kind !== 'stale-file' || isSanitized(stale)) {
        throw new Error('expected rich stale-file entry');
      }
      // Rich entry — the suffix locator is present.
      expect(stale.suffix).toBe('bak');
    });

    it('committed-sanitized writes stripped entries', async () => {
      writeFileSync(join(dir, 'leftover.bak'), 'old\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
      const result = await createBaseline({ cwd: dir, cliMode: 'committed-sanitized' });
      const file = expectFile(result);
      expect(result.mode.mode).toBe('committed-sanitized');
      // Every finding has only id + kind + sanitized:true; no
      // suffix / file / line / tool fields survive.
      for (const entry of file.findings) {
        expect(isSanitized(entry), `${entry.kind} not sanitized`).toBe(true);
        const keys = Object.keys(entry).sort();
        expect(keys).toEqual(['id', 'kind', 'sanitized']);
      }
    });

    it('ref-based skips the write entirely and reports the ref in the resolved mode', async () => {
      const result = await createBaseline({
        cwd: dir,
        cliMode: 'ref-based',
        cliRef: 'origin/main',
      });
      expect(result.mode.mode).toBe('ref-based');
      expect(result.mode.ref).toBe('origin/main');
      expect(result.path).toBeUndefined();
      expect(result.file).toBeUndefined();
    });
  });

  // ─── gh #155: baseline create is allowlist-aware ──────────────────────────
  //
  // An actively-allowlisted finding must be held OUT of the captured baseline
  // (not grandfathered as `persisted`), and that exclusion must honor the
  // allowlist's expiry — an expired entry suppresses nothing, so its finding
  // baselines normally and resurfaces as net-new the moment the window lapses.
  describe('allowlist-aware capture (gh #155)', () => {
    /** Write a `.dxkit/allowlist.json` directly (bypasses the write-path
     *  validation so a deliberately-expired fixture entry is allowed). */
    function writeAllowlist(cwd: string, entries: Array<Record<string, unknown>>): void {
      mkdirSync(join(cwd, '.dxkit'), { recursive: true });
      writeFileSync(
        join(cwd, '.dxkit', 'allowlist.json'),
        JSON.stringify({ schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries }, null, 2) +
          '\n',
      );
    }

    /** Commit the stale + large-file fixture and return the two findings' ids. */
    async function captureFixtureIds(cwd: string): Promise<{ large: string; stale: string }> {
      writeFileSync(join(cwd, 'leftover.bak'), 'old\n');
      const bigLines: string[] = [];
      for (let i = 0; i < 600; i++) bigLines.push(`const v${i} = ${i};`);
      writeFileSync(join(cwd, 'huge.ts'), bigLines.join('\n') + '\n');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', 'fixture content'], { cwd });

      const file = expectFile(await createBaseline({ cwd }));
      const large = file.findings.find((f) => f.kind === 'large-file');
      const stale = file.findings.find((f) => f.kind === 'stale-file');
      if (!large || !stale) throw new Error('fixture did not produce both findings');
      return { large: large.id, stale: stale.id };
    }

    it('holds an actively-allowlisted finding out of the baseline + reports the split', async () => {
      const ids = await captureFixtureIds(dir);
      // Baseline WITHOUT an allowlist: both findings captured, nothing held out.
      const before = await createBaseline({ cwd: dir, force: true });
      expect(before.allowlistSplit?.allowlisted).toBe(0);
      expect(expectFile(before).findings.some((f) => f.id === ids.large)).toBe(true);

      // Allowlist the large-file finding (false-positive → non-expiring).
      writeAllowlist(dir, [
        {
          fingerprint: ids.large,
          kind: 'large-file',
          category: 'false-positive',
          reason: 'reviewed: generated file',
          addedBy: 'test',
          addedAt: '2020-01-01',
        },
      ]);

      const after = await createBaseline({ cwd: dir, force: true });
      const file = expectFile(after);
      // The allowlisted finding is NOT in the baseline; the stale one still is.
      expect(file.findings.some((f) => f.id === ids.large)).toBe(false);
      expect(file.findings.some((f) => f.id === ids.stale)).toBe(true);
      // The split is reported honestly for the CLI headline.
      expect(after.allowlistSplit?.allowlisted).toBe(1);
      expect(after.allowlistSplit?.byCategory).toEqual({ 'false-positive': 1 });
      expect(after.allowlistSplit?.live).toBe(file.findings.length);
    });

    it('an EXPIRED allowlist entry suppresses nothing — the finding baselines normally', async () => {
      const ids = await captureFixtureIds(dir);
      // accepted-risk with a PAST expiry → inactive → must NOT hold the finding out.
      writeAllowlist(dir, [
        {
          fingerprint: ids.large,
          kind: 'large-file',
          category: 'accepted-risk',
          reason: 'was deferred, window lapsed',
          addedBy: 'test',
          addedAt: '2020-01-01',
          expiresAt: '2020-06-01',
        },
      ]);

      const after = await createBaseline({ cwd: dir, force: true });
      const file = expectFile(after);
      expect(file.findings.some((f) => f.id === ids.large)).toBe(true);
      expect(after.allowlistSplit?.allowlisted).toBe(0);
    });

    it('a FUTURE-dated accepted-risk entry is active and held out', async () => {
      const ids = await captureFixtureIds(dir);
      writeAllowlist(dir, [
        {
          fingerprint: ids.large,
          kind: 'large-file',
          category: 'accepted-risk',
          reason: 'accepted for this quarter',
          addedBy: 'test',
          addedAt: '2020-01-01',
          expiresAt: '2999-01-01',
        },
      ]);

      const after = await createBaseline({ cwd: dir, force: true });
      expect(expectFile(after).findings.some((f) => f.id === ids.large)).toBe(false);
      expect(after.allowlistSplit?.allowlisted).toBe(1);
    });

    it('a wrong-kind allowlist entry does NOT suppress (fingerprint alone is insufficient)', async () => {
      const ids = await captureFixtureIds(dir);
      // Same fingerprint but kind `secret` — must not match the large-file finding.
      writeAllowlist(dir, [
        {
          fingerprint: ids.large,
          kind: 'secret',
          category: 'false-positive',
          reason: 'wrong kind',
          addedBy: 'test',
          addedAt: '2020-01-01',
        },
      ]);
      const after = await createBaseline({ cwd: dir, force: true });
      expect(expectFile(after).findings.some((f) => f.id === ids.large)).toBe(true);
      expect(after.allowlistSplit?.allowlisted).toBe(0);
    });
  });
});
