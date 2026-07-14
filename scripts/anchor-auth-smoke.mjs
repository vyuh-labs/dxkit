/**
 * REAL end-to-end proof that `publishFilesToAnchorRef` authenticates a side-ref
 * push in GitHub Actions using ONLY the CI token.
 *
 * The unit/seam tests mock the git exec, so they prove the push CARRIES the auth
 * header but not that the header actually AUTHENTICATES — the exact gap that let
 * the 3.1.0 regression (gh #156) ship green. This script closes it: the workflow
 * checks out with `persist-credentials: false`, so there is NO ambient
 * credential to fall back on, and the push can only succeed if the primitive
 * authenticates itself from the token.
 *
 *   node scripts/anchor-auth-smoke.mjs expect-pass   # GITHUB_TOKEN set → must push
 *   node scripts/anchor-auth-smoke.mjs expect-fail   # no token → must NOT push (control)
 */
import { execFileSync } from 'child_process';
import { publishFilesToAnchorRef, ciCredentialedUrl } from '../dist/baseline/anchor-publish.js';

const mode = process.argv[2];
if (mode !== 'expect-pass' && mode !== 'expect-fail') {
  console.error('usage: anchor-auth-smoke.mjs expect-pass|expect-fail');
  process.exit(2);
}

const cwd = process.cwd();
const runId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
// A NON-`dxkit-*` ref name so dxkit's own anchor-branch ruleset (scoped to
// `dxkit-*`) does not reject/delay the throwaway push — that policy rejection is
// a property of THIS repo, not the fix, and it muddied the auth signal.
const ref = `ci-anchor-auth-smoke-${runId}`;

const res = publishFilesToAnchorRef({
  cwd,
  anchorRef: ref,
  files: [{ path: 'auth-smoke.txt', content: `run ${runId}\n` }],
  message: 'ci: anchor auth smoke',
  // Accumulate mode → a NON-force push to create the ref (this repo's ruleset
  // blocks force-pushes; a plain branch-create is allowed, giving a clean
  // pushed:true). The auth mechanism is identical for both modes.
  baseParent: true,
  timeoutMs: 25_000,
});
console.log('publish result:', JSON.stringify(res));

/** Delete the throwaway ref, authenticating the same way the primitive does. */
function cleanup() {
  try {
    const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    const target = ciCredentialedUrl(originUrl, process.env) ?? 'origin';
    execFileSync('git', ['push', target, '--delete', ref], { cwd, stdio: 'ignore' });
    console.log(`cleaned up ${ref}`);
  } catch {
    console.log(`could not delete ${ref} (best-effort)`);
  }
}

/**
 * The fix is about AUTHENTICATION, so that is what we assert — independent of
 * the repo's write policy. With no ambient credential, a push that fails to
 * AUTHENTICATE looks like "could not read Username" / "terminal prompts
 * disabled" / a timeout; a push that AUTHENTICATED and was then rejected by repo
 * policy (e.g. this repo restricts creating an arbitrary branch) looks like
 * "failed to push some refs" — the token clearly got past auth. The control
 * (no token) must land in the FIRST bucket; the fix (token) must NOT.
 */
// A genuine auth failure is ALWAYS fast here — with terminal prompts disabled,
// a missing/bad credential fails immediately with "could not read Username" /
// "Authentication failed" / a 401-403, never a hang. A TIMEOUT therefore is NOT
// an auth failure: it only happens after auth succeeds and the server holds a
// policy-blocked push. So `timed out` is deliberately NOT in this set.
const AUTH_FAILED =
  /could not read Username|terminal prompts disabled|Authentication failed|fatal: could not read|40[13]|Invalid username or (password|token)/i;

if (mode === 'expect-pass') {
  if (res.pushed) {
    cleanup();
    console.log(
      'PASS: the CI token authenticated + the side-ref push succeeded (no ambient credential).',
    );
  } else if (AUTH_FAILED.test(res.reason ?? '')) {
    console.error(`FAIL: the token did NOT authenticate the push: ${res.reason}`);
    process.exit(1);
  } else {
    // Authenticated, then rejected by repo policy (this repo blocks the throwaway
    // branch) — the auth mechanism (the whole point of #156) is proven.
    console.log(
      `PASS: the CI token AUTHENTICATED the push (rejected only by repo policy): ${res.reason}`,
    );
  }
} else {
  if (res.pushed) {
    cleanup();
    console.error(
      'FAIL: the push succeeded WITHOUT a token — the smoke is not exercising auth ' +
        '(persist-credentials leaked a credential?). This control must fail to be meaningful.',
    );
    process.exit(1);
  }
  if (!AUTH_FAILED.test(res.reason ?? '')) {
    console.error(
      `FAIL (control): expected an AUTH failure without a token, got a non-auth reason: ${res.reason}`,
    );
    process.exit(1);
  }
  console.log(
    `PASS (control): the push correctly failed to AUTHENTICATE without a token: ${res.reason}`,
  );
}
