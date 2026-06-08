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

  // Git silently ignores a non-executable hook, so activation must
  // restore the bit or the guardrail never fires.
  it.skipIf(process.platform === 'win32')(
    'restores the executable bit on a non-executable hook',
    () => {
      gitInit(tmp);
      const hooksDir = path.join(tmp, '.githooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hook = path.join(hooksDir, 'pre-push');
      fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hook, 0o644); // committed-as-100644 reproduction
      expect(fs.statSync(hook).mode & 0o111).toBe(0);

      activateHooks(tmp);
      // Executable bit restored.
      expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores the bit even when hooksPath is already set (steady-state re-run)',
    () => {
      gitInit(tmp);
      const hooksDir = path.join(tmp, '.githooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hook = path.join(hooksDir, 'pre-push');
      fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
      activateHooks(tmp); // sets hooksPath + makes executable
      fs.chmodSync(hook, 0o644); // bit lost afterwards (e.g. re-checkout)

      const result = activateHooks(tmp);
      expect(result.reason).toBe('already-set-correctly');
      expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    },
  );
});
