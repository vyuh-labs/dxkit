import { describe, it, expect } from 'vitest';
import {
  annotateFindingsWithAllowlist,
  annotateDepFindingsWithAllowlist,
  summarizeAllowlist,
  renderAllowlistSuffix,
  type CategorizedFinding,
  type AnnotatableFinding,
} from '../../src/allowlist/annotate';
import type { AllowlistFile, AllowlistEntry } from '../../src/allowlist/file';

/**
 * Unit coverage: report findings gain `allowlisted` +
 * `allowlistCategory` when (and only when) an ACTIVE allowlist entry
 * matches their fingerprint AND kind. Raw fields are untouched — the
 * annotation is purely additive (the renderer reads it to disclose
 * "(N allowlisted)" without changing counts). Covers code-side
 * (category-driven) AND dependency (kind `dep-vuln`) findings.
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

describe('annotateFindingsWithAllowlist (code-side)', () => {
  it('marks a finding whose fingerprint + kind match an active entry', () => {
    const findings: CategorizedFinding[] = [{ category: 'secret', fingerprint: FP }];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(1);
    expect(findings[0].allowlisted).toBe(true);
    expect(findings[0].allowlistCategory).toBe('test-fixture');
  });

  it('does NOT mark when the kind differs (guards against hash collision)', () => {
    const findings: CategorizedFinding[] = [{ category: 'code', fingerprint: FP }];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('does NOT mark when the entry has expired', () => {
    const findings: CategorizedFinding[] = [{ category: 'secret', fingerprint: FP }];
    const expired = secretEntry({ category: 'accepted-risk', expiresAt: '2026-06-01' });
    const count = annotateFindingsWithAllowlist(findings, fileWith(expired), NOW);
    expect(count).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('matches via an absorbed fingerprint (cross-tool dedup robustness)', () => {
    const findings: CategorizedFinding[] = [
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

  it('is a no-op on a null or empty allowlist', () => {
    const findings: CategorizedFinding[] = [{ category: 'secret', fingerprint: FP }];
    expect(annotateFindingsWithAllowlist(findings, null, NOW)).toBe(0);
    expect(annotateFindingsWithAllowlist(findings, fileWith(), NOW)).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });

  it('leaves non-matching findings untouched while marking matches in a mixed batch', () => {
    const findings: CategorizedFinding[] = [
      { category: 'secret', fingerprint: FP }, // matches
      { category: 'secret', fingerprint: 'deadbeefdeadbeef' }, // no entry
      { category: 'code', fingerprint: 'cafecafecafecafe' }, // no entry
    ];
    const count = annotateFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(1);
    expect(findings.map((f) => !!f.allowlisted)).toEqual([true, false, false]);
  });
});

describe('annotateDepFindingsWithAllowlist (dependency)', () => {
  it('marks a dep finding whose stamped fingerprint matches an active dep-vuln entry', () => {
    const findings: AnnotatableFinding[] = [{ fingerprint: FP }];
    const entry = secretEntry({ kind: 'dep-vuln', category: 'false-positive' });
    const count = annotateDepFindingsWithAllowlist(findings, fileWith(entry), NOW);
    expect(count).toBe(1);
    expect(findings[0].allowlisted).toBe(true);
    expect(findings[0].allowlistCategory).toBe('false-positive');
  });

  it('does NOT mark a dep finding against a non-dep-vuln entry (kind guard)', () => {
    const findings: AnnotatableFinding[] = [{ fingerprint: FP }];
    // Same fingerprint, but the entry is a secret — must not waive the dep-vuln.
    const count = annotateDepFindingsWithAllowlist(findings, fileWith(secretEntry()), NOW);
    expect(count).toBe(0);
    expect(findings[0].allowlisted).toBeUndefined();
  });
});

describe('summarizeAllowlist + renderAllowlistSuffix', () => {
  it('splits live vs allowlisted and breaks the allowlisted count down by category', () => {
    const findings: AnnotatableFinding[] = [
      { fingerprint: '1', allowlisted: true, allowlistCategory: 'test-fixture' },
      { fingerprint: '2', allowlisted: true, allowlistCategory: 'test-fixture' },
      { fingerprint: '3', allowlisted: true, allowlistCategory: 'accepted-risk' },
      { fingerprint: '4' }, // live
    ];
    const split = summarizeAllowlist(findings);
    expect(split.live).toBe(1);
    expect(split.allowlisted).toBe(3);
    expect(split.byCategory).toEqual({ 'test-fixture': 2, 'accepted-risk': 1 });
  });

  it('renders a compact suffix, or empty when nothing is allowlisted', () => {
    const none = summarizeAllowlist([{ fingerprint: '1' }]);
    expect(renderAllowlistSuffix(none)).toBe('');
    const some = summarizeAllowlist([
      { fingerprint: '1', allowlisted: true, allowlistCategory: 'test-fixture' },
    ]);
    expect(renderAllowlistSuffix(some)).toContain('1 allowlisted');
    expect(renderAllowlistSuffix(some)).toContain('test-fixture');
  });
});
