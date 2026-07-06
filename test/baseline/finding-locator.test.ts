/**
 * `describeEntryLocation` — the kind-aware location descriptor for finding
 * tables. Regression guard for the `Location: —` class (feedback #17): a
 * dep-vuln has no file:line, so it must render its own identity
 * (`package@version · advisory-id`) instead of a bare dash. Located kinds keep
 * `file:line`. Computed once at classification time so no renderer re-derives it.
 */
import { describe, it, expect } from 'vitest';
import { describeEntryLocation } from '../../src/baseline/check';
import type { BaselineEntry } from '../../src/baseline/types';

describe('describeEntryLocation', () => {
  it('dep-vuln → package@version · advisory-id (the fix for Location: —)', () => {
    const entry = {
      kind: 'dep-vuln',
      fingerprint: 'abcd000000000000',
      package: 'dompurify',
      installedVersion: '3.2.7',
      id: 'GHSA-76mc-f452-cxcm',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('dompurify@3.2.7 · GHSA-76mc-f452-cxcm');
  });

  it('dep-vuln with no installed version → package · advisory-id', () => {
    const entry = {
      kind: 'dep-vuln',
      fingerprint: 'abcd000000000000',
      package: 'uuid',
      installedVersion: undefined,
      id: 'GHSA-w5hq-g745-h8pq',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('uuid · GHSA-w5hq-g745-h8pq');
  });

  it('located kinds still render file:line', () => {
    const code = {
      kind: 'code',
      fingerprint: 'c0de000000000000',
      tool: 'semgrep',
      rule: 'x',
      file: 'src/a.ts',
      line: 42,
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(code)).toBe('src/a.ts:42');
  });

  it('a located kind with no positive line renders just the file', () => {
    const cov = {
      kind: 'coverage-gap',
      fingerprint: 'c0v0000000000000',
      file: 'src/b.ts',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(cov)).toBe('src/b.ts');
  });

  it('a genuinely location-less kind (secret-hmac) → empty descriptor', () => {
    const hmac = {
      kind: 'secret-hmac',
      fingerprint: 'deadbeef00000000',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(hmac)).toBe('');
  });
});
