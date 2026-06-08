import { describe, it, expect } from 'vitest';
import { allowlistSuppressionFor } from '../../src/baseline/check';
import type { AllowlistFile, AllowlistEntry } from '../../src/allowlist/file';
import type { BaselineEntry } from '../../src/baseline/types';
import type { IdentityKind } from '../../src/baseline/producers';

/**
 * Pure unit coverage for the allowlist → verdict suppression resolver.
 * The (expensive) integration test in `check.test.ts` proves the
 * wiring flips a real verdict; this file exercises the matching
 * branches — fingerprint match, kind guard, and the expiry window — at
 * zero analyzer cost.
 */

const FP = 'abcd1234abcd1234';

// The resolver only reads `id` + `kind` off the anchor entry, so a
// minimal stand-in is sufficient and keeps the fixtures readable.
function anchor(id: string, kind: IdentityKind): BaselineEntry {
  return { id, kind } as unknown as BaselineEntry;
}

function fileWith(entry: AllowlistEntry): AllowlistFile {
  return { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries: [entry] };
}

const NOW = new Date('2026-06-08T12:00:00Z');

describe('allowlistSuppressionFor', () => {
  it('suppresses on a fingerprint + kind match with a non-expiring category', () => {
    const file = fileWith({
      fingerprint: FP,
      kind: 'stale-file',
      category: 'false-positive',
      reason: 'reviewed',
      addedBy: 'r@example.com',
      addedAt: '2026-05-01',
    });
    const out = allowlistSuppressionFor(file, anchor(FP, 'stale-file'), NOW);
    expect(out).toEqual({ fingerprint: FP, category: 'false-positive' });
  });

  it('suppresses an accepted-risk entry inside its expiry window, carrying expiresAt', () => {
    const file = fileWith({
      fingerprint: FP,
      kind: 'code',
      category: 'accepted-risk',
      reason: 'sandboxed; tracked for hardening',
      addedBy: 'r@example.com',
      addedAt: '2026-05-01',
      expiresAt: '2026-09-01',
      acknowledgedSeverity: 'high',
    });
    const out = allowlistSuppressionFor(file, anchor(FP, 'code'), NOW);
    expect(out).toEqual({ fingerprint: FP, category: 'accepted-risk', expiresAt: '2026-09-01' });
  });

  it('does NOT suppress an entry whose expiry has lapsed', () => {
    const file = fileWith({
      fingerprint: FP,
      kind: 'code',
      category: 'accepted-risk',
      reason: 'lapsed',
      addedBy: 'r@example.com',
      addedAt: '2020-01-01',
      expiresAt: '2020-02-01',
    });
    expect(allowlistSuppressionFor(file, anchor(FP, 'code'), NOW)).toBeUndefined();
  });

  it('treats expiry as inclusive — an entry expiring today still suppresses', () => {
    const file = fileWith({
      fingerprint: FP,
      kind: 'code',
      category: 'deferred',
      reason: 'fix scheduled',
      addedBy: 'r@example.com',
      addedAt: '2026-05-01',
      expiresAt: '2026-06-08',
    });
    const out = allowlistSuppressionFor(file, anchor(FP, 'code'), NOW);
    expect(out?.category).toBe('deferred');
  });

  it('does NOT suppress when the fingerprint matches but the kind differs (collision guard)', () => {
    const file = fileWith({
      fingerprint: FP,
      kind: 'dep-vuln',
      category: 'accepted-risk',
      reason: 'wrong kind',
      addedBy: 'r@example.com',
      addedAt: '2026-05-01',
      expiresAt: '2099-01-01',
    });
    expect(allowlistSuppressionFor(file, anchor(FP, 'stale-file'), NOW)).toBeUndefined();
  });

  it('does NOT suppress when no entry matches the fingerprint', () => {
    const file = fileWith({
      fingerprint: 'ffffffffffffffff',
      kind: 'code',
      category: 'false-positive',
      reason: 'other finding',
      addedBy: 'r@example.com',
      addedAt: '2026-05-01',
    });
    expect(allowlistSuppressionFor(file, anchor(FP, 'code'), NOW)).toBeUndefined();
  });
});
