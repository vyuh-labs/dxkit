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

  it('maps a missing/unmeasured dimension to null', () => {
    const e = reportToHistoryEntry(
      { summary: { overallScore: null }, dimensions: { security: { score: 90 } } },
      { sha: 'x', date: 'd', dxkitVersion: '3.0.0' },
    );
    expect(e.scores.overall).toBeNull();
    expect(e.scores.security).toBe(90);
    expect(e.scores.quality).toBeNull();
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
});
