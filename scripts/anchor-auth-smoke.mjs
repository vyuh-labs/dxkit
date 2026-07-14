/**
 * REAL end-to-end proof that `publishFilesToAnchorRef`'s side-ref push does NOT
 * fire the repo's `pre-push` hook (gh #156 — the actual root cause).
 *
 * The regression: dxkit's internal machine push ran a plain `git push` in a
 * checkout where `core.hooksPath=.githooks` is active, so it fired dxkit's OWN
 * guardrail check as a pre-push hook; under the `execFileSync` timeout that hook
 * was SIGTERM'd mid-run → ETIMEDOUT, which four debug builds misread as an auth
 * failure. The fix is `--no-verify` on the internal push.
 *
 * This smoke is self-contained (a throwaway local repo — no token, no remote):
 * it wires a `pre-push` hook that BLOCKS any ordinary push (writes a sentinel +
 * exits 1), proves the hook really blocks a normal push, then asserts the
 * primitive still publishes (hook skipped) and the sentinel was never written.
 *
 *   node scripts/anchor-auth-smoke.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { publishFilesToAnchorRef } from '../dist/baseline/anchor-publish.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const base = mkdtempSync(join(tmpdir(), 'dxkit-hook-smoke-'));
const bare = join(base, 'origin.git');
const repo = join(base, 'checkout');
const hooks = join(base, 'hooks');
const sentinel = join(base, 'hook-fired');
let failed = false;
try {
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@dxkit');
  git(repo, 'config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'README.md'), '# smoke\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');

  // A pre-push hook that BLOCKS any ordinary push — the stand-in for dxkit's own
  // guardrail pre-push hook that caused the #156 timeout.
  mkdirSync(hooks);
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\necho blocked > "${sentinel}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  git(repo, 'config', 'core.hooksPath', hooks);

  // Sanity: an ORDINARY push MUST be blocked by the hook, or the test is meaningless.
  let ordinaryBlocked = false;
  try {
    execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/ordinary-probe'], {
      cwd: repo,
      stdio: 'ignore',
    });
  } catch {
    ordinaryBlocked = true;
  }
  if (!ordinaryBlocked) {
    console.error('SMOKE SETUP FAIL: the pre-push hook did not block an ordinary push.');
    process.exit(1);
  }
  if (existsSync(sentinel)) rmSync(sentinel); // reset before the real assertion

  // The primitive publish must SUCCEED (hook skipped via --no-verify) ...
  const res = publishFilesToAnchorRef({
    cwd: repo,
    anchorRef: 'dxkit-baselines',
    files: [{ path: 'baselines/main.json', content: '{}\n' }],
    message: 'smoke: hook-skip',
    baseParent: false,
  });
  if (!res.pushed) {
    console.error(`FAIL: the primitive push did not succeed (hook not skipped?): ${res.reason}`);
    failed = true;
  }
  // ... and the pre-push hook must NOT have fired.
  if (existsSync(sentinel)) {
    console.error('FAIL: the pre-push hook FIRED during the internal push (missing --no-verify).');
    failed = true;
  }
  if (!failed) {
    console.log(
      'PASS: the internal side-ref push skipped the pre-push hook and published (gh #156).',
    );
  }
} finally {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
process.exit(failed ? 1 : 0);
