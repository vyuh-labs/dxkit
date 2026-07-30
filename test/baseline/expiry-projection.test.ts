import { describe, it, expect } from 'vitest';
import {
  collectExpiryProjection,
  describeExpiryProjection,
  describeLapsingSuppression,
  EXPIRY_PROJECTION_REMEDY,
} from '../../src/baseline/expiry-projection';
import { SOON_TO_EXPIRE_DAYS } from '../../src/allowlist/file';

/**
 * The lapse projection — what active allowlist suppressions will do when their
 * windows close. Unit coverage for the collector across all five suppression
 * sources; `test/allowlist-expiry-parity.test.ts` pins it against the audit
 * buckets (the Rule 2.30 net), and the renderer tests cover delivery.
 */

const NOW = new Date('2026-07-29T12:00:00Z');

function pair(opts: {
  kind: string;
  blocks: boolean;
  expiresAt?: string;
  fingerprint?: string;
  category?: string;
  file?: string;
  line?: number;
}) {
  const { kind, blocks, expiresAt, fingerprint = 'fp' + kind, category = 'deferred' } = opts;
  return {
    kind,
    classification: { blocks, warns: !blocks },
    ...(opts.file !== undefined ? { file: opts.file } : {}),
    ...(opts.line !== undefined ? { line: opts.line } : {}),
    suppressedByAllowlist: {
      fingerprint,
      category,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}

describe('collectExpiryProjection', () => {
  it('projects a blocking pair suppression with its days remaining and locator', () => {
    const out = collectExpiryProjection({
      pairs: [
        pair({
          kind: 'dep-vuln',
          blocks: true,
          expiresAt: '2026-08-03',
          file: 'package-lock.json',
          line: 12,
        }),
      ],
      now: NOW,
    });
    expect(out.horizonDays).toBe(SOON_TO_EXPIRE_DAYS);
    expect(out.willBlock).toBe(1);
    expect(out.willWarn).toBe(0);
    expect(out.nextLapseDays).toBe(5);
    expect(out.lapsing[0]).toEqual({
      source: 'finding',
      fingerprint: 'fpdep-vuln',
      category: 'deferred',
      expiresAt: '2026-08-03',
      daysRemaining: 5,
      consequence: 'block',
      subject: 'dep-vuln package-lock.json:12',
    });
  });

  it('reads the tier off the classification rather than re-deriving it', () => {
    // A `blocking: false` custom check warns even though its kind is otherwise
    // block-class; the classification already folded that intent in.
    const out = collectExpiryProjection({
      pairs: [pair({ kind: 'custom-check', blocks: false, expiresAt: '2026-08-01' })],
      now: NOW,
    });
    expect(out.lapsing[0]!.consequence).toBe('warn');
    expect(out.willBlock).toBe(0);
    expect(out.willWarn).toBe(1);
  });

  it('excludes a non-expiring suppression — it is not a decision waiting to happen', () => {
    const out = collectExpiryProjection({
      pairs: [pair({ kind: 'code', blocks: true, category: 'false-positive' })],
      now: NOW,
    });
    expect(out.lapsing).toEqual([]);
    expect(out.nextLapseDays).toBeUndefined();
  });

  it('excludes an expiry beyond the horizon, and honours an override', () => {
    const far = [pair({ kind: 'code', blocks: true, expiresAt: '2026-08-20' })];
    expect(collectExpiryProjection({ pairs: far, now: NOW }).lapsing).toEqual([]);
    const wider = collectExpiryProjection({ pairs: far, now: NOW, horizonDays: 30 });
    expect(wider.horizonDays).toBe(30);
    expect(wider.lapsing).toHaveLength(1);
    expect(wider.lapsing[0]!.daysRemaining).toBe(22);
  });

  it('includes an entry expiring today (expiry is inclusive, so it still suppresses)', () => {
    const out = collectExpiryProjection({
      pairs: [pair({ kind: 'secret', blocks: true, expiresAt: '2026-07-29' })],
      now: NOW,
    });
    expect(out.lapsing[0]!.daysRemaining).toBe(0);
    expect(describeLapsingSuppression(out.lapsing[0]!)).toContain('(today)');
  });

  it('covers all four additive gates, not just the matcher pairs', () => {
    const out = collectExpiryProjection({
      pairs: [],
      now: NOW,
      flowGate: {
        suppressed: [
          {
            fingerprint: 'ff',
            category: 'deferred',
            expiresAt: '2026-08-02',
            finding: { method: 'GET', path: '/api/orders', verdict: 'block' },
          },
        ],
      },
      schemaDriftGate: {
        suppressed: [
          {
            fingerprint: 'sf',
            category: 'deferred',
            expiresAt: '2026-08-04',
            finding: {
              changeClass: 'field-removed',
              model: 'Order',
              field: 'total',
              verdict: 'warn',
            },
          },
          {
            fingerprint: 'si',
            category: 'deferred',
            expiresAt: '2026-08-04',
            finding: { changeClass: 'field-added', model: 'Order', field: null, verdict: 'info' },
          },
        ],
      },
      dupGate: {
        suppressed: [
          {
            fingerprint: 'df',
            category: 'deferred',
            expiresAt: '2026-08-05',
            finding: { anchors: [{ symbol: 'parseA' }, { symbol: 'parseB' }] },
          },
        ],
      },
      pairedGate: {
        suppressed: [
          {
            fingerprint: 'pf',
            category: 'deferred',
            expiresAt: '2026-08-06',
            finding: { check: 'model-requires-migration', blocking: true },
          },
        ],
      },
    });
    expect(out.lapsing.map((l) => [l.source, l.subject, l.consequence])).toEqual([
      ['flow', 'GET /api/orders', 'block'],
      // Same lapse date: warn ranks ahead of disclosure-only info.
      ['schema-drift', 'field-removed Order.total', 'warn'],
      ['schema-drift', 'field-added Order', 'info'],
      ['duplication', 'parseA / parseB', 'warn'],
      ['paired-change', 'model-requires-migration', 'block'],
    ]);
    // `info` is disclosure-only: it appears in the list, counts toward neither.
    expect(out.willBlock).toBe(2);
    expect(out.willWarn).toBe(2);
  });

  it('orders soonest first, blocks before warns on the same day', () => {
    const out = collectExpiryProjection({
      pairs: [
        pair({ kind: 'code', blocks: false, expiresAt: '2026-08-01', fingerprint: 'a' }),
        pair({ kind: 'secret', blocks: true, expiresAt: '2026-08-01', fingerprint: 'b' }),
        pair({ kind: 'dep-vuln', blocks: true, expiresAt: '2026-07-30', fingerprint: 'c' }),
      ],
      now: NOW,
    });
    expect(out.lapsing.map((l) => l.fingerprint)).toEqual(['c', 'b', 'a']);
    expect(out.nextLapseDays).toBe(1);
  });

  it('is empty and silent on a run with no suppressions at all', () => {
    const out = collectExpiryProjection({ pairs: [], now: NOW });
    expect(out).toEqual({
      horizonDays: SOON_TO_EXPIRE_DAYS,
      lapsing: [],
      willBlock: 0,
      willWarn: 0,
    });
    expect(describeExpiryProjection(out)).toBeUndefined();
  });
});

describe('describeExpiryProjection', () => {
  it('leads with the block consequence and the soonest lapse', () => {
    const out = collectExpiryProjection({
      pairs: [
        pair({ kind: 'dep-vuln', blocks: true, expiresAt: '2026-08-03', fingerprint: 'a' }),
        pair({ kind: 'dep-vuln', blocks: true, expiresAt: '2026-08-04', fingerprint: 'b' }),
        pair({ kind: 'code', blocks: false, expiresAt: '2026-08-05', fingerprint: 'c' }),
      ],
      now: NOW,
    });
    const line = describeExpiryProjection(out);
    expect(line).toBe(
      '3 allowlist suppressions expire within 14 days (next in 5d); ' +
        'when they lapse, 2 will BLOCK, 1 will warn',
    );
    expect(EXPIRY_PROJECTION_REMEDY).toContain('allowlist audit');
  });

  it('says so plainly when nothing lapsing would block or warn', () => {
    const out = collectExpiryProjection({
      pairs: [],
      now: NOW,
      schemaDriftGate: {
        suppressed: [
          {
            fingerprint: 'si',
            category: 'deferred',
            expiresAt: '2026-08-01',
            finding: { changeClass: 'field-added', model: 'Order', field: null, verdict: 'info' },
          },
        ],
      },
    });
    expect(describeExpiryProjection(out)).toContain('none will block or warn');
  });
});
