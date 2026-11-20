/**
 * The suite must never write into a repository it inherited from its
 * caller's environment. A git hook exports GIT_DIR (an absolute path when
 * the hook runs in a linked worktree), and the pre-push hook runs this
 * suite: every fixture test that ran `git init` / `git commit` / `git
 * config` in a temp directory then wrote into the pushing repository
 * instead (commits on the checked-out branch, `core.bare=true` and a test
 * identity in its config). `test/vitest-setup.ts` clears the inherited
 * repository-location variables for every worker.
 *
 * The end-to-end case runs a probe test in a child vitest with GIT_DIR
 * pointing at a separate "victim" repository, through the real suite setup,
 * and asserts the victim is untouched. It fails without the setup fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { REPO_LOCAL_GIT_ENV, withoutInheritedGitEnv } from './git-env';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function victimRepo(): { dir: string; head: () => string; config: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-git-env-victim-'));
  dirs.push(dir);
  const env = withoutInheritedGitEnv(process.env);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.name=v',
    '-c',
    'user.email=v@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'victim',
  );
  return {
    dir,
    head: () => git('rev-parse', 'HEAD'),
    config: () => git('config', '--local', '--list'),
  };
}

describe('inherited git environment', () => {
  it('withoutInheritedGitEnv drops every repository-local variable and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'a' };
    for (const k of REPO_LOCAL_GIT_ENV) env[k] = `/somewhere/${k}`;
    const out = withoutInheritedGitEnv(env);
    for (const k of REPO_LOCAL_GIT_ENV) expect(out[k]).toBeUndefined();
    expect(out).toMatchObject({ PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'a' });
    // Pure: the input is not mutated.
    expect(env.GIT_DIR).toBe('/somewhere/GIT_DIR');
  });

  it('this worker carries no repository-local variable', () => {
    for (const k of REPO_LOCAL_GIT_ENV) expect(process.env[k]).toBeUndefined();
  });

  it('a fixture test run under a hook GIT_DIR never writes into that repository', () => {
    const victim = victimRepo();
    const before = { head: victim.head(), config: victim.config() };
    const cfgDir = mkdtempSync(join(tmpdir(), 'dxkit-git-env-cfg-'));
    dirs.push(cfgDir);
    const cfg = join(cfgDir, 'vitest.probe.mjs');
    writeFileSync(
      cfg,
      `export default { test: { root: ${JSON.stringify(ROOT)}, ` +
        `include: ['test/git-env/probe.ts'], ` +
        `setupFiles: ['test/vitest-setup.ts'] } };\n`,
    );
    execFileSync(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--config', cfg], {
      cwd: ROOT,
      env: { ...withoutInheritedGitEnv(process.env), GIT_DIR: join(victim.dir, '.git') },
      stdio: 'pipe',
      timeout: 120_000,
    });
    expect(victim.head()).toBe(before.head);
    expect(victim.config()).toBe(before.config);
  }, 150_000);
});
