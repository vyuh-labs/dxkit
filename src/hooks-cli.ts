/**
 * CLI handler for `vyuh-dxkit hooks activate`.
 *
 * Idempotent activation of the dxkit hook directory. Designed to be
 * invoked from an `npm postinstall` script in the consumer's
 * package.json, so every clone + `npm install` automatically wires
 * `core.hooksPath` without per-dev manual setup.
 *
 * Always exits 0. A postinstall script that exits non-zero breaks
 * `npm install` for the whole repo, which is a worse failure than
 * "hooks didn't activate this run." If the repo isn't a git checkout
 * or `git` is missing, log a dim notice and return cleanly.
 */
import { execFileSync } from 'child_process';
import * as logger from './logger';

export interface ActivateHooksResult {
  /** True when `core.hooksPath` was set during this call. */
  activated: boolean;
  /** Why the call short-circuited; populated when `activated` is false. */
  reason?:
    | 'not-a-git-repo'
    | 'git-missing'
    | 'already-set-elsewhere'
    | 'already-set-correctly'
    | 'git-error';
  /** Value `core.hooksPath` held before any write attempt. */
  previousValue?: string;
}

/**
 * Pure-ish core: takes a cwd, returns a structured outcome. Side
 * effects are limited to invoking `git config` against the supplied
 * cwd. The CLI wrapper renders log output from the result.
 */
export function activateHooks(cwd: string): ActivateHooksResult {
  // Refuse to run outside a git worktree — `git config` would write
  // to the global config file instead, which is the worst kind of
  // surprise. `--is-inside-work-tree` returns "true" + exit 0 only
  // when cwd is inside a valid worktree.
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out !== 'true') {
      return { activated: false, reason: 'not-a-git-repo' };
    }
  } catch (err) {
    const msg = (err as { message?: string }).message ?? '';
    // ENOENT on the spawn means `git` itself isn't installed. Every
    // other error means cwd isn't a worktree (or .git is corrupted).
    if (msg.includes('ENOENT')) return { activated: false, reason: 'git-missing' };
    return { activated: false, reason: 'not-a-git-repo' };
  }

  // Read the current value (if any). `git config --get` exits 1 when
  // the key is unset — that's the happy path for a fresh clone.
  let previousValue: string | undefined;
  try {
    previousValue = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    previousValue = undefined;
  }

  if (previousValue === '.githooks') {
    return { activated: false, reason: 'already-set-correctly', previousValue };
  }

  if (previousValue && previousValue.length > 0) {
    // Don't clobber a custom hooksPath (husky, lefthook, personal
    // setup). The customer is on the hook for chaining if they want
    // both — same convention as `.dxkit` sidecars when an existing
    // hook is present.
    return { activated: false, reason: 'already-set-elsewhere', previousValue };
  }

  try {
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
      cwd,
      stdio: 'ignore',
    });
    return { activated: true };
  } catch {
    return { activated: false, reason: 'git-error' };
  }
}

/**
 * CLI wrapper. Renders a short status line and ALWAYS exits 0 so a
 * postinstall hook never aborts `npm install`.
 */
export function runHooksActivate(cwd: string): void {
  const result = activateHooks(cwd);
  if (result.activated) {
    logger.dim('dxkit hooks activated (core.hooksPath = .githooks)');
    return;
  }
  switch (result.reason) {
    case 'already-set-correctly':
      // Stay quiet on the steady-state path — every subsequent
      // `npm install` lands here, and noise compounds.
      return;
    case 'already-set-elsewhere':
      logger.dim(
        `dxkit hooks activation skipped: core.hooksPath already set to '${result.previousValue}'. ` +
          'Chain dxkit hooks by sourcing .githooks/<name> from your existing hook directory.',
      );
      return;
    case 'not-a-git-repo':
      logger.dim('dxkit hooks activation skipped: not inside a git working tree.');
      return;
    case 'git-missing':
      logger.dim('dxkit hooks activation skipped: git not on PATH.');
      return;
    default:
      logger.dim(
        'dxkit hooks activation skipped: git error (run `vyuh-dxkit doctor` to diagnose).',
      );
      return;
  }
}
