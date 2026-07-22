/**
 * `describeEntryLocation` — the kind-aware location descriptor for finding
 * tables. Regression guard for the `Location: —` class (feedback #17): a
 * dep-vuln has no file:line, so it must render its own identity
 * (`package@version · advisory-id`) instead of a bare dash. Located kinds keep
 * `file:line`. Computed once at classification time so no renderer re-derives it.
 */
import { describe, it, expect } from 'vitest';
import { applyCustomCheckIntent, describeEntryLocation } from '../../src/baseline/check';
import type { BaselineEntry } from '../../src/baseline/types';
import type { ClassifyResult } from '../../src/baseline/classify';

describe('describeEntryLocation', () => {
  it('dep-vuln → package@version · ADVISORY id, never the fingerprint (D4c)', () => {
    // On a real BaselineEntry `id` is the FINDING fingerprint — the naming
    // collision that shipped ten same-package rows repeating the Fingerprint
    // column and reading as duplicates with contradictory severities. The
    // locator must show `advisoryId`.
    const entry = {
      kind: 'dep-vuln',
      id: 'abcd000000000000',
      package: 'dompurify',
      installedVersion: '3.2.7',
      advisoryId: 'GHSA-76mc-f452-cxcm',
    } as unknown as BaselineEntry;
    const loc = describeEntryLocation(entry);
    expect(loc).toBe('dompurify@3.2.7 · GHSA-76mc-f452-cxcm');
    expect(loc).not.toContain('abcd000000000000');
  });

  it('dep-vuln with no installed version → package · advisory-id', () => {
    const entry = {
      kind: 'dep-vuln',
      id: 'abcd000000000000',
      package: 'uuid',
      installedVersion: undefined,
      advisoryId: 'GHSA-w5hq-g745-h8pq',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('uuid · GHSA-w5hq-g745-h8pq');
  });

  it('dep-vuln from a pre-advisoryId baseline falls back to the entry id', () => {
    const entry = {
      kind: 'dep-vuln',
      id: 'abcd000000000000',
      package: 'axios',
      installedVersion: '1.16.1',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('axios@1.16.1 · abcd000000000000');
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

  it('custom-check located → check/rule · file:line', () => {
    const entry = {
      kind: 'custom-check',
      check: 'lint:typescript',
      blocking: true,
      file: 'src/a.ts',
      line: 42,
      rule: 'no-unused-vars',
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('lint:typescript/no-unused-vars · src/a.ts:42');
  });

  it('custom-check binary (no file) → the check name, never a bare "custom-check"', () => {
    const entry = {
      kind: 'custom-check',
      check: 'check:seam',
      blocking: true,
    } as unknown as BaselineEntry;
    expect(describeEntryLocation(entry)).toBe('check:seam');
  });
});

describe('applyCustomCheckIntent', () => {
  const blocked: ClassifyResult = {
    status: 'added',
    blocks: true,
    warns: false,
    reasons: [],
  };

  it('demotes a net-new BLOCKING-list finding from a non-blocking check to a warn', () => {
    const entry = {
      kind: 'custom-check',
      check: 'lint:typescript',
      blocking: false,
    } as unknown as BaselineEntry;
    const out = applyCustomCheckIntent(entry, blocked);
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(true);
    expect(out.reasons.some((r) => r.code === 'non-blocking-check')).toBe(true);
  });

  it('leaves a blocking custom-check untouched', () => {
    const entry = {
      kind: 'custom-check',
      check: 'check:seam',
      blocking: true,
    } as unknown as BaselineEntry;
    expect(applyCustomCheckIntent(entry, blocked)).toBe(blocked);
  });

  it('is a no-op for non-custom-check kinds', () => {
    const secret = { kind: 'secret' } as unknown as BaselineEntry;
    expect(applyCustomCheckIntent(secret, blocked)).toBe(blocked);
  });

  it('is a no-op when the classification already does not block', () => {
    const entry = {
      kind: 'custom-check',
      check: 'x',
      blocking: false,
    } as unknown as BaselineEntry;
    const warnOnly: ClassifyResult = { status: 'added', blocks: false, warns: true, reasons: [] };
    expect(applyCustomCheckIntent(entry, warnOnly)).toBe(warnOnly);
  });
});
