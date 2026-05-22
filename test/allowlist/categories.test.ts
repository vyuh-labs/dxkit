import { describe, expect, it } from 'vitest';
import {
  ALL_CATEGORIES,
  CATEGORIES_BY_KIND,
  DEFAULT_EXPIRY_DAYS,
  EXPIRING_CATEGORIES,
  INLINE_COMPATIBLE_CATEGORIES,
  INLINE_COMPATIBLE_KINDS,
  canUseInline,
  defaultExpiryDate,
  isCategoryValidForKind,
  requiresExpiry,
} from '../../src/allowlist/categories';
import type { IdentityKind } from '../../src/baseline/producers';

describe('allowlist categories', () => {
  it('ALL_CATEGORIES contains the five locked values', () => {
    expect(ALL_CATEGORIES).toEqual([
      'false-positive',
      'test-fixture',
      'mitigated-externally',
      'accepted-risk',
      'deferred',
    ]);
  });

  it('EXPIRING_CATEGORIES is exactly accepted-risk + deferred', () => {
    expect([...EXPIRING_CATEGORIES].sort()).toEqual(['accepted-risk', 'deferred']);
  });

  it('INLINE_COMPATIBLE_CATEGORIES is the complement of EXPIRING_CATEGORIES', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(INLINE_COMPATIBLE_CATEGORIES.has(cat)).toBe(!EXPIRING_CATEGORIES.has(cat));
    }
  });

  it('CATEGORIES_BY_KIND covers every IdentityKind', () => {
    // Exhaustiveness — the Record<IdentityKind, ...> already guarantees
    // this at compile time. Asserting at runtime catches regressions
    // where a discriminant is added without an entry.
    const kinds: IdentityKind[] = [
      'secret',
      'secret-hmac',
      'code',
      'config',
      'dep-vuln',
      'duplication',
      'coverage-gap',
      'test-gap',
      'test-file-degradation',
      'god-file',
      'large-file',
      'stale-file',
      'hygiene',
      'stale-allow',
    ];
    for (const k of kinds) {
      expect(CATEGORIES_BY_KIND).toHaveProperty(k);
    }
  });

  it('every category listed under a kind is one of the five canonical values', () => {
    for (const [kind, cats] of Object.entries(CATEGORIES_BY_KIND)) {
      for (const cat of cats) {
        expect(ALL_CATEGORIES).toContain(cat);
        // Sanity: the table never lists a duplicate
        expect(cats.filter((c) => c === cat).length).toBe(1);
      }
      // The kind variable is consumed by toHaveProperty above; mention
      // here to keep the linter from flagging an unused binding.
      expect(typeof kind).toBe('string');
    }
  });

  it('stale-allow kind permits zero allowlist categories (self-suppression forbidden)', () => {
    expect(CATEGORIES_BY_KIND['stale-allow']).toEqual([]);
  });

  it('coverage-gap / test-gap / test-file-degradation are accepted-risk + deferred only', () => {
    expect(CATEGORIES_BY_KIND['coverage-gap']).toEqual(['accepted-risk', 'deferred']);
    expect(CATEGORIES_BY_KIND['test-gap']).toEqual(['accepted-risk', 'deferred']);
    expect(CATEGORIES_BY_KIND['test-file-degradation']).toEqual(['accepted-risk', 'deferred']);
  });

  it('hygiene is accepted-risk + deferred only', () => {
    expect(CATEGORIES_BY_KIND.hygiene).toEqual(['accepted-risk', 'deferred']);
  });

  it('source-level security kinds carry all five categories', () => {
    for (const k of ['secret', 'secret-hmac', 'code', 'config'] as const) {
      expect(CATEGORIES_BY_KIND[k]).toEqual(ALL_CATEGORIES);
    }
  });

  describe('INLINE_COMPATIBLE_KINDS', () => {
    it('includes the source-attached kinds', () => {
      for (const k of ['secret', 'secret-hmac', 'code', 'config', 'dep-vuln', 'hygiene'] as const) {
        expect(INLINE_COMPATIBLE_KINDS.has(k)).toBe(true);
      }
    });

    it('excludes whole-file + cross-file + gap kinds', () => {
      for (const k of [
        'duplication',
        'coverage-gap',
        'test-gap',
        'test-file-degradation',
        'god-file',
        'large-file',
        'stale-file',
      ] as const) {
        expect(INLINE_COMPATIBLE_KINDS.has(k)).toBe(false);
      }
    });
  });

  describe('canUseInline', () => {
    it('true when both kind and category are inline-compatible', () => {
      expect(canUseInline('secret', 'test-fixture')).toBe(true);
      expect(canUseInline('code', 'false-positive')).toBe(true);
      expect(canUseInline('dep-vuln', 'mitigated-externally')).toBe(true);
    });

    it('false when category is file-only', () => {
      expect(canUseInline('secret', 'accepted-risk')).toBe(false);
      expect(canUseInline('secret', 'deferred')).toBe(false);
    });

    it('false when kind is file-only', () => {
      expect(canUseInline('large-file', 'false-positive')).toBe(false);
      expect(canUseInline('coverage-gap', 'false-positive')).toBe(false);
      expect(canUseInline('duplication', 'false-positive')).toBe(false);
    });

    it('false when both are file-only', () => {
      expect(canUseInline('large-file', 'accepted-risk')).toBe(false);
    });
  });

  describe('requiresExpiry', () => {
    it('true for accepted-risk and deferred', () => {
      expect(requiresExpiry('accepted-risk')).toBe(true);
      expect(requiresExpiry('deferred')).toBe(true);
    });

    it('false for false-positive, test-fixture, mitigated-externally', () => {
      expect(requiresExpiry('false-positive')).toBe(false);
      expect(requiresExpiry('test-fixture')).toBe(false);
      expect(requiresExpiry('mitigated-externally')).toBe(false);
    });
  });

  describe('isCategoryValidForKind', () => {
    it('true when category appears in the kind table', () => {
      expect(isCategoryValidForKind('secret', 'test-fixture')).toBe(true);
      expect(isCategoryValidForKind('dep-vuln', 'mitigated-externally')).toBe(true);
      expect(isCategoryValidForKind('hygiene', 'deferred')).toBe(true);
    });

    it('false when category does not apply to the kind', () => {
      expect(isCategoryValidForKind('coverage-gap', 'false-positive')).toBe(false);
      expect(isCategoryValidForKind('dep-vuln', 'test-fixture')).toBe(false);
      expect(isCategoryValidForKind('hygiene', 'test-fixture')).toBe(false);
    });

    it('false for any category against stale-allow', () => {
      for (const cat of ALL_CATEGORIES) {
        expect(isCategoryValidForKind('stale-allow', cat)).toBe(false);
      }
    });
  });

  describe('defaultExpiryDate', () => {
    it('returns YYYY-MM-DD format', () => {
      const out = defaultExpiryDate(new Date('2026-05-22T12:34:56Z'));
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('adds exactly DEFAULT_EXPIRY_DAYS to the input date', () => {
      // 2026-05-22 + 90 days = 2026-08-20
      expect(defaultExpiryDate(new Date('2026-05-22T00:00:00Z'))).toBe('2026-08-20');
    });

    it('handles month/year rollover', () => {
      // 2026-12-15 + 90 days = 2027-03-15
      expect(defaultExpiryDate(new Date('2026-12-15T00:00:00Z'))).toBe('2027-03-15');
    });

    it('DEFAULT_EXPIRY_DAYS is locked at 90 (Sprint 0 decision)', () => {
      expect(DEFAULT_EXPIRY_DAYS).toBe(90);
    });
  });
});
