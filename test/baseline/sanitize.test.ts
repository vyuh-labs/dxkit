import { describe, it, expect } from 'vitest';
import { isSanitized, sanitizeEntry, sanitizeFile } from '../../src/baseline/sanitize';
import { BASELINE_SCHEMA_VERSION, DEFAULT_BASELINE_NAME } from '../../src/baseline/baseline-file';
import type { BaselineFile } from '../../src/baseline/baseline-file';
import type { BaselineEntry, SanitizedBaselineEntry } from '../../src/baseline/types';

/**
 * Centralized per-kind builders. Each fixture carries the rich
 * (unsanitized) shape — every test relies on these to assert "the
 * sanitization pass dropped X" by listing the original payload
 * fields and checking absence after sanitization.
 */
const RICH_ENTRIES: ReadonlyArray<BaselineEntry> = [
  {
    id: 'a1a1a1a1a1a1a1a1',
    kind: 'secret',
    tool: 'gitleaks',
    rule: 'aws-access-key',
    file: 'src/config/secrets.ts',
    line: 42,
    contentHash: 'deadbeefcafebabe',
  },
  {
    id: 'b2b2b2b2b2b2b2b2',
    kind: 'code',
    tool: 'semgrep',
    rule: 'eval-use',
    file: 'src/handlers/exec.ts',
    line: 17,
  },
  {
    id: 'c3c3c3c3c3c3c3c3',
    kind: 'config',
    tool: 'semgrep',
    rule: 'tls-bypass',
    file: 'config/app.ts',
    line: 8,
  },
  {
    id: 'd4d4d4d4d4d4d4d4',
    kind: 'dep-vuln',
    package: '@internal/customer-database',
    installedVersion: '1.2.3',
    advisoryId: 'GHSA-xxxx-yyyy-zzzz',
  },
  {
    id: 'e5e5e5e5e5e5e5e5',
    kind: 'duplication',
    fileA: 'src/legacy/a.ts',
    fileB: 'src/legacy/b.ts',
    lines: 50,
    startLineA: 10,
    startLineB: 60,
  },
  {
    id: 'f6f6f6f6f6f6f6f6',
    kind: 'coverage-gap',
    file: 'src/billing/payments.ts',
    symbol: 'processRefund',
  },
  {
    id: '0707070707070707',
    kind: 'test-gap',
    file: 'src/api/auth.ts',
    risk: 'critical',
  },
  {
    id: '1818181818181818',
    kind: 'hygiene',
    file: 'src/util/temp.ts',
    line: 90,
    marker: 'todo',
  },
  {
    id: '2929292929292929',
    kind: 'test-file-degradation',
    file: 'test/api/users.test.ts',
    status: 'empty',
  },
  { id: '3a3a3a3a3a3a3a3a', kind: 'god-file', file: 'src/legacy/orders.ts' },
  {
    id: '4b4b4b4b4b4b4b4b',
    kind: 'stale-file',
    file: 'src/legacy/dump.bak',
    suffix: 'bak',
  },
  { id: '5c5c5c5c5c5c5c5c', kind: 'large-file', file: 'src/services/payments.ts' },
  {
    id: '6d6d6d6d6d6d6d6d',
    kind: 'secret-hmac',
    tool: 'gitleaks',
    rule: 'private-key',
    hmac: 'cafef00ddeadbeef',
  },
  {
    id: '7e7e7e7e7e7e7e7e',
    kind: 'stale-allow',
    file: 'src/auth/oauth.ts',
    line: 42,
    category: 'test-fixture',
  },
];

describe('isSanitized', () => {
  it('returns false for every rich entry shape', () => {
    for (const entry of RICH_ENTRIES) {
      expect(isSanitized(entry), `${entry.kind}`).toBe(false);
    }
  });

  it('returns true when the entry carries `sanitized: true`', () => {
    const entry: SanitizedBaselineEntry = {
      id: 'a1a1a1a1a1a1a1a1',
      kind: 'secret',
      sanitized: true,
    };
    expect(isSanitized(entry)).toBe(true);
  });
});

describe('sanitizeEntry', () => {
  it('preserves the fingerprint id for every kind', () => {
    for (const entry of RICH_ENTRIES) {
      expect(sanitizeEntry(entry).id, `${entry.kind}`).toBe(entry.id);
    }
  });

  it('preserves the kind discriminant for every kind', () => {
    for (const entry of RICH_ENTRIES) {
      expect(sanitizeEntry(entry).kind, `${entry.kind}`).toBe(entry.kind);
    }
  });

  it('stamps `sanitized: true` on every result', () => {
    for (const entry of RICH_ENTRIES) {
      const stripped = sanitizeEntry(entry);
      expect(stripped.sanitized, `${entry.kind}`).toBe(true);
    }
  });

  it('strips every non-id-non-kind field for every kind', () => {
    const allowedKeys = new Set(['id', 'kind', 'sanitized']);
    for (const entry of RICH_ENTRIES) {
      const stripped = sanitizeEntry(entry);
      const surplus = Object.keys(stripped).filter((k) => !allowedKeys.has(k));
      expect(surplus, `${entry.kind} leaked keys`).toEqual([]);
    }
  });

  it('does not leak human-readable secret-finding fields', () => {
    const secret = RICH_ENTRIES.find((e) => e.kind === 'secret');
    if (!secret || secret.kind !== 'secret') throw new Error('fixture');
    const stripped = sanitizeEntry(secret) as unknown as Record<string, unknown>;
    expect(stripped.file).toBeUndefined();
    expect(stripped.line).toBeUndefined();
    expect(stripped.tool).toBeUndefined();
    expect(stripped.rule).toBeUndefined();
    expect(stripped.contentHash).toBeUndefined();
  });

  it('does not leak private package names for dep-vuln findings', () => {
    const depVuln = RICH_ENTRIES.find((e) => e.kind === 'dep-vuln');
    if (!depVuln || depVuln.kind !== 'dep-vuln') throw new Error('fixture');
    const stripped = sanitizeEntry(depVuln) as unknown as Record<string, unknown>;
    expect(stripped.package).toBeUndefined();
    expect(stripped.installedVersion).toBeUndefined();
    expect(stripped.advisoryId).toBeUndefined();
  });

  it('is idempotent — sanitizing an already-sanitized entry returns it unchanged', () => {
    const stripped = sanitizeEntry(RICH_ENTRIES[0]);
    const again = sanitizeEntry(stripped);
    expect(again).toBe(stripped);
  });
});

describe('sanitizeFile', () => {
  function buildFile(findings: ReadonlyArray<BaselineEntry>): BaselineFile {
    return {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      name: DEFAULT_BASELINE_NAME,
      createdAt: '2026-05-22T12:00:00.000Z',
      repo: { commitSha: 'a'.repeat(40), branch: 'main', root: '/repo' },
      analysis: {
        dxkitVersion: '2.6.0',
        policyHash: 'p'.repeat(16),
        ignoreHash: 'i'.repeat(16),
        toolchainHash: 't'.repeat(16),
        configHash: 'c'.repeat(16),
      },
      tools: { gitleaks: '8.24.0', semgrep: '1.161.0' },
      saltMode: 'deterministic',
      findings,
    };
  }

  it('sanitizes every finding while preserving the envelope', () => {
    const file = buildFile(RICH_ENTRIES);
    const sanitized = sanitizeFile(file);
    expect(sanitized.schemaVersion).toBe(file.schemaVersion);
    expect(sanitized.name).toBe(file.name);
    expect(sanitized.createdAt).toBe(file.createdAt);
    expect(sanitized.repo).toBe(file.repo);
    expect(sanitized.analysis).toBe(file.analysis);
    expect(sanitized.tools).toBe(file.tools);
    expect(sanitized.saltMode).toBe(file.saltMode);
    expect(sanitized.findings).toHaveLength(file.findings.length);
    for (const entry of sanitized.findings) {
      expect(isSanitized(entry)).toBe(true);
    }
  });

  it('preserves fingerprints 1:1 with the input ordering', () => {
    const file = buildFile(RICH_ENTRIES);
    const sanitized = sanitizeFile(file);
    for (let i = 0; i < file.findings.length; i++) {
      expect(sanitized.findings[i].id).toBe(file.findings[i].id);
    }
  });

  it('does not mutate the input file', () => {
    const file = buildFile(RICH_ENTRIES);
    const originalFirstKeys = Object.keys(file.findings[0]).sort();
    sanitizeFile(file);
    expect(Object.keys(file.findings[0]).sort()).toEqual(originalFirstKeys);
  });

  it('is idempotent over the file shape', () => {
    const file = buildFile(RICH_ENTRIES);
    const once = sanitizeFile(file);
    const twice = sanitizeFile(once);
    expect(twice.findings).toEqual(once.findings);
  });
});
