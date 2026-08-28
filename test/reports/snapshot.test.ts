import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  reportToHistoryEntry,
  publishReportSnapshot,
  readReportHistory,
  type SnapshotSource,
} from '../../src/reports/snapshot';
import { SCORING_METHODOLOGY_VERSION } from '../../src/scoring/methodology';
import { describeScoreInputsDrift, scoreToolInputs } from '../../src/reports/snapshot';

describe('score-input comparability primitives (Rule 19 cause 5)', () => {
  it('scoreToolInputs sorts, dedupes, and strips unavailable reasons', () => {
    expect(
      scoreToolInputs({
        toolsUsed: ['semgrep', 'semgrep', ' cloc '],
        toolsUnavailable: ['jscpd (timed out after 120s)', 'gitleaks'],
      }),
    ).toEqual(['!gitleaks', '!jscpd', 'cloc', 'semgrep']);
    expect(scoreToolInputs({})).toEqual([]);
  });

  it('describeScoreInputsDrift names movement both directions, null on match or unstamped', () => {
    expect(describeScoreInputsDrift(['a', 'b'], ['a', 'b'])).toBeNull();
    expect(describeScoreInputsDrift(undefined, ['a'])).toBeNull();
    expect(describeScoreInputsDrift(['a'], undefined)).toBeNull();
    const drift = describeScoreInputsDrift(['gitleaks', 'semgrep'], ['grep-secrets', 'semgrep']);
    expect(drift).toContain('at the base but not now: gitleaks');
    expect(drift).toContain('now but not at the base: grep-secrets');
  });
});

const source: SnapshotSource = {
  summary: { overallScore: 72 },
  dimensions: {
    security: { score: 90 },
    quality: { score: 60 },
    testing: { score: 55 },
    documentation: { score: 40 },
    maintainability: { score: 80 },
    developerExperience: { score: 70 },
  },
};

describe('reportToHistoryEntry', () => {
  it('maps summary + dimensions (testing → tests) into scores', () => {
    const e = reportToHistoryEntry(source, { sha: 'abc', date: 'd', dxkitVersion: '3.0.0' });
    expect(e.scores).toEqual({
      overall: 72,
      security: 90,
      quality: 60,
      tests: 55,
      documentation: 40,
      maintainability: 80,
      developerExperience: 70,
    });
    expect(e.sha).toBe('abc');
  });

  it('stamps the scoring-methodology identity on every entry (impact P2)', () => {
    const e = reportToHistoryEntry(source, { sha: 'abc', date: 'd', dxkitVersion: '4.4.7' });
    expect(e.methodology).toBe(SCORING_METHODOLOGY_VERSION);
  });

  it('stamps the normalized score inputs (used tools + !unavailable, reasons stripped)', () => {
    const e = reportToHistoryEntry(
      {
        ...source,
        toolsUsed: ['semgrep', 'grep-secrets', 'cloc'],
        toolsUnavailable: ['gitleaks (not installed on this runner)'],
      },
      { sha: 'abc', date: 'd', dxkitVersion: '4.4.7' },
    );
    expect(e.scoreInputs).toEqual(['!gitleaks', 'cloc', 'grep-secrets', 'semgrep']);
  });

  it('maps a missing/unmeasured dimension to null', () => {
    const e = reportToHistoryEntry(
      { summary: { overallScore: null }, dimensions: { security: { score: 90 } } },
      { sha: 'x', date: 'd', dxkitVersion: '3.0.0' },
    );
    expect(e.scores.overall).toBeNull();
    expect(e.scores.security).toBe(90);
    expect(e.scores.quality).toBeNull();
  });

  it('stamps the debt-over-time counts from the canonical aggregate buckets (4.4.7), zero as zero', () => {
    const e = reportToHistoryEntry(
      {
        ...source,
        capabilities: {
          securityAggregate: {
            secretsBySeverity: { critical: 2, high: 0, medium: 0, low: 0 },
            codeBySeverity: { critical: 0, high: 3, medium: 7, low: 1 },
            depBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
          },
        },
      },
      { sha: 'abc', date: 'd', dxkitVersion: '4.4.7' },
    );
    expect(e.debt).toEqual({
      secret: { critical: 2, high: 0, medium: 0, low: 0 },
      code: { critical: 0, high: 3, medium: 7, low: 1 },
      // Zero debt is stamped as zero: distinguishable from an unmeasured
      // (absent) stamp.
      'dep-vuln': { critical: 0, high: 0, medium: 0, low: 0 },
    });
  });

  it('a run with no aggregate stamps NO debt (unmeasured, never fabricated zero)', () => {
    const e = reportToHistoryEntry(source, { sha: 'abc', date: 'd', dxkitVersion: '4.4.7' });
    expect(e.debt).toBeUndefined();
  });
});

describe('publishReportSnapshot', () => {
  let bare: string;
  let repo: string;
  function git(cwd: string, ...a: string[]): string {
    return execFileSync('git', a, { cwd, encoding: 'utf8' }).toString();
  }
  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'dxkit-snap-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    repo = mkdtempSync(join(tmpdir(), 'dxkit-snap-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@e.com');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(bare, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('publishes history + latest/ artifacts, then reads history back', () => {
    const e = reportToHistoryEntry(source, { sha: 'sha1', date: 'd1', dxkitVersion: '3.0.0' });
    const res = publishReportSnapshot({
      cwd: repo,
      entry: e,
      artifacts: [{ path: 'dashboard.html', content: '<html>ok</html>' }],
    });
    expect(res.publish.pushed).toBe(true);
    expect(res.historyCount).toBe(1);
    expect(res.anchorRef).toBe('dxkit-reports');
    const history = readReportHistory(repo);
    expect(history).toHaveLength(1);
    expect(history[0].scores.overall).toBe(72);
    // The published impact report rides the same publish, rendered from the
    // folded history (retrieval path: latest/impact.md on the reports ref).
    const impactMd = git(bare, 'show', 'dxkit-reports:latest/impact.md');
    expect(impactMd).toContain('# dxkit impact report');
    expect(impactMd).toContain('sha1'.slice(0, 12));
  });

  it('accumulates across merges + retains only the most recent N', () => {
    for (const [i, sha] of ['a', 'b', 'c', 'd'].entries()) {
      publishReportSnapshot({
        cwd: repo,
        entry: reportToHistoryEntry(
          { ...source, summary: { overallScore: 50 + i } },
          { sha, date: `d${i}`, dxkitVersion: '3.0.0' },
        ),
        retainHistory: 2,
      });
    }
    const history = readReportHistory(repo);
    expect(history.map((h) => h.sha)).toEqual(['c', 'd']);
  });

  it('returns the previous entry (the base the org saw) for the landed update', () => {
    const first = publishReportSnapshot({
      cwd: repo,
      entry: reportToHistoryEntry(source, { sha: 'sha1', date: 'd1', dxkitVersion: '3.0.0' }),
    });
    expect(first.previousEntry).toBeUndefined();
    const second = publishReportSnapshot({
      cwd: repo,
      entry: reportToHistoryEntry(source, { sha: 'sha2', date: 'd2', dxkitVersion: '3.0.0' }),
    });
    expect(second.previousEntry?.sha).toBe('sha1');
    // An idempotent re-publish of the same SHA compares against the entry
    // BEFORE it, never against itself.
    const replay = publishReportSnapshot({
      cwd: repo,
      entry: reportToHistoryEntry(source, { sha: 'sha2', date: 'd2b', dxkitVersion: '3.0.0' }),
    });
    expect(replay.previousEntry?.sha).toBe('sha1');
  });

  it('re-publishing the same merge SHA replaces (idempotent), no dup line', () => {
    const mk = (over: number) =>
      reportToHistoryEntry(
        { ...source, summary: { overallScore: over } },
        { sha: 'same', date: 'd', dxkitVersion: '3.0.0' },
      );
    publishReportSnapshot({ cwd: repo, entry: mk(50) });
    publishReportSnapshot({ cwd: repo, entry: mk(80) });
    const history = readReportHistory(repo);
    expect(history).toHaveLength(1);
    expect(history[0].scores.overall).toBe(80);
  });

  it('NEVER mutates the default branch — tree, tip, and working tree untouched', () => {
    // The whole point of a side ref: the publish writes report-history.jsonl +
    // latest/ onto `dxkit-reports` via a temp index + git plumbing, so the
    // checked-out default branch must be byte-identical afterward. This is the
    // safety invariant that makes the on-merge workflow safe to run on a
    // protected branch's merge event.
    const treeBefore = git(repo, 'rev-parse', 'main^{tree}').trim();
    const tipBefore = git(repo, 'rev-parse', 'main').trim();

    const res = publishReportSnapshot({
      cwd: repo,
      entry: reportToHistoryEntry(source, { sha: 's', date: 'd', dxkitVersion: '3.0.0' }),
      artifacts: [{ path: 'dashboard.html', content: '<html>ok</html>' }],
    });
    expect(res.publish.pushed).toBe(true);

    // main is unchanged: same tree object, same commit tip.
    expect(git(repo, 'rev-parse', 'main^{tree}').trim()).toBe(treeBefore);
    expect(git(repo, 'rev-parse', 'main').trim()).toBe(tipBefore);
    // The report artifacts exist on the side ref, NOT on the default branch.
    git(repo, 'fetch', '-q', 'origin', 'dxkit-reports');
    expect(git(repo, 'cat-file', '-e', 'origin/dxkit-reports:report-history.jsonl')).toBeDefined();
    expect(() => git(repo, 'cat-file', '-e', 'main:report-history.jsonl')).toThrow();
    // The plumbing publish never wrote into the working tree.
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });
});
