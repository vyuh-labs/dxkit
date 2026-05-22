import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ALLOWLIST_REASONS_SCHEMA_VERSION,
  ALLOWLIST_SCHEMA_VERSION,
  addEntry,
  emptyAllowlistFile,
  findEntry,
  isEntryActive,
  loadAllowlist,
  loadAllowlistReasons,
  matchesFinding,
  pathForAllowlist,
  pathForAllowlistReasons,
  removeEntry,
  saveAllowlist,
  validateAllowlistEntry,
  validateAllowlistFile,
  type AllowlistEntry,
  type AllowlistFile,
  type AllowlistReasonsSidecar,
} from '../../src/allowlist/file';

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-allowlist-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const baseEntry: AllowlistEntry = {
  fingerprint: 'a3f9c0e8b7d2e1f4',
  kind: 'secret',
  category: 'test-fixture',
  reason: 'placeholder in unit test',
  addedBy: 'alice@example.com',
  addedAt: '2026-05-22',
};

describe('allowlist file IO', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  it('loadAllowlist returns null when file missing', () => {
    expect(loadAllowlist(tmp)).toBeNull();
  });

  it('emptyAllowlistFile creates valid empty file', () => {
    const f = emptyAllowlistFile();
    expect(f.schemaVersion).toBe(ALLOWLIST_SCHEMA_VERSION);
    expect(f.mode).toBe('full');
    expect(f.entries).toEqual([]);
    expect(validateAllowlistFile(f)).toHaveLength(0);
  });

  it('saveAllowlist + loadAllowlist round-trip in full mode', () => {
    const original: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries: [baseEntry],
    };
    saveAllowlist(tmp, original);

    const filePath = pathForAllowlist(tmp);
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = loadAllowlist(tmp);
    expect(loaded).toEqual(original);
  });

  it('saveAllowlist in sanitized mode strips reason+addedBy to sidecar', () => {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'sanitized',
      entries: [baseEntry],
    };
    saveAllowlist(tmp, file);

    // Main file omits reason + addedBy
    const rawMain = JSON.parse(fs.readFileSync(pathForAllowlist(tmp), 'utf8'));
    expect(rawMain.entries[0].reason).toBeUndefined();
    expect(rawMain.entries[0].addedBy).toBeUndefined();
    expect(rawMain.entries[0].fingerprint).toBe(baseEntry.fingerprint);
    expect(rawMain.entries[0].category).toBe(baseEntry.category);

    // Sidecar carries reason + addedBy keyed by fingerprint
    const sidecar = loadAllowlistReasons(tmp);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.reasons[baseEntry.fingerprint]).toEqual({
      reason: baseEntry.reason,
      addedBy: baseEntry.addedBy,
    });
  });

  it('loadAllowlist merges sidecar back in sanitized mode', () => {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'sanitized',
      entries: [baseEntry],
    };
    saveAllowlist(tmp, file);

    const loaded = loadAllowlist(tmp);
    expect(loaded!.entries[0].reason).toBe(baseEntry.reason);
    expect(loaded!.entries[0].addedBy).toBe(baseEntry.addedBy);
  });

  it('loadAllowlist tolerates missing sidecar in sanitized mode', () => {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'sanitized',
      entries: [baseEntry],
    };
    saveAllowlist(tmp, file);
    // Remove the sidecar — simulate fresh clone in CI
    fs.unlinkSync(pathForAllowlistReasons(tmp));

    const loaded = loadAllowlist(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries[0].reason).toBeUndefined();
    expect(loaded!.entries[0].fingerprint).toBe(baseEntry.fingerprint);
  });

  it('loadAllowlist throws on malformed JSON', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(pathForAllowlist(tmp), '{ not json', 'utf8');
    expect(() => loadAllowlist(tmp)).toThrow(/not valid JSON/);
  });

  it('loadAllowlist throws on missing schemaVersion', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(pathForAllowlist(tmp), JSON.stringify({ mode: 'full', entries: [] }), 'utf8');
    expect(() => loadAllowlist(tmp)).toThrow(/schemaVersion/);
  });

  it('loadAllowlist throws on unknown mode', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      pathForAllowlist(tmp),
      JSON.stringify({
        schemaVersion: ALLOWLIST_SCHEMA_VERSION,
        mode: 'unknown-mode',
        entries: [],
      }),
      'utf8',
    );
    expect(() => loadAllowlist(tmp)).toThrow(/mode/);
  });

  it('loadAllowlist throws on non-array entries', () => {
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      pathForAllowlist(tmp),
      JSON.stringify({
        schemaVersion: ALLOWLIST_SCHEMA_VERSION,
        mode: 'full',
        entries: 'oops',
      }),
      'utf8',
    );
    expect(() => loadAllowlist(tmp)).toThrow(/entries/);
  });

  it('saveAllowlist throws on invalid file', () => {
    const bad: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries: [{ ...baseEntry, reason: '' }],
    };
    expect(() => saveAllowlist(tmp, bad)).toThrow(/failed validation/);
    // File should NOT have been written
    expect(fs.existsSync(pathForAllowlist(tmp))).toBe(false);
  });

  describe('reasons sidecar IO', () => {
    it('loadAllowlistReasons returns null when missing', () => {
      expect(loadAllowlistReasons(tmp)).toBeNull();
    });

    it('throws on bad sidecar schemaVersion', () => {
      fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
      fs.writeFileSync(
        pathForAllowlistReasons(tmp),
        JSON.stringify({ schemaVersion: 'wrong', reasons: {} }),
        'utf8',
      );
      expect(() => loadAllowlistReasons(tmp)).toThrow(/schemaVersion/);
    });

    it('accepts valid sidecar', () => {
      fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
      const sidecar: AllowlistReasonsSidecar = {
        schemaVersion: ALLOWLIST_REASONS_SCHEMA_VERSION,
        reasons: { abc123def4567890: { reason: 'because', addedBy: 'me' } },
      };
      fs.writeFileSync(pathForAllowlistReasons(tmp), JSON.stringify(sidecar), 'utf8');
      expect(loadAllowlistReasons(tmp)).toEqual(sidecar);
    });
  });
});

describe('entry helpers', () => {
  const file: AllowlistFile = {
    schemaVersion: ALLOWLIST_SCHEMA_VERSION,
    mode: 'full',
    entries: [baseEntry],
  };

  it('findEntry locates by fingerprint', () => {
    expect(findEntry(file, baseEntry.fingerprint)).toEqual(baseEntry);
    expect(findEntry(file, 'nonexistent00000')).toBeUndefined();
  });

  it('matchesFinding is fingerprint-only', () => {
    expect(matchesFinding(file, baseEntry.fingerprint)).toBe(true);
    expect(matchesFinding(file, 'nonexistent00000')).toBe(false);
  });

  it('addEntry returns new file with appended entry', () => {
    const second: AllowlistEntry = {
      ...baseEntry,
      fingerprint: 'b2e4d8a1c9f0a3b5',
    };
    const updated = addEntry(file, second);
    expect(updated.entries).toHaveLength(2);
    expect(updated.entries).not.toBe(file.entries); // immutable
    expect(file.entries).toHaveLength(1); // original untouched
  });

  it('addEntry throws on duplicate fingerprint', () => {
    expect(() => addEntry(file, baseEntry)).toThrow(/already contains/);
  });

  it('removeEntry returns new file without entry', () => {
    const updated = removeEntry(file, baseEntry.fingerprint);
    expect(updated.entries).toHaveLength(0);
    expect(file.entries).toHaveLength(1);
  });

  it('removeEntry is no-op for missing fingerprint', () => {
    const updated = removeEntry(file, 'nonexistent00000');
    expect(updated.entries).toHaveLength(1);
  });
});

describe('isEntryActive', () => {
  const fixedNow = new Date('2026-05-22T00:00:00Z');

  it('returns true for entries without expiresAt', () => {
    expect(isEntryActive(baseEntry, fixedNow)).toBe(true);
  });

  it('returns true for entries with future expiresAt', () => {
    expect(isEntryActive({ ...baseEntry, expiresAt: '2026-08-22' }, fixedNow)).toBe(true);
  });

  it('returns true on the day of expiry (boundary)', () => {
    expect(isEntryActive({ ...baseEntry, expiresAt: '2026-05-22' }, fixedNow)).toBe(true);
  });

  it('returns false after expiry', () => {
    expect(isEntryActive({ ...baseEntry, expiresAt: '2026-05-21' }, fixedNow)).toBe(false);
  });
});

describe('validateAllowlistEntry', () => {
  it('zero errors for a well-formed entry', () => {
    expect(validateAllowlistEntry(baseEntry, 'full')).toEqual([]);
  });

  it('flags non-hex fingerprint', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, fingerprint: 'NOT_HEX_AT_ALL!' }, 'full');
    expect(errors.some((e) => e.field === 'fingerprint')).toBe(true);
  });

  it('flags wrong-length fingerprint', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, fingerprint: 'abc' }, 'full');
    expect(errors.some((e) => e.field === 'fingerprint')).toBe(true);
  });

  it('flags uppercase fingerprint', () => {
    const errors = validateAllowlistEntry(
      { ...baseEntry, fingerprint: 'A3F9C0E8B7D2E1F4' },
      'full',
    );
    expect(errors.some((e) => e.field === 'fingerprint')).toBe(true);
  });

  it('flags invalid category', () => {
    const bad = { ...baseEntry, category: 'invented' as unknown as typeof baseEntry.category };
    const errors = validateAllowlistEntry(bad, 'full');
    expect(errors.some((e) => e.field === 'category')).toBe(true);
  });

  it('flags category not applicable to kind', () => {
    // hygiene only allows accepted-risk + deferred
    const bad: AllowlistEntry = {
      ...baseEntry,
      kind: 'hygiene',
      category: 'test-fixture',
    };
    const errors = validateAllowlistEntry(bad, 'full');
    expect(errors.some((e) => e.field === 'category' && /does not apply/.test(e.message))).toBe(
      true,
    );
  });

  it('requires reason in full mode', () => {
    const noReason = { ...baseEntry, reason: undefined } as unknown as AllowlistEntry;
    const errors = validateAllowlistEntry(noReason, 'full');
    expect(errors.some((e) => e.field === 'reason')).toBe(true);
  });

  it('rejects empty/whitespace reason in full mode', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, reason: '   ' }, 'full');
    expect(errors.some((e) => e.field === 'reason')).toBe(true);
  });

  it('allows missing reason in sanitized mode (sidecar owns it)', () => {
    const noReason = { ...baseEntry, reason: undefined, addedBy: undefined };
    const errors = validateAllowlistEntry(noReason, 'sanitized');
    expect(errors.filter((e) => e.field === 'reason' || e.field === 'addedBy')).toHaveLength(0);
  });

  it('requires addedAt in ISO format', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, addedAt: 'last Tuesday' }, 'full');
    expect(errors.some((e) => e.field === 'addedAt')).toBe(true);
  });

  it('requires expiresAt for accepted-risk', () => {
    const noExpiry: AllowlistEntry = {
      ...baseEntry,
      kind: 'dep-vuln',
      category: 'accepted-risk',
    };
    const errors = validateAllowlistEntry(noExpiry, 'full');
    expect(errors.some((e) => e.field === 'expiresAt')).toBe(true);
  });

  it('requires expiresAt for deferred', () => {
    const noExpiry: AllowlistEntry = {
      ...baseEntry,
      kind: 'dep-vuln',
      category: 'deferred',
    };
    const errors = validateAllowlistEntry(noExpiry, 'full');
    expect(errors.some((e) => e.field === 'expiresAt')).toBe(true);
  });

  it('expiresAt optional for test-fixture', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, category: 'test-fixture' }, 'full');
    expect(errors.filter((e) => e.field === 'expiresAt')).toHaveLength(0);
  });

  it('rejects malformed expiresAt', () => {
    const errors = validateAllowlistEntry({ ...baseEntry, expiresAt: '08/22/2026' }, 'full');
    expect(errors.some((e) => e.field === 'expiresAt')).toBe(true);
  });

  it('accepts well-formed accepted-risk with expiresAt + acknowledgedSeverity', () => {
    const accepted: AllowlistEntry = {
      ...baseEntry,
      kind: 'dep-vuln',
      category: 'accepted-risk',
      expiresAt: '2026-08-22',
      acknowledgedSeverity: 'high',
    };
    expect(validateAllowlistEntry(accepted, 'full')).toEqual([]);
  });
});

describe('validateAllowlistFile', () => {
  it('detects duplicate fingerprints across entries', () => {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries: [baseEntry, baseEntry],
    };
    const errors = validateAllowlistFile(file);
    expect(errors.some((e) => e.field === 'fingerprint' && /duplicate/.test(e.message))).toBe(true);
  });

  it('flags bad schemaVersion', () => {
    const file: AllowlistFile = {
      schemaVersion: 'dxkit-allowlist/v0' as 'dxkit-allowlist/v1',
      mode: 'full',
      entries: [],
    };
    const errors = validateAllowlistFile(file);
    expect(errors.some((e) => e.field === 'schemaVersion')).toBe(true);
  });

  it('accepts a well-formed full-mode file', () => {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries: [baseEntry],
    };
    expect(validateAllowlistFile(file)).toEqual([]);
  });
});
