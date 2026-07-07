/**
 * Metrics reducer (#33 Layer 1). Pins the ROI aggregation over the loop
 * ledger: interceptions (the ungameable headline) sum net-new blocked findings;
 * the by-category breakdown attributes them to a finding kind; the weekly series
 * buckets by ISO week; and events written before per-category detail existed are
 * counted in the totals but surfaced as "not attributable" rather than silently
 * dropped.
 */
import { describe, expect, it } from 'vitest';
import { computeMetrics, isoWeek } from '../../src/loop/metrics';
import type { LedgerEvent } from '../../src/loop/ledger';

function ev(p: Partial<LedgerEvent>): LedgerEvent {
  return {
    schema_version: 1,
    timestamp: '2026-06-22T10:00:00Z',
    event: 'Stop',
    session_id: 's',
    cwd: '/x',
    branch: 'feat',
    commit: 'abc',
    guardrail_status: 'pass',
    net_new_findings: 0,
    baseline_findings: 0,
    files_changed: 0,
    allowed: true,
    stop_hook_active: false,
    tests_status: 'skipped',
    lint_status: 'not_configured',
    typecheck_status: 'not_configured',
    duration_ms: 1,
    ...p,
  };
}

describe('computeMetrics', () => {
  it('sums interceptions from net-new blocked findings and attributes them by category', () => {
    const events = [
      ev({
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 2,
        categories: { secret: 1, 'dep-vuln': 1 },
        warn_findings: 1,
        warn_categories: { code: 1 },
      }),
      ev({
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 1,
        categories: { secret: 1 },
      }),
      ev({ allowed: true, guardrail_status: 'pass' }),
    ];
    const r = computeMetrics(events);
    expect(r.interceptions).toBe(3);
    expect(r.blockedCompletions).toBe(2);
    expect(r.cleanStops).toBe(1);
    expect(r.warnings).toBe(1);
    // secret=2 leads, dep-vuln=1
    expect(r.blockedByCategory[0]).toEqual({ category: 'secret', count: 2 });
    expect(r.blockedByCategory).toContainEqual({ category: 'dep-vuln', count: 1 });
    expect(r.warnedByCategory).toEqual([{ category: 'code', count: 1 }]);
    expect(r.eventsMissingCategoryData).toBe(0);
  });

  it('counts a category-less blocked event in totals but flags it as unattributable', () => {
    const events = [
      ev({ allowed: false, guardrail_status: 'fail', net_new_findings: 3 }), // no `categories`
      ev({
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 1,
        categories: { code: 1 },
      }),
    ];
    const r = computeMetrics(events);
    expect(r.interceptions).toBe(4); // both counted
    expect(r.eventsMissingCategoryData).toBe(1); // but one can't be attributed
    expect(r.blockedByCategory).toEqual([{ category: 'code', count: 1 }]);
  });

  it('does not count a liveness-floor block (guardrail passed) as an interception', () => {
    // Floor blocks set allowed:false, guardrail_status:'pass', net_new_findings:0.
    const r = computeMetrics([
      ev({ allowed: false, guardrail_status: 'pass', net_new_findings: 0 }),
    ]);
    expect(r.interceptions).toBe(0);
    expect(r.blockedCompletions).toBe(1); // the loop WAS blocked
    expect(r.cleanStops).toBe(0); // ...but it wasn't a clean stop
  });

  it('buckets by ISO week, chronologically', () => {
    const r = computeMetrics([
      ev({
        timestamp: '2026-06-15T09:00:00Z',
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 3,
      }),
      ev({
        timestamp: '2026-06-22T09:00:00Z',
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 2,
      }),
      ev({ timestamp: '2026-06-23T09:00:00Z', allowed: true, guardrail_status: 'pass' }),
    ]);
    expect(r.weekly.map((w) => w.week)).toEqual(['2026-W25', '2026-W26']);
    expect(r.weekly[0]).toMatchObject({ interceptions: 3, blocked: 1 });
    expect(r.weekly[1]).toMatchObject({ interceptions: 2, blocked: 1, clean: 1 });
  });

  it('detects repair-after-block per session (reused from summarizeLedger)', () => {
    const r = computeMetrics([
      ev({ session_id: 's1', allowed: false, guardrail_status: 'fail', net_new_findings: 1 }),
      ev({ session_id: 's1', allowed: true, guardrail_status: 'pass' }), // repaired
      ev({ session_id: 's2', allowed: false, guardrail_status: 'fail', net_new_findings: 1 }), // never repaired
    ]);
    expect(r.repairedAfterBlock).toBe(1);
    expect(r.unrepairedSessions).toBe(1);
  });

  it('filters by sinceMs', () => {
    const cut = Date.parse('2026-06-20T00:00:00Z');
    const r = computeMetrics(
      [
        ev({
          timestamp: '2026-06-15T09:00:00Z',
          allowed: false,
          guardrail_status: 'fail',
          net_new_findings: 5,
        }),
        ev({
          timestamp: '2026-06-22T09:00:00Z',
          allowed: false,
          guardrail_status: 'fail',
          net_new_findings: 2,
        }),
      ],
      { sinceMs: cut },
    );
    expect(r.events).toBe(1);
    expect(r.interceptions).toBe(2);
  });

  it('is empty-safe', () => {
    const r = computeMetrics([]);
    expect(r.events).toBe(0);
    expect(r.interceptions).toBe(0);
    expect(r.weekly).toEqual([]);
    expect(r.span).toEqual({ from: undefined, to: undefined });
  });
});

describe('isoWeek', () => {
  it('labels weeks per ISO-8601 (week-year follows the Thursday)', () => {
    expect(isoWeek('2026-06-22T00:00:00Z')).toBe('2026-W26');
    // 2026-01-01 is a Thursday → belongs to W01 of 2026.
    expect(isoWeek('2026-01-01T12:00:00Z')).toBe('2026-W01');
    // Sunday 2027-01-03 is still ISO week 53 of 2026 (its Thursday is 2026-12-31).
    expect(isoWeek('2027-01-03T00:00:00Z')).toBe('2026-W53');
  });

  it('is defensive on an unparseable timestamp', () => {
    expect(isoWeek('not-a-date')).toBe('unknown');
  });
});
