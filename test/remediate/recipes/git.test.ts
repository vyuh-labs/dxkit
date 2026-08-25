/**
 * realRecipeGit against a real temp repository: changed-path reporting
 * (modified, untracked), path-scoped discard (tracked restored, untracked
 * removed, everything else untouched), and path-scoped commits under the
 * bot identity.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { realRecipeGit } from '../../../src/remediate/recipes/git';

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-recipe-git-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'keep\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

describe('realRecipeGit', () => {
  it('reports modified + untracked paths, discards only what it is told, commits only what it is told', () => {
    const dir = initRepo();
    const g = realRecipeGit(dir);
    expect(g.changedPaths()).toEqual([]);

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'recipe edit\n');
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'sprawl\n');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'user edit\n');
    expect(g.changedPaths().sort()).toEqual(['other.txt', 'stray.txt', 'tracked.txt']);

    // Discard the recipe's stray + tracked edit; the user's edit survives.
    g.discardPaths(['stray.txt', 'tracked.txt']);
    expect(fs.existsSync(path.join(dir, 'stray.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8')).toBe('user edit\n');

    // Commit only the named path; the user's dirt stays uncommitted.
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'fixed\n');
    g.commitPaths(['tracked.txt'], 'fix(test): one order');
    expect(g.changedPaths()).toEqual(['other.txt']);
    const log = execFileSync('git', ['log', '-1', '--format=%s %an'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(log).toContain('fix(test): one order');
  });

  it('reports a non-ASCII path unescaped (git otherwise C-quotes it, and an escaped name matches no envelope)', () => {
    const dir = initRepo();
    const g = realRecipeGit(dir);
    fs.writeFileSync(path.join(dir, 'sträy.txt'), 'x\n');
    expect(g.changedPaths()).toEqual(['sträy.txt']);
    g.discardPaths(['sträy.txt']);
    expect(fs.existsSync(path.join(dir, 'sträy.txt'))).toBe(false);
    expect(g.changedPaths()).toEqual([]);
  });
});
