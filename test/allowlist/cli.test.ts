import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAllowlistAdd, runAllowlistList, runAllowlistShow } from '../../src/allowlist/cli';
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
