/**
 * Probe run by `git-env-isolation.test.ts` in a child vitest process whose
 * environment carries a hook's GIT_DIR. It does what ordinary fixture tests
 * do: `git init` and commit in a fresh temp directory with the inherited
 * environment. With the suite setup in place the commit lands in the temp
 * repo; without it, it lands in whatever repository GIT_DIR names.
 */
import { it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

it('commits in a fresh temp repo with the inherited environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-git-env-probe-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'probe');
  git('config', 'user.email', 'probe@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'probe commit');
});
