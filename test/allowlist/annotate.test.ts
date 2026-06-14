import { describe, it, expect } from 'vitest';
import {
  annotateFindingsWithAllowlist,
  type AnnotatableFinding,
} from '../../src/allowlist/annotate';
import type { AllowlistFile, AllowlistEntry } from '../../src/allowlist/file';

/**
 * Unit coverage: report findings gain `allowlisted` +
 * `allowlistCategory` when (and only when) an ACTIVE allowlist entry
 * matches their fingerprint AND kind. Raw fields are untouched — the
 * annotation is purely additive (the renderer reads it to disclose
 * "(N allowlisted)" without changing counts).
 */

const FP = 'abcd1234abcd1234';
const NOW = new Date('2026-06-12T12:00:00Z');

function fileWith(...entries: AllowlistEntry[]): AllowlistFile {
  return { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries };
}

function secretEntry(over: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    fingerprint: FP,
    kind: 'secret',
    category: 'test-fixture',
    reason: 'unit-test fixture password',
    addedBy: 'r@example.com',
    addedAt: '2026-06-01',
    ...over,
  };
}

describe('annotateFindingsWithAllowlist', () => {
  it('marks a finding whose fingerprint + kind match an active entry', () => {
    const findings: AnnotatableFinding[] = [{ category: 'secret', fingerprint: FP }];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(1);
    expect(findings[0].allowlisted).toBe(true);
    expect(findings[0].allowlistCategory).toBe('test-fixture');
  });

  it('does NOT mark when the kind differs (guards against hash collision)', () => {
    const findings: AnnotatableFinding[] = [{ category: 'code', fingerprint: FP }];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('does NOT mark when the entry has expired', () => {
    const findings: AnnotatableFinding[] = [{ category: 'secret', fingerprint: FP }];
    const expired = secretEntry({ category: 'accepted-risk', expiresAt: '2026-06-01' });
    const count = annotateFindingsWithAllowlist(findings, fileWith(expired), NOW);
    expect(count).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('matches via an absorbed fingerprint (cross-tool dedup robustness)', () => {
    const findings: AnnotatableFinding[] = [
      { category: 'code', fingerprint: 'ffff0000ffff0000', absorbedFingerprints: [FP] },
    ];
    const count = annotateFindingsWithAllowlist(
      findings,
      fileWith(secretEntry({ kind: 'code' })),
      NOW,
    );
    expect(count).toBe(1);
    expect(findings[0].allowlisted).toBe(true);
  });

  it('ignores dependency findings (no inline fingerprint — out of scope)', () => {
    const findings: AnnotatableFinding[] = [{ category: 'dependency' }];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(0);
  });

  it('is a no-op on a null or empty allowlist', () => {
    const findings: AnnotatableFinding[] = [{ category: 'secret', fingerprint: FP }];
    expect(annotateFindingsWithAllowlist(findings, null, NOW)).toBe(0);
    expect(annotateFindingsWithAllowlist(findings, fileWith(), NOW)).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('leaves non-matching findings untouched while marking matches in a mixed batch', () => {
    const findings: AnnotatableFinding[] = [
      { category: 'secret', fingerprint: FP }, // matches
      { category: 'secret', fingerprint: 'deadbeefdeadbeef' }, // no entry
      { category: 'code', fingerprint: 'cafecafecafecafe' }, // no entry
    ];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(1);
    expect(findings.map((f) => !!f.allowlisted)).toEqual([true, false, false]);
  });
});
