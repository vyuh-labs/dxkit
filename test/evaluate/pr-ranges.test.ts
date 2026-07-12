import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { enumerateLandings, prNumberFromSubject } from '../../src/evaluate/pr-ranges';

const tmps: string[] = [];
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-evalranges-'));
  tmps.push(d);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t.co');
  git(d, 'config', 'user.name', 't');
  return d;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function commit(cwd: string, file: string, content: string, subject: string): string {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
  return git(cwd, 'rev-parse', 'HEAD');
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('prNumberFromSubject', () => {
  it('parses merge-commit and squash-suffix markers, and nothing else', () => {
    expect(prNumberFromSubject('Merge pull request #42 from org/feat')).toBe(42);
    expect(prNumberFromSubject('feat: add the gate (#137)')).toBe(137);
    expect(prNumberFromSubject('feat: mention (#7) mid-subject')).toBeUndefined();
    expect(prNumberFromSubject('plain subject')).toBeUndefined();
  });
});

describe('enumerateLandings', () => {
  it('pairs each first-parent landing with its base across merge strategies', () => {
    const d = mkRepo();
    const root = commit(d, 'a.txt', '1', 'root');
    const squash = commit(d, 'a.txt', '2', 'feat: squash-landed change (#12)');
    // A real merge: branch from the squash commit, then merge back.
    git(d, 'checkout', '-q', '-b', 'feat');
    const featTip = commit(d, 'b.txt', 'x', 'feat work');
    git(d, 'checkout', '-q', 'main');
    git(d, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #13 from org/feat', 'feat');
    const mergeSha = git(d, 'rev-parse', 'HEAD');

    const landings = enumerateLandings(d, 10);
    // Newest first: the merge, the squash, then the root (skipped: no parent).
    expect(landings).toHaveLength(2);
    expect(landings[0]).toMatchObject({
      headSha: mergeSha,
      baseSha: squash,
      prNumber: 13,
    });
    expect(landings[1]).toMatchObject({ headSha: squash, baseSha: root, prNumber: 12 });
    // First-parent discipline: the merge's base is main's tip, never the branch tip.
    expect(landings[0].baseSha).not.toBe(featTip);
  });

  it('honors the count limit', () => {
    const d = mkRepo();
    commit(d, 'a.txt', '1', 'root');
    commit(d, 'a.txt', '2', 'second');
    commit(d, 'a.txt', '3', 'third');
    expect(enumerateLandings(d, 1)).toHaveLength(1);
  });

  it('throws on a non-repo so the CLI can surface the message', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-evalranges-'));
    tmps.push(d);
    expect(() => enumerateLandings(d, 5)).toThrow();
  });
});
