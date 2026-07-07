/**
 * Metrics aggregation over the loop ledger (#33 Layer 1) — the champion's ROI
 * number, computed not narrated.
 *
 * The headline is INTERCEPTIONS: net-new findings the guardrail BLOCKED before
 * they reached the base branch. That number can't be gamed — it's a count of
 * events the gate actually stopped, drawn from the append-only ledger the loop
 * writes on every Stop. Health-score deltas are a trend proxy and belong to a
 * later layer; interceptions are the primary, ungameable signal.
 *
 * This is a pure reducer over `LedgerEvent[]` — the CLI (`src/metrics-cli.ts`)
 * reads the ledger, resolves `--since`, and renders. Repair detection reuses
 * `summarizeLedger` (Rule 2 — one code path for "was a block later repaired").
 */
import { summarizeLedger, type LedgerEvent } from './ledger';

export interface CategoryCount {
  readonly category: string;
  readonly count: number;
}

export interface WeeklyBucket {
  /** ISO-8601 week label, e.g. `2026-W28`. */
  readonly week: string;
  /** Net-new findings blocked this week (sums `net_new_findings`). */
  readonly interceptions: number;
  /** Stop events that blocked the loop this week (guardrail OR liveness floor). */
  readonly blocked: number;
  /** Net-new WARNING-class findings surfaced this week. */
  readonly warned: number;
  /** Clean stops this week (allowed + guardrail passed). */
  readonly clean: number;
}

export interface MetricsReport {
  /** Ledger events in scope (after any `--since` filter). */
  readonly events: number;
  /** ISO timestamps of the first and last in-scope events. */
  readonly span: { readonly from?: string; readonly to?: string };
  /** THE headline: net-new findings the gate blocked pre-merge. */
  readonly interceptions: number;
  /** Stop events that blocked the loop (guardrail or liveness floor). */
  readonly blockedCompletions: number;
  /** Net-new WARNING-class findings surfaced (non-blocking). */
  readonly warnings: number;
  /** Clean stops (allowed + guardrail passed). */
  readonly cleanStops: number;
  /** Sessions blocked at least once then later stopped clean — the loop fixed
   *  what it introduced. */
  readonly repairedAfterBlock: number;
  /** Sessions blocked and never repaired. */
  readonly unrepairedSessions: number;
  /** Blocked interceptions attributed to a finding kind, most-blocked first. */
  readonly blockedByCategory: readonly CategoryCount[];
  /** Warnings attributed to a finding kind, most-warned first. */
  readonly warnedByCategory: readonly CategoryCount[];
  /** Per-ISO-week series, chronological. */
  readonly weekly: readonly WeeklyBucket[];
  /**
   * Blocked events lacking per-category detail (written before the metrics
   * series recorded it, or cache-replayed). They're counted in `interceptions`
   * and `blockedCompletions` but can't be attributed to a category — surfaced
   * so the by-category view is honest about its coverage rather than silently
   * under-counting.
   */
  readonly eventsMissingCategoryData: number;
}

export interface MetricsOptions {
  /** Epoch ms; drop events with an earlier timestamp. Undefined = all history. */
  readonly sinceMs?: number;
}

/** ISO-8601 week label (`YYYY-Www`) for a timestamp, computed in UTC so the
 *  bucketing is environment-independent. The week-year is the year of the
 *  week's Thursday (ISO rule), so late-December / early-January edge weeks land
 *  in the right year. */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  // Shift to the Thursday of this week: ISO weeks are Mon–Sun, and the week's
  // year/number are defined by its Thursday.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // this week's Thursday
  const weekYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4)); // Jan 4 is always in W01
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

type MutableWeeklyBucket = { -readonly [K in keyof WeeklyBucket]: WeeklyBucket[K] };

function sortByCountDesc(hist: Map<string, number>): CategoryCount[] {
  return [...hist.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Reduce ledger events to the ROI report. Pure — no I/O, no clock. */
export function computeMetrics(
  events: ReadonlyArray<LedgerEvent>,
  opts: MetricsOptions = {},
): MetricsReport {
  const inScope =
    opts.sinceMs === undefined
      ? [...events]
      : events.filter((e) => {
          const t = Date.parse(e.timestamp);
          return Number.isFinite(t) && t >= opts.sinceMs!;
        });

  const summary = summarizeLedger(inScope); // repair detection (Rule 2)

  let interceptions = 0;
  let blockedCompletions = 0;
  let warnings = 0;
  let cleanStops = 0;
  let eventsMissingCategoryData = 0;
  const blockedHist = new Map<string, number>();
  const warnedHist = new Map<string, number>();
  const weeks = new Map<string, MutableWeeklyBucket>();

  for (const e of inScope) {
    const blocked = !e.allowed;
    if (blocked) {
      blockedCompletions++;
      interceptions += e.net_new_findings;
      if (e.net_new_findings > 0 && e.categories === undefined) eventsMissingCategoryData++;
    } else if (e.guardrail_status === 'pass') {
      cleanStops++;
    }
    warnings += e.warn_findings ?? 0;

    for (const [cat, n] of Object.entries(e.categories ?? {})) {
      blockedHist.set(cat, (blockedHist.get(cat) ?? 0) + n);
    }
    for (const [cat, n] of Object.entries(e.warn_categories ?? {})) {
      warnedHist.set(cat, (warnedHist.get(cat) ?? 0) + n);
    }

    const wk = isoWeek(e.timestamp);
    const bucket = weeks.get(wk) ?? { week: wk, interceptions: 0, blocked: 0, warned: 0, clean: 0 };
    if (blocked) {
      bucket.blocked++;
      bucket.interceptions += e.net_new_findings;
    } else if (e.guardrail_status === 'pass') {
      bucket.clean++;
    }
    bucket.warned += e.warn_findings ?? 0;
    weeks.set(wk, bucket);
  }

  const weekly = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));

  return {
    events: inScope.length,
    span: {
      from: inScope[0]?.timestamp,
      to: inScope[inScope.length - 1]?.timestamp,
    },
    interceptions,
    blockedCompletions,
    warnings,
    cleanStops,
    repairedAfterBlock: summary.repairedAfterBlock,
    unrepairedSessions: summary.unrepairedSessions,
    blockedByCategory: sortByCountDesc(blockedHist),
    warnedByCategory: sortByCountDesc(warnedHist),
    weekly,
    eventsMissingCategoryData,
  };
}
