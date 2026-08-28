/**
 * The published impact report (`latest/impact.md`, 4.4.7): rendered from the
 * same trend core the CLI uses, deterministic for identical input, segmented
 * at comparability boundaries, debt gaps disclosed, and sanitized by
 * construction (counts and scores only, never a file path or finding title).
 */
import { describe, it, expect } from 'vitest';
import { renderImpactReportMarkdown, IMPACT_REPORT_PATH } from '../../src/reports/impact-report';
import type { ReportDebtCounts, ReportHistoryEntry } from '../../src/reports/history';

function entry(
  sha: string,
  date: string,
  overall: number | null,
  extra: Partial<ReportHistoryEntry> = {},
): ReportHistoryEntry {
  return {
    sha,
    date,
    dxkitVersion: '4.4.7',
    methodology: 'spec-v1',
    scoreInputs: ['gitleaks', 'semgrep'],
    scores: {
      overall,
      security: 40,
      quality: 60,
      tests: 55,
      documentation: null,
      maintainability: 70,
      developerExperience: 65,
    },
    ...extra,
  };
}

const DEBT: ReportDebtCounts = {
  secret: { critical: 1, high: 0, medium: 0, low: 0 },
  code: { critical: 0, high: 2, medium: 5, low: 0 },
  'dep-vuln': { critical: 0, high: 0, medium: 0, low: 0 },
};

describe('renderImpactReportMarkdown', () => {
  it('empty history renders the honest empty state', () => {
    const md = renderImpactReportMarkdown([]);
    expect(md).toContain('# dxkit impact report');
    expect(md).toContain('No snapshots yet');
  });

  it('a flat series renders the trend table, the context line, and the latest-merge movement', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaabbbbccccdddd', '2026-07-20T00:00:00.000Z', 24),
      entry('bbbbccccddddeeee', '2026-07-27T00:00:00.000Z', 24),
    ]);
    expect(md).toContain('## Score trend');
    expect(md).toContain('since the first snapshot on record');
    expect(md).toContain('Repo trend: overall 24, flat since 2026-07-20 (2 snapshots)');
    expect(md).toContain('Latest merge `bbbbccccdddd`: overall 24 to 24 (=)');
    expect(md).toContain('no dimension moved');
    // The unmeasured dimension is named, never silently dropped or zeroed.
    expect(md).toContain('Unmeasured in this window: docs');
  });

  it('a rising series shows the movement in the latest-merge line and the delta column', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaabbbbccccdddd', '2026-07-20T00:00:00.000Z', 24, {
        scores: {
          overall: 24,
          security: 40,
          quality: 60,
          tests: 55,
          documentation: null,
          maintainability: 70,
          developerExperience: 65,
        },
      }),
      entry('bbbbccccddddeeee', '2026-07-27T00:00:00.000Z', 30, {
        scores: {
          overall: 30,
          security: 46,
          quality: 60,
          tests: 55,
          documentation: null,
          maintainability: 70,
          developerExperience: 65,
        },
      }),
    ]);
    expect(md).toContain('overall 24 to 30 (▲6)');
    expect(md).toContain('security 40 to 46');
    expect(md).toContain('▲6');
  });

  it('segments at a comparability boundary and never diffs across it', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaa000000000000', '2026-07-01T00:00:00.000Z', 0),
      entry('bbbb000000000000', '2026-08-01T00:00:00.000Z', 20, { methodology: 'spec-v2' }),
    ]);
    expect(md).toContain('Comparability boundary: scoring methodology changed');
    expect(md).toContain('### Segment 1');
    expect(md).toContain('### Segment 2');
    // The 0 -> 20 cross-version blip must NOT read as movement.
    expect(md).not.toContain('0 to 20');
    expect(md).toContain('Latest merge is not comparable to the previous snapshot');
  });

  it('renders the debt series with gaps for unstamped snapshots, plus the latest severity breakdown', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaa000000000000', '2026-07-20T00:00:00.000Z', 24), // pre-debt line
      entry('bbbb000000000000', '2026-07-27T00:00:00.000Z', 24, { debt: DEBT }),
      entry('cccc000000000000', '2026-08-03T00:00:00.000Z', 24, {
        debt: {
          ...DEBT,
          code: { critical: 0, high: 1, medium: 5, low: 0 },
        },
      }),
    ]);
    expect(md).toContain('## Debt over time');
    // code: gap, 7, 6 -> first 7, latest 6, delta down 1.
    expect(md).toContain('| code |');
    expect(md).toContain('▼1');
    expect(md).toContain('chart as gaps, not zero');
    expect(md).toContain('Latest severity breakdown:');
    expect(md).toContain('| secret | 1 | 0 | 0 | 0 |');
    // A kind at zero charts as zero (measured), not omitted.
    expect(md).toContain('| dep-vuln | 0 | 0 | 0 | 0 |');
  });

  it('a series with no debt stamps discloses the missing-data story', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaa000000000000', '2026-07-20T00:00:00.000Z', 24),
    ]);
    expect(md).toContain('No debt series yet');
    expect(md).toContain('predate the per-kind debt counts');
  });

  it('is deterministic for identical input (no clocks, no environment)', () => {
    const entries = [
      entry('aaaa000000000000', '2026-07-20T00:00:00.000Z', 24, { debt: DEBT }),
      entry('bbbb000000000000', '2026-07-27T00:00:00.000Z', 26, { debt: DEBT }),
    ];
    expect(renderImpactReportMarkdown(entries)).toBe(renderImpactReportMarkdown(entries));
  });

  it('is sanitized by construction: no file paths, no finding titles, counts and scores only', () => {
    const md = renderImpactReportMarkdown([
      entry('aaaa000000000000', '2026-07-20T00:00:00.000Z', 24, { debt: DEBT }),
      entry('bbbb000000000000', '2026-07-27T00:00:00.000Z', 26, { debt: DEBT }),
    ]);
    // Nothing path-shaped (src/foo/bar.ts, a/b.py, ...) may appear: the
    // input schema carries no locations, and the renderer must not invent
    // any.
    expect(md).not.toMatch(/\b[\w.-]+\/[\w.-]+\.(ts|js|py|go|rb|java|cs|php)\b/);
    // No secret-shaped content can exist either: the only free-form strings
    // are kind names, dates, shas, and dxkit's own phrasing.
    expect(md).not.toMatch(/password|api[_-]?key|token=/i);
    expect(md).toContain('Counts and scores only');
  });

  it('exports the anchor path constant the publisher writes to', () => {
    expect(IMPACT_REPORT_PATH).toBe('latest/impact.md');
  });
});
