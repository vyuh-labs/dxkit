/**
 * Unit tests for the `vyuh-dxkit hooks activate` core function.
 * Exercises the activation outcomes against a freshly-`git init`'d
 * tempdir so the side-effect (writing core.hooksPath to .git/config)
 * is isolated per-test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { activateHooks } from '../src/hooks-cli';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-hooks-activate-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(cwd: string) {
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
}

function readHooksPath(cwd: string): string {
  try {
    return execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

describe('activateHooks', () => {
  it('returns not-a-git-repo when cwd has no .git/ directory', () => {
    const result = activateHooks(tmp);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('not-a-git-repo');
  });

  it('sets core.hooksPath to .githooks on a fresh git repo', () => {
    gitInit(tmp);
    const result = activateHooks(tmp);
    expect(result.activated).toBe(true);
    expect(readHooksPath(tmp)).toBe('.githooks');
  });

  it('is idempotent — second call short-circuits as already-set-correctly', () => {
    gitInit(tmp);
    activateHooks(tmp);
    const result = activateHooks(tmp);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('already-set-correctly');
    expect(result.previousValue).toBe('.githooks');
  });

  it('refuses to clobber a custom hooksPath (e.g. husky)', () => {
    gitInit(tmp);
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.husky'], {
      cwd: tmp,
      stdio: 'ignore',
    });
    const result = activateHooks(tmp);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('already-set-elsewhere');
    expect(result.previousValue).toBe('.husky');
    // Custom value preserved.
    expect(readHooksPath(tmp)).toBe('.husky');
  });
});
