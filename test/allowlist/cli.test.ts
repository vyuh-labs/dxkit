import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runAllowlistAdd,
  runAllowlistAudit,
  runAllowlistList,
  runAllowlistPrune,
  runAllowlistRemove,
  runAllowlistShow,
} from '../../src/allowlist/cli';
import {
  ALLOWLIST_SCHEMA_VERSION,
  loadAllowlist,
  pathForAllowlist,
  type AllowlistFile,
} from '../../src/allowlist/file';
import { findAnnotationAt } from '../../src/allowlist/inline';
import { getLanguage } from '../../src/languages';

function makeTmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-allowlist-cli-'));
  // Seed git config so resolveGitUserEmail returns deterministic value
  fs.writeFileSync(path.join(dir, '.gitconfig-script'), '[user]\n  email = test@example.com\n');
  return dir;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Capture process.exit + console output. The CLI module calls
// process.exit on error paths; we want to detect those without
// killing the test runner.
function mockExit() {
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code ?? 0})`);
    });
  return exitSpy;
}

describe('runAllowlistAdd — inline path', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('inserts an inline annotation at file:line and exits zero', async () => {
    const file = path.join(tmp, 'a.py');
    fs.writeFileSync(file, 'api_key = "x"\n', 'utf8');

    await runAllowlistAdd(tmp, {
      target: 'a.py:1',
      category: 'test-fixture',
      reason: 'placeholder in unit test',
    });

    const found = findAnnotationAt(file, 1, getLanguage('python')!);
    expect(found?.annotation.category).toBe('test-fixture');
    expect(found?.annotation.reason).toBe('placeholder in unit test');
  });

  it('rejects file-only category for inline path', async () => {
    const file = path.join(tmp, 'a.py');
    fs.writeFileSync(file, 'x\n', 'utf8');

    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        target: 'a.py:1',
        category: 'accepted-risk',
        reason: 'x',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('rejects unknown language extension for inline path', async () => {
    const file = path.join(tmp, 'a.xyz');
    fs.writeFileSync(file, 'x\n', 'utf8');

    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        target: 'a.xyz:1',
        category: 'test-fixture',
        reason: 'x',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('requires --reason', async () => {
    const file = path.join(tmp, 'a.py');
    fs.writeFileSync(file, 'x\n', 'utf8');

    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        target: 'a.py:1',
        category: 'test-fixture',
        reason: '   ',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('requires --category', async () => {
    const file = path.join(tmp, 'a.py');
    fs.writeFileSync(file, 'x\n', 'utf8');

    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        target: 'a.py:1',
        reason: 'rationale',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('rejects unknown category value', async () => {
    const file = path.join(tmp, 'a.py');
    fs.writeFileSync(file, 'x\n', 'utf8');

    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        target: 'a.py:1',
        category: 'invented',
        reason: 'rationale',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});

describe('runAllowlistAdd — file-level path', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('creates a file-level entry with fingerprint + kind', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'WAF rule X mitigates this CVE',
      addedBy: 'alice@example.com',
    });

    const loaded = loadAllowlist(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0]).toMatchObject({
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'WAF rule X mitigates this CVE',
      addedBy: 'alice@example.com',
    });
  });

  it('auto-defaults expiresAt to ~90 days out for accepted-risk', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'accepted',
      addedBy: 'alice@example.com',
    });
    const loaded = loadAllowlist(tmp);
    expect(loaded!.entries[0].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Sanity: expiresAt is in the future
    const today = new Date().toISOString().slice(0, 10);
    expect(loaded!.entries[0].expiresAt! >= today).toBe(true);
  });

  it('rejects category that does not apply to kind', async () => {
    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        fingerprint: 'a3f9c0e8b7d2e1f4',
        kind: 'coverage-gap',
        category: 'false-positive', // not applicable to coverage-gap
        reason: 'r',
        addedBy: 'a@b.c',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('rejects when --fingerprint missing and no inline target', async () => {
    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        category: 'mitigated-externally',
        reason: 'r',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('refuses to overwrite an existing entry with the same fingerprint', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'first',
      addedBy: 'a@b.c',
    });
    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        fingerprint: 'a3f9c0e8b7d2e1f4',
        kind: 'dep-vuln',
        category: 'mitigated-externally',
        reason: 'second',
        addedBy: 'a@b.c',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('honors --expires when provided', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'r',
      addedBy: 'a@b.c',
      expires: '2027-01-01',
    });
    const loaded = loadAllowlist(tmp);
    expect(loaded!.entries[0].expiresAt).toBe('2027-01-01');
  });

  it('rejects malformed --expires', async () => {
    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        fingerprint: 'a3f9c0e8b7d2e1f4',
        kind: 'dep-vuln',
        category: 'accepted-risk',
        reason: 'r',
        addedBy: 'a@b.c',
        expires: 'last Tuesday',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('honors --acknowledged-severity when valid', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'r',
      addedBy: 'a@b.c',
      acknowledgedSeverity: 'high',
    });
    const loaded = loadAllowlist(tmp);
    expect(loaded!.entries[0].acknowledgedSeverity).toBe('high');
  });

  it('rejects unknown --acknowledged-severity', async () => {
    const exit = mockExit();
    await expect(
      runAllowlistAdd(tmp, {
        fingerprint: 'a3f9c0e8b7d2e1f4',
        kind: 'dep-vuln',
        category: 'accepted-risk',
        reason: 'r',
        addedBy: 'a@b.c',
        acknowledgedSeverity: 'super-critical',
      }),
    ).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});

describe('runAllowlistList', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('prints empty hint when no allowlist exists (text mode)', async () => {
    // No error, no exit. Just runs.
    await expect(runAllowlistList(tmp, { json: false })).resolves.toBeUndefined();
  });

  it('emits JSON envelope on --json with empty file', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistList(tmp, { json: true });
    const printed = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(printed);
    expect(parsed).toMatchObject({
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries: [],
    });
    stdoutSpy.mockRestore();
  });

  it('prints existing entries (text mode)', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'WAF mitigates',
      addedBy: 'a@b.c',
    });
    // No error, no exit.
    await expect(runAllowlistList(tmp, { json: false })).resolves.toBeUndefined();
  });

  it('round-trips entries via JSON output', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'WAF mitigates',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistList(tmp, { json: true });
    const parsed: AllowlistFile = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].fingerprint).toBe('a3f9c0e8b7d2e1f4');
    stdoutSpy.mockRestore();
  });
});

describe('runAllowlistShow', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('rejects when fingerprint missing', async () => {
    const exit = mockExit();
    await expect(runAllowlistShow(tmp, {})).rejects.toThrow(/process\.exit/);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('rejects when allowlist file missing', async () => {
    const exit = mockExit();
    await expect(runAllowlistShow(tmp, { fingerprint: 'a3f9c0e8b7d2e1f4' })).rejects.toThrow(
      /process\.exit/,
    );
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('rejects when fingerprint not in file', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const exit = mockExit();
    await expect(runAllowlistShow(tmp, { fingerprint: '0000000000000000' })).rejects.toThrow(
      /process\.exit/,
    );
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('prints JSON detail when --json + entry exists', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistShow(tmp, { fingerprint: 'a3f9c0e8b7d2e1f4', json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.fingerprint).toBe('a3f9c0e8b7d2e1f4');
    expect(parsed.kind).toBe('dep-vuln');
    stdoutSpy.mockRestore();
  });

  it('prints text detail for existing entry', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    await expect(
      runAllowlistShow(tmp, { fingerprint: 'a3f9c0e8b7d2e1f4', json: false }),
    ).resolves.toBeUndefined();
  });
});

describe('saveAllowlist side-effect', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('writes .dxkit/allowlist.json with canonical filename', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    expect(fs.existsSync(pathForAllowlist(tmp))).toBe(true);
  });
});

describe('runAllowlistAudit', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('no-file: emits empty JSON report on --json', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed).toEqual({ expired: [], soonToExpire: [], missingRationale: [] });
    stdoutSpy.mockRestore();
  });

  it('no-file: prints info message in text mode', async () => {
    await expect(runAllowlistAudit(tmp, { json: false })).resolves.toBeUndefined();
  });

  it('finds soon-to-expire entries within the default 14-day window', async () => {
    // Add an entry that expires tomorrow
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'r',
      addedBy: 'a@b.c',
      expires: tomorrow,
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.soonToExpire).toHaveLength(1);
    expect(parsed.soonToExpire[0].entry.fingerprint).toBe('a3f9c0e8b7d2e1f4');
    stdoutSpy.mockRestore();
  });

  it('respects --soon-days parameter for window', async () => {
    // Entry expiring in 30 days
    const farOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'r',
      addedBy: 'a@b.c',
      expires: farOut,
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true, soonToExpireDays: 45 });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.soonToExpire).toHaveLength(1);
    stdoutSpy.mockRestore();
  });

  it('prints text report when entries are healthy', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'a3f9c0e8b7d2e1f4',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    await expect(runAllowlistAudit(tmp, { json: false })).resolves.toBeUndefined();
  });
});

describe('runAllowlistPrune', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('no-file: prints info and returns', async () => {
    await expect(runAllowlistPrune(tmp, {})).resolves.toBeUndefined();
  });

  it('removes expired entries by default', async () => {
    // Add an active entry
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'still good',
      addedBy: 'a@b.c',
    });
    // Manually inject an expired entry by editing the file directly via the
    // canonical IO helpers (mutate then save).
    const { loadAllowlist, saveAllowlist, addEntry } = await import('../../src/allowlist/file');
    const file = loadAllowlist(tmp)!;
    const expired: AllowlistFile = addEntry(file, {
      fingerprint: 'aaaa111111111111',
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'expired entry',
      addedBy: 'a@b.c',
      addedAt: '2020-01-01',
      expiresAt: '2020-01-02',
    });
    saveAllowlist(tmp, expired);

    await runAllowlistPrune(tmp, {});

    const after = loadAllowlist(tmp)!;
    expect(after.entries.map((e) => e.fingerprint)).toEqual(['bbbb111111111111']);
  });

  it('--dry-run does not write but prints what would change', async () => {
    const { loadAllowlist, saveAllowlist, addEntry } = await import('../../src/allowlist/file');
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const file = loadAllowlist(tmp)!;
    saveAllowlist(
      tmp,
      addEntry(file, {
        fingerprint: 'aaaa111111111111',
        kind: 'dep-vuln',
        category: 'accepted-risk',
        reason: 'expired',
        addedBy: 'a@b.c',
        addedAt: '2020-01-01',
        expiresAt: '2020-01-02',
      }),
    );

    await runAllowlistPrune(tmp, { dryRun: true });

    const after = loadAllowlist(tmp)!;
    // Both entries still present after dry-run
    expect(after.entries).toHaveLength(2);
  });

  it('--json emits structured envelope', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistPrune(tmp, { json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed).toMatchObject({
      dryRun: false,
      removed: [],
      keptCount: 1,
    });
    stdoutSpy.mockRestore();
  });

  it('no-op when allowlist has no expired entries', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    await expect(runAllowlistPrune(tmp, {})).resolves.toBeUndefined();
  });
});

describe('runAllowlistRemove', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('removes an existing entry by fingerprint', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    await runAllowlistRemove(tmp, { fingerprint: 'bbbb111111111111' });
    const after = loadAllowlist(tmp);
    expect(after?.entries ?? []).toHaveLength(0);
  });

  it('fails when fingerprint is missing from the allowlist', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const exitSpy = mockExit();
    await expect(runAllowlistRemove(tmp, { fingerprint: 'cccc222222222222' })).rejects.toThrow(
      /process\.exit\(1\)/,
    );
    // Original entry untouched
    expect(loadAllowlist(tmp)?.entries).toHaveLength(1);
    exitSpy.mockRestore();
  });

  it('fails with no positional fingerprint', async () => {
    const exitSpy = mockExit();
    await expect(runAllowlistRemove(tmp, {})).rejects.toThrow(/process\.exit\(1\)/);
    exitSpy.mockRestore();
  });

  it('--json emits the removed entry', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'bbbb111111111111',
      kind: 'dep-vuln',
      category: 'mitigated-externally',
      reason: 'r',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistRemove(tmp, { fingerprint: 'bbbb111111111111', json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.removed.fingerprint).toBe('bbbb111111111111');
    stdoutSpy.mockRestore();
  });
});

describe('runAllowlistAudit --against-baseline (orphaned bucket)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  async function writeBaseline(
    ids: ReadonlyArray<{ id: string; absorbed?: readonly string[] }>,
  ): Promise<void> {
    const { writeBaselineFile, pathForBaseline, BASELINE_SCHEMA_VERSION, DEFAULT_BASELINE_NAME } =
      await import('../../src/baseline/baseline-file');
    writeBaselineFile(pathForBaseline(tmp, DEFAULT_BASELINE_NAME), {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      name: DEFAULT_BASELINE_NAME,
      createdAt: '2026-06-09T00:00:00.000Z',
      repo: { commitSha: 'a'.repeat(40), branch: 'main', root: '/repo' },
      analysis: {
        dxkitVersion: '2.9.2',
        policyHash: 'p'.repeat(16),
        ignoreHash: 'i'.repeat(16),
        toolchainHash: 't'.repeat(16),
        configHash: 'c'.repeat(16),
      },
      tools: { semgrep: '1.161.0' },
      saltMode: 'deterministic',
      findings: ids.map((e) => ({
        id: e.id,
        kind: 'code' as const,
        tool: 'semgrep',
        rule: 'r',
        file: 'f.ts',
        line: 1,
        ...(e.absorbed ? { absorbedFingerprints: e.absorbed } : {}),
      })),
    });
  }

  it('flags an entry whose fingerprint is absent from the baseline', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'aaaa111111111111',
      kind: 'code',
      category: 'false-positive',
      reason: 'fp',
      addedBy: 'a@b.c',
    });
    await writeBaseline([{ id: 'dddd999999999999' }]); // different fp

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true, againstBaseline: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.orphaned).toHaveLength(1);
    expect(parsed.orphaned[0].fingerprint).toBe('aaaa111111111111');
    stdoutSpy.mockRestore();
  });

  it('does NOT flag an entry matched only via absorbedFingerprints', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'aaaa111111111111',
      kind: 'code',
      category: 'false-positive',
      reason: 'fp',
      addedBy: 'a@b.c',
    });
    // The entry's fp is a collapsed contributor of a current finding.
    await writeBaseline([{ id: 'dddd999999999999', absorbed: ['aaaa111111111111'] }]);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true, againstBaseline: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.orphaned).toHaveLength(0);
    stdoutSpy.mockRestore();
  });

  it('omits the orphaned bucket entirely without --against-baseline', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'aaaa111111111111',
      kind: 'code',
      category: 'false-positive',
      reason: 'fp',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.orphaned).toBeUndefined();
    stdoutSpy.mockRestore();
  });

  it('warns and skips orphan detection when no baseline exists', async () => {
    await runAllowlistAdd(tmp, {
      fingerprint: 'aaaa111111111111',
      kind: 'code',
      category: 'false-positive',
      reason: 'fp',
      addedBy: 'a@b.c',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAllowlistAudit(tmp, { json: true, againstBaseline: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(''));
    // No baseline → no orphaned bucket computed.
    expect(parsed.orphaned).toBeUndefined();
    stdoutSpy.mockRestore();
  });
});
