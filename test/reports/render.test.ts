import { describe, it, expect } from 'vitest';
import { deltaToken, renderHistoryMarkdown, renderTrendText } from '../../src/reports/render';
import { renderImpactReportMarkdown } from '../../src/reports/impact-report';
import type { ReportHistoryEntry, ReportScores } from '../../src/reports/history';

const baseScores: ReportScores = {
  overall: 70,
  security: 80,
  quality: 60,
  tests: 50,
  documentation: 40,
  maintainability: 65,
  developerExperience: 75,
};

function entry(
  sha: string,
  patch: Partial<ReportScores> = {},
  date = '2026-07-01',
): ReportHistoryEntry {
  return {
    sha,
    date: `${date}T00:00:00.000Z`,
    dxkitVersion: '3.0.0',
    branch: 'main',
    scores: { ...baseScores, ...patch },
  };
}

describe('deltaToken', () => {
  it('renders up / down / flat / none', () => {
    expect(deltaToken(3)).toBe('▲3');
    expect(deltaToken(-2)).toBe('▼2');
    expect(deltaToken(0)).toBe('=');
    expect(deltaToken(null)).toBe('');
  });
});

describe('renderHistoryMarkdown', () => {
  it('handles empty history without throwing', () => {
    const md = renderHistoryMarkdown([]);
    expect(md).toContain('No report snapshots');
    expect(md).toContain('dxkit-reports');
  });

  it('a single snapshot shows the current overall, no movement', () => {
    const md = renderHistoryMarkdown([entry('a')]);
    expect(md).toContain('Overall health: **70**');
    // no "X → Y" arrow when there is no prior
    expect(md).not.toMatch(/70 → 70/);
  });

  it('two snapshots print the overall movement + per-dimension deltas', () => {
    const md = renderHistoryMarkdown([
      entry('a', { overall: 70, security: 80 }, '2026-07-01'),
      entry('b', { overall: 74, security: 78 }, '2026-07-02'),
    ]);
    // headline: overall moved 70 → 74 (▲4)
    expect(md).toContain('Overall health: **70 → 74** (▲4)');
    // per-dimension row: security dropped 2
    expect(md).toMatch(/\| Security \| 80 \| 78 \| ▼2 \|/);
    // the recent-snapshots details block lists both commits
    expect(md).toContain('Recent snapshots');
    expect(md).toContain('`a`'.slice(0, 3)); // commit column present
  });

  it('an unmeasured dimension shows a dash delta, never a fabricated number', () => {
    const md = renderHistoryMarkdown([
      entry('a', { documentation: 40 }),
      entry('b', { documentation: null }),
    ]);
    // documentation went 40 → — with no numeric delta
    expect(md).toMatch(/\| Docs \| 40 \| — \| — \|/);
  });

  it('respects the limit for the recent-snapshots table', () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry(`c${i}`, { overall: 60 + i }, `2026-07-${String(i + 1).padStart(2, '0')}`),
    );
    const md = renderHistoryMarkdown(entries, { limit: 3 });
    // only the last 3 commit shas appear in the details table
    expect(md).toContain('`c14');
    expect(md).toContain('`c13');
    expect(md).toContain('`c12');
    expect(md).not.toContain('`c11');
  });
});

describe('renderTrendText', () => {
  it('is empty for no history', () => {
    expect(renderTrendText([])).toEqual([]);
  });

  it('names only the dimensions that moved', () => {
    const lines = renderTrendText([
      entry('a', { overall: 70, security: 80, quality: 60 }),
      entry('b', { overall: 72, security: 80, quality: 55 }),
    ]);
    const joined = lines.join('\n');
    expect(joined).toContain('Overall health: 70 → 72 (▲2)');
    expect(joined).toContain('moved:');
    expect(joined).toContain('quality ▼5');
    // security did not move → not listed in the moved line
    expect(joined).not.toContain('security');
  });

  it('says nothing moved when scores are identical', () => {
    const lines = renderTrendText([entry('a'), entry('b')]);
    expect(lines.join('\n')).toContain('no dimension moved');
  });
});

describe('latest-pair comparability parity (the #332 cross-version blip, all three consumers)', () => {
  // The 0 -> 20 pair across a scoring-methodology bump: NO consumer of the
  // latest-pair delta may claim movement across it, and each must name the
  // boundary. renderHistoryMarkdown feeds the refresh workflow's job
  // summary, renderTrendText feeds `metrics`, and the impact report is the
  // published page: one boundary predicate, three surfaces, same story.
  const acrossBoundary = [
    entry('aaaa', { overall: 0 }, '2026-07-01'),
    { ...entry('bbbb', { overall: 20 }, '2026-08-01'), methodology: 'spec-v2' },
  ];

  it('renderHistoryMarkdown suppresses the delta and names the boundary', () => {
    const md = renderHistoryMarkdown(acrossBoundary);
    expect(md).not.toContain('▲20');
    expect(md).not.toContain('0 → 20');
    expect(md).toContain('previous snapshot not comparable');
    expect(md).toContain('scoring methodology changed');
    // The per-dimension table shows no Previous side either.
    expect(md).toContain('| Overall | — | 20 |');
  });

  it('renderTrendText (the metrics surface) suppresses the movement lines too', () => {
    const lines = renderTrendText(acrossBoundary).join('\n');
    expect(lines).not.toContain('▲');
    expect(lines).not.toContain('moved:');
    expect(lines).toContain('previous snapshot not comparable');
  });

  it('the impact report agrees (no movement claim, boundary named)', () => {
    const md = renderImpactReportMarkdown(acrossBoundary);
    expect(md).not.toContain('0 to 20');
    expect(md).toContain('not comparable to the previous snapshot');
  });

  it('a comparable pair still renders its movement everywhere (no over-suppression)', () => {
    const comparable = [
      entry('aaaa', { overall: 10 }, '2026-07-01'),
      entry('bbbb', { overall: 20 }, '2026-08-01'),
    ];
    expect(renderHistoryMarkdown(comparable)).toContain('**10 → 20** (▲10)');
    expect(renderTrendText(comparable).join('\n')).toContain('10 → 20');
    expect(renderImpactReportMarkdown(comparable)).toContain('overall 10 to 20');
  });

  it('score-input drift between the last two entries suppresses the same way', () => {
    const drifted = [
      { ...entry('aaaa', { overall: 10 }, '2026-07-01'), scoreInputs: ['gitleaks', 'semgrep'] },
      { ...entry('bbbb', { overall: 20 }, '2026-08-01'), scoreInputs: ['semgrep'] },
    ];
    const md = renderHistoryMarkdown(drifted);
    expect(md).not.toContain('▲10');
    expect(md).toContain('tools behind the scores differ');
  });
});
