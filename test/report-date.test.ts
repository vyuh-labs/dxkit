import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getReportDate } from '../src/analyzers/tools/report-date';

describe('getReportDate', () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.DXKIT_REPORT_DATE;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.DXKIT_REPORT_DATE;
    else process.env.DXKIT_REPORT_DATE = prevEnv;
  });

  it('returns DXKIT_REPORT_DATE when set to a YYYY-MM-DD value', () => {
    process.env.DXKIT_REPORT_DATE = '2026-01-01';
    expect(getReportDate()).toBe('2026-01-01');
  });

  it('returns DXKIT_REPORT_DATE across multiple invocations (snapshot is stable)', () => {
    process.env.DXKIT_REPORT_DATE = '2026-05-17';
    expect(getReportDate()).toBe('2026-05-17');
    expect(getReportDate()).toBe('2026-05-17');
  });

  it('ignores a malformed DXKIT_REPORT_DATE and falls back to today', () => {
    process.env.DXKIT_REPORT_DATE = 'not-a-date';
    const today = new Date().toISOString().slice(0, 10);
    expect(getReportDate()).toBe(today);
  });

  it('ignores an empty DXKIT_REPORT_DATE and falls back to today', () => {
    process.env.DXKIT_REPORT_DATE = '';
    const today = new Date().toISOString().slice(0, 10);
    expect(getReportDate()).toBe(today);
  });

  it('returns today when DXKIT_REPORT_DATE is unset', () => {
    delete process.env.DXKIT_REPORT_DATE;
    const today = new Date().toISOString().slice(0, 10);
    expect(getReportDate()).toBe(today);
  });

  // The orchestrator + child snapshot guarantee: if the env var were
  // NOT honored, a long `report` run crossing UTC midnight would
  // produce a mix of pre- and post-midnight report suffixes. Pinning
  // the env to a fixed value emulates the orchestrator's snapshot
  // and confirms every consumer reads the same date.
  it('snapshot survives a Date.now jump (orchestrator scenario)', () => {
    process.env.DXKIT_REPORT_DATE = '2026-05-17';
    expect(getReportDate()).toBe('2026-05-17');
    // Even if "now" has rolled forward to a new UTC day, the
    // snapshot does not move.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 24 * 60 * 60 * 1000;
      expect(getReportDate()).toBe('2026-05-17');
    } finally {
      Date.now = realNow;
    }
  });
});
