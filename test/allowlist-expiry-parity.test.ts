import { describe, it, expect } from 'vitest';
import {
  auditAllowlist,
  daysUntilDate,
  daysUntilExpiry,
  SOON_TO_EXPIRE_DAYS,
  type AllowlistEntry,
  type AllowlistFile,
} from '../src/allowlist/file';
import { allowlistSuppressionFor } from '../src/baseline/allowlist-match';
import { collectExpiryProjection } from '../src/baseline/expiry-projection';
import type { BaselineEntry } from '../src/baseline/types';
import type { IdentityKind } from '../src/baseline/producers';

/**
 * PARITY: the allowlist audit's "expiring soon" buckets vs the guardrail
 * check's lapse projection.
 *
 * One concept — "which suppressions are about to lapse, and in how many days" —
 * with two consumers holding DIFFERENT shapes of it (CLAUDE.md 2.30). The audit
 * side (`doctor`, `allowlist audit`) walks full `AllowlistEntry` objects. The
 * check side walks per-finding suppressions that carry only the `expiresAt`
 * STRING — a lossy projection of the entry — which is exactly the setup where
 * the second consumer re-derives the arithmetic slightly differently (an
 * off-by-one on the inclusive boundary, a local-vs-UTC day, a horizon default
 * that drifted from 14) and the two surfaces start disagreeing about the same
 * date. Grep cannot see that; only running both on shared fixtures can.
 *
 * So: build ONE fixture, drive BOTH consumers through their real entry points,
 * and assert they agree on membership and on every day count.
 */

const NOW = new Date('2026-07-29T12:00:00Z');

function entry(fingerprint: string, kind: IdentityKind, expiresAt?: string): AllowlistEntry {
  return {
    fingerprint,
    kind,
    category: expiresAt ? 'deferred' : 'false-positive',
    reason: 'time-boxed pending dependency remediation',
    addedBy: 'r@example.com',
    addedAt: '2026-07-22',
    ...(expiresAt ? { expiresAt } : {}),
  } as AllowlistEntry;
}

function fileOf(entries: AllowlistEntry[]): AllowlistFile {
  return { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries };
}

function anchor(id: string, kind: IdentityKind): BaselineEntry {
  return { id, kind } as unknown as BaselineEntry;
}

/**
 * The check side, built the way `check.ts` builds it: resolve each finding's
 * suppression through the real `allowlistSuppressionFor` (which is what drops
 * the already-expired entries), then project. Anything the projection sees, it
 * saw through the production path.
 */
function projectionFor(file: AllowlistFile, now: Date, horizonDays?: number) {
  const pairs = file.entries.map((e) => {
    const suppression = allowlistSuppressionFor(file, anchor(e.fingerprint, e.kind), now);
    return {
      kind: e.kind as string,
      classification: { blocks: true, warns: false },
      ...(suppression ? { suppressedByAllowlist: suppression } : {}),
    };
  });
  return collectExpiryProjection({
    pairs,
    now,
    ...(horizonDays !== undefined ? { horizonDays } : {}),
  });
}

/** The audit side's soon-to-expire bucket, keyed for comparison. */
function auditSoon(file: AllowlistFile, now: Date, soonToExpireDays?: number) {
  const report = auditAllowlist(file, {
    now,
    ...(soonToExpireDays !== undefined ? { soonToExpireDays } : {}),
  });
  return new Map(report.soonToExpire.map((s) => [s.entry.fingerprint, s.daysRemaining]));
}

function projectionDays(file: AllowlistFile, now: Date, horizonDays?: number) {
  return new Map(
    projectionFor(file, now, horizonDays).lapsing.map((l) => [l.fingerprint, l.daysRemaining]),
  );
}

// A fixture spanning every interesting position relative to the horizon and the
// inclusive boundaries — modelled on the real incident (a batch deferred on
// 07-22 with a six-day window) plus the edges that an independent
// re-implementation gets wrong.
const FIXTURE = fileOf([
  entry('a000000000000000', 'dep-vuln', '2026-07-29'), // expires TODAY — still suppresses
  entry('b000000000000000', 'dep-vuln', '2026-07-30'), // tomorrow
  entry('c000000000000000', 'secret', '2026-08-05'), // inside the horizon
  entry('d000000000000000', 'code', '2026-08-12'), // exactly ON the horizon (14d)
  entry('e000000000000000', 'code', '2026-08-13'), // one day PAST the horizon
  entry('f000000000000000', 'code', '2026-06-01'), // already expired
  entry('0000000000000000', 'code'), // no expiry at all
]);

describe('allowlist expiry parity — audit buckets vs the check projection', () => {
  it('agrees on membership and on every day count, at the default horizon', () => {
    const audit = auditSoon(FIXTURE, NOW);
    const projected = projectionDays(FIXTURE, NOW);

    expect([...projected.keys()].sort()).toEqual([...audit.keys()].sort());
    for (const [fingerprint, days] of audit) {
      expect(projected.get(fingerprint)).toBe(days);
    }
    // Positive control: the fixture must actually exercise the horizon, or the
    // assertion above passes on two empty sets.
    expect(audit.size).toBe(4);
    expect([...audit.keys()].sort()).toEqual([
      'a000000000000000',
      'b000000000000000',
      'c000000000000000',
      'd000000000000000',
    ]);
  });

  it('agrees at a widened horizon — the override reaches both consumers', () => {
    const audit = auditSoon(FIXTURE, NOW, 30);
    const projected = projectionDays(FIXTURE, NOW, 30);
    expect([...projected.keys()].sort()).toEqual([...audit.keys()].sort());
    for (const [fingerprint, days] of audit) expect(projected.get(fingerprint)).toBe(days);
    // The entry one day past the default horizon is now in scope on BOTH sides.
    expect(audit.has('e000000000000000')).toBe(true);
    expect(projected.has('e000000000000000')).toBe(true);
  });

  it('agrees at a narrowed horizon', () => {
    const audit = auditSoon(FIXTURE, NOW, 1);
    const projected = projectionDays(FIXTURE, NOW, 1);
    expect([...projected.keys()].sort()).toEqual([...audit.keys()].sort());
    expect(audit.size).toBe(2); // today + tomorrow only
  });

  it('shares one horizon default, so neither side can drift from 14', () => {
    expect(SOON_TO_EXPIRE_DAYS).toBe(14);
    expect(auditSoon(FIXTURE, NOW).size).toBe(auditSoon(FIXTURE, NOW, SOON_TO_EXPIRE_DAYS).size);
    expect(projectionDays(FIXTURE, NOW).size).toBe(
      projectionDays(FIXTURE, NOW, SOON_TO_EXPIRE_DAYS).size,
    );
  });

  it('excludes the already-expired entry from BOTH sides, for the two different reasons', () => {
    // Audit: it lands in `expired`, never in `soonToExpire`.
    const report = auditAllowlist(FIXTURE, { now: NOW });
    expect(report.expired.map((e) => e.fingerprint)).toEqual(['f000000000000000']);
    expect(report.soonToExpire.map((s) => s.entry.fingerprint)).not.toContain('f000000000000000');
    // Check: an expired entry does not suppress at all, so nothing reaches the
    // projection. Same answer, arrived at honestly from each side's own data.
    expect(projectionDays(FIXTURE, NOW).has('f000000000000000')).toBe(false);
  });

  it('excludes the never-expiring entry from both sides', () => {
    expect(auditSoon(FIXTURE, NOW).has('0000000000000000')).toBe(false);
    expect(projectionDays(FIXTURE, NOW).has('0000000000000000')).toBe(false);
  });

  it('routes both consumers through the one day-math home', () => {
    // `daysUntilExpiry` (entry-shaped, the audit side) and `daysUntilDate`
    // (string-shaped, the projection side) are the same arithmetic. If a future
    // edit forks them, the membership assertions above still catch it — this
    // just names the shared primitive.
    for (const e of FIXTURE.entries) {
      if (!e.expiresAt) continue;
      expect(daysUntilExpiry(e, NOW)).toBe(daysUntilDate(e.expiresAt, NOW));
    }
    // Whole UTC days regardless of the wall-clock time inside the day: a late
    // evening run and an early morning run must report the same countdown.
    for (const at of ['2026-07-29T00:00:01Z', '2026-07-29T23:59:59Z']) {
      expect(daysUntilDate('2026-08-05', new Date(at))).toBe(7);
    }
  });
});
