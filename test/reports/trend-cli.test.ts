/**
 * `report trend` (impact P3, the #332 read surface): the CLI renders the
 * segmented since-install series from the ONE history reader (injected
 * here), degrades honestly on an empty history, tolerates malformed JSONL
 * lines (via the same parser every reader uses), and emits an additive JSON
 * form with the comparability segmentation intact.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runReportTrend } from '../../src/reports-cli';
import { parseHistory, serializeHistory, type ReportHistoryEntry } from '../../src/reports/history';

const tmps: string[] = [];
function mkCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'dxkit-trend-cli-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function entry(
  sha: string,
  date: string,
  overall: number,
  extra: Partial<ReportHistoryEntry> = {},
): ReportHistoryEntry {
  return {
    sha,
    date,
    dxkitVersion: '4.4.7',
    methodology: 'spec-v1',
    scoreInputs: ['gitleaks'],
    scores: {
      overall,
      security: 40,
      quality: 60,
      tests: 55,
      documentation: 30,
      maintainability: 70,
      developerExperience: 65,
    },
    ...extra,
  };
}

/** Capture console.log output while running `fn`. */
function captureConsole(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

/** Capture raw stdout writes (the --json path). */
function captureStdout(fn: () => void): string {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('report trend (console)', () => {
  it('renders per-dimension sparklines + the trend context line for a flat since-install series', () => {
    const history = [
      entry('aaa', '2026-07-20T00:00:00.000Z', 24),
      entry('bbb', '2026-07-27T00:00:00.000Z', 24),
      entry('ccc', '2026-08-03T00:00:00.000Z', 24),
    ];
    const out = captureConsole(() => {
      expect(runReportTrend({ cwd: mkCwd(), readHistory: () => history })).toBe(0);
    });
    expect(out).toContain('3 snapshot(s) since 2026-07-20');
    expect(out).toContain('overall');
    expect(out).toContain('▂▂▂'); // 24/24/24 on the fixed 0..100 scale
    expect(out).toContain('24 (flat)');
    expect(out).toContain('Repo trend: overall 24, flat since 2026-07-20 (3 snapshots)');
    // One segment: no segment headers, no boundary marker.
    expect(out).not.toContain('comparability boundary');
    expect(out).not.toContain('segment 1');
  });

  it('a rising series shows both endpoints and the delta', () => {
    const history = [
      entry('aaa', '2026-07-20T00:00:00.000Z', 24),
      entry('bbb', '2026-08-03T00:00:00.000Z', 30),
    ];
    const out = captureConsole(() => runReportTrend({ cwd: mkCwd(), readHistory: () => history }));
    expect(out).toContain('24 -> 30 (+6)');
    expect(out).toContain('up from 24 since 2026-07-20');
  });

  it('segments at a methodology boundary: separate blocks, boundary reason, never one line across', () => {
    const history = [
      entry('aaa', '2026-07-01T00:00:00.000Z', 20),
      entry('bbb', '2026-07-10T00:00:00.000Z', 20),
      entry('ccc', '2026-08-01T00:00:00.000Z', 40, { methodology: 'spec-v2' }),
    ];
    const out = captureConsole(() => runReportTrend({ cwd: mkCwd(), readHistory: () => history }));
    expect(out).toContain('comparability boundary: scoring methodology changed');
    expect(out).toContain(
      'segment 1: 2026-07-01 -> 2026-07-10 (2 snapshot(s), methodology spec-v1)',
    );
    expect(out).toContain(
      'segment 2: 2026-08-01 -> 2026-08-01 (1 snapshot(s), methodology spec-v2)',
    );
    // The context line anchors on the comparable window and discloses it.
    expect(out).toContain('1 of 3 snapshots');
  });

  it('the finding-count secondary series renders where present, scaled to its own max', () => {
    const history = [
      entry('aaa', '2026-07-20T00:00:00.000Z', 24, { findings: { depVulnsHigh: 6 } }),
      entry('bbb', '2026-08-03T00:00:00.000Z', 24, { findings: { depVulnsHigh: 3 } }),
    ];
    const out = captureConsole(() => runReportTrend({ cwd: mkCwd(), readHistory: () => history }));
    expect(out).toContain('dep-high');
    expect(out).toContain('6 -> 3 (-3)');
    // A series no entry measures stays absent.
    expect(out).not.toContain('testgaps');
  });

  it('the debt-over-time section renders when the series is present, gaps disclosed (4.4.7)', () => {
    const debt = {
      secret: { critical: 0, high: 0, medium: 0, low: 0 },
      code: { critical: 0, high: 2, medium: 5, low: 0 },
      'dep-vuln': { critical: 1, high: 3, medium: 0, low: 0 },
    };
    const history = [
      entry('aaa', '2026-07-20T00:00:00.000Z', 24), // pre-debt snapshot
      entry('bbb', '2026-08-03T00:00:00.000Z', 24, { debt }),
    ];
    const out = captureConsole(() => runReportTrend({ cwd: mkCwd(), readHistory: () => history }));
    expect(out).toContain('debt over time (counts by kind)');
    expect(out).toContain('dep-vuln');
    expect(out).toContain('chart as gaps, not zero');
    // A history with no debt stamps renders no debt section at all.
    const bare = captureConsole(() =>
      runReportTrend({ cwd: mkCwd(), readHistory: () => [history[0]] }),
    );
    expect(bare).not.toContain('debt over time');
  });

  it('empty history => honest "no trend yet" with the remedy, exit 0', () => {
    const out = captureConsole(() => {
      expect(runReportTrend({ cwd: mkCwd(), readHistory: () => [] })).toBe(0);
    });
    expect(out).toContain('No snapshots');
    expect(out).toContain('report snapshot');
    expect(out).toContain('reports.onMerge');
  });

  it('malformed JSONL lines are tolerated through the one parser', () => {
    const jsonl =
      serializeHistory([entry('aaa', '2026-07-20T00:00:00.000Z', 24)]) +
      'not json at all\n' +
      '{"sha":"missing-scores"}\n' +
      serializeHistory([entry('bbb', '2026-08-03T00:00:00.000Z', 26)]);
    const out = captureConsole(() =>
      runReportTrend({ cwd: mkCwd(), readHistory: () => parseHistory(jsonl) }),
    );
    expect(out).toContain('2 snapshot(s) since 2026-07-20');
    expect(out).toContain('up from 24');
  });
});

describe('report trend (--json)', () => {
  it('emits the segmented series with per-dimension arrays and the context', () => {
    const history = [
      entry('aaa', '2026-07-01T00:00:00.000Z', 20),
      entry('bbb', '2026-08-01T00:00:00.000Z', 40, { methodology: 'spec-v2' }),
    ];
    const raw = captureStdout(() =>
      runReportTrend({ cwd: mkCwd(), json: true, readHistory: () => history }),
    );
    const payload = JSON.parse(raw) as {
      anchorRef: string;
      snapshots: number;
      since?: string;
      segments: Array<{
        from: string;
        snapshots: number;
        methodology?: string;
        boundary?: string;
        scores: Record<string, Array<number | null>>;
      }>;
      context?: { sinceInstall: boolean; snapshots: number; totalSnapshots: number };
    };
    expect(payload.anchorRef).toBe('dxkit-reports');
    expect(payload.snapshots).toBe(2);
    expect(payload.since).toBe('2026-07-01T00:00:00.000Z');
    expect(payload.segments).toHaveLength(2);
    expect(payload.segments[0].methodology).toBe('spec-v1');
    expect(payload.segments[1].boundary).toContain('scoring methodology changed');
    expect(payload.segments[0].scores.overall).toEqual([20]);
    expect(payload.segments[1].scores.overall).toEqual([40]);
    expect(payload.context?.sinceInstall).toBe(false);
    expect(payload.context?.totalSnapshots).toBe(2);
  });

  it('carries the finding series arrays when present', () => {
    const history = [entry('aaa', '2026-07-20T00:00:00.000Z', 24, { findings: { testGaps: 5 } })];
    const raw = captureStdout(() =>
      runReportTrend({ cwd: mkCwd(), json: true, readHistory: () => history }),
    );
    const payload = JSON.parse(raw) as {
      segments: Array<{ findings?: Record<string, Array<number | null>> }>;
    };
    expect(payload.segments[0].findings?.testGaps).toEqual([5]);
  });

  it('carries the debt series (per-kind totals across the whole history) when present', () => {
    const history = [
      entry('aaa', '2026-07-20T00:00:00.000Z', 24),
      entry('bbb', '2026-08-03T00:00:00.000Z', 24, {
        debt: {
          secret: { critical: 0, high: 0, medium: 0, low: 0 },
          code: { critical: 0, high: 2, medium: 5, low: 0 },
          'dep-vuln': { critical: 1, high: 0, medium: 0, low: 0 },
        },
      }),
    ];
    const raw = captureStdout(() =>
      runReportTrend({ cwd: mkCwd(), json: true, readHistory: () => history }),
    );
    const payload = JSON.parse(raw) as { debt?: Record<string, Array<number | null>> };
    // Unstamped snapshot => null (gap), stamped => the kind total.
    expect(payload.debt?.code).toEqual([null, 7]);
    expect(payload.debt?.['dep-vuln']).toEqual([null, 1]);
  });

  it('empty history => zero snapshots, empty segments, no context', () => {
    const raw = captureStdout(() =>
      runReportTrend({ cwd: mkCwd(), json: true, readHistory: () => [] }),
    );
    const payload = JSON.parse(raw) as {
      snapshots: number;
      segments: unknown[];
      context?: unknown;
    };
    expect(payload.snapshots).toBe(0);
    expect(payload.segments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});
