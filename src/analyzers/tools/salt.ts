/**
 * Per-repo salt resolution for secret HMAC identity.
 *
 * The secret-HMAC scheme uses a salt that's:
 *   1. Consistent across `baseline create` (writes HMACs) and every
 *      subsequent `guardrail check` (reads them).
 *   2. Not stored in git — a baseline-file leak should not enable
 *      secret recovery via rainbow tables.
 *   3. Reachable from every consumer — single dev, multiple devs on
 *      one repo, CI, shallow clones, detached HEADs.
 *
 * A three-step waterfall satisfies all three:
 *
 *   1. `DXKIT_BASELINE_SALT` env var — opt-in override for teams
 *      who want stronger isolation than the deterministic default.
 *   2. `.dxkit/salt` file — reserved for environments where env-vars
 *      are awkward (cron jobs, embedded runners). Gitignored by
 *      default.
 *   3. Deterministic default — `HMAC("dxkit-baseline-salt-v1",
 *      initialCommitSha)`. Zero-setup; same across clones of the
 *      same repo; different across different repos; reachable in
 *      shallow clones (git always includes the root commit).
 *
 * Every baseline file records which mode produced it so the
 * matcher can either match the same mode (HMAC compare works) or
 * gracefully degrade to location-only matching when the salt is
 * unrecoverable on the current run.
 *
 * Home: the salt is one half of the HMAC key for `computeSecretHmac`
 * (the canonical secret-identity primitive in `fingerprint.ts`), so it
 * lives in the identity/tooling layer alongside it. That keeps the
 * dependency direction natural: `baseline/create.ts` (orchestration)
 * and the secret gather (`tools/gitleaks.ts`, `tools/grep-secrets.ts`)
 * both reach DOWN into this layer for it — no analyzer ever depends on
 * baseline. The content-anchored secret identity (D-G5) needs the salt
 * at the gather boundary, where the raw value is HMAC'd and dropped.
 */

import { execFileSync } from 'child_process';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Resolution path that produced the salt. Stamped on every baseline
 *  file so the guardrail check knows what the matcher needs. */
export type SaltMode = 'env-var' | 'file' | 'deterministic';

export interface ResolvedSalt {
  readonly mode: SaltMode;
  readonly salt: string;
}

/** Domain separator for the deterministic default. Bumping the
 *  suffix would invalidate every existing deterministic-mode
 *  baseline (consumers would compute different salts for the same
 *  commit). Treat it as a permanent identifier. */
const DETERMINISTIC_DOMAIN = 'dxkit-baseline-salt-v1';

/**
 * Resolve the salt for a repo. Pure dispatch over the three-step
 * waterfall; no I/O happens past the resolution step that succeeds.
 *
 * Throws when none of the three paths can produce a salt — typically
 * a non-git checkout with no env var set. Callers should surface the
 * message verbatim so users learn which mode to configure.
 */
export function resolveSalt(cwd: string): ResolvedSalt {
  const envSalt = process.env.DXKIT_BASELINE_SALT;
  if (envSalt && envSalt.length > 0) {
    return { mode: 'env-var', salt: envSalt };
  }

  const filePath = path.join(cwd, '.dxkit', 'salt');
  if (fs.existsSync(filePath)) {
    const fileSalt = fs.readFileSync(filePath, 'utf8').trim();
    if (fileSalt.length > 0) {
      return { mode: 'file', salt: fileSalt };
    }
  }

  try {
    const sha = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0];
    if (!sha) {
      throw new Error('git rev-list returned empty output');
    }
    const salt = createHmac('sha256', DETERMINISTIC_DOMAIN).update(sha).digest('hex');
    return { mode: 'deterministic', salt };
  } catch {
    throw new Error(
      'Cannot derive a baseline salt: not a git repository (or no root commit reachable). ' +
        'Set DXKIT_BASELINE_SALT or initialize a git repo before running baseline commands.',
    );
  }
}

/** Per-cwd memo for the fail-open analysis-path resolver. Holds the
 *  resolved salt or `null` (resolution failed) so a non-git directory
 *  doesn't re-run `git rev-list` once per secret gather. */
const saltCache = new Map<string, string | null>();

/**
 * Fail-open salt resolution for the analysis path (secret gather).
 *
 * Unlike `resolveSalt`, this NEVER throws: `baseline create` wants the
 * hard error when no salt is derivable, but a plain `health` /
 * `vulnerabilities` run on a non-git directory must still produce
 * findings — it simply forgoes the content-anchored secret identity and
 * falls back to the location-based scheme. Returns the salt string, or
 * `null` when no salt could be derived (caller leaves `contentAnchor`
 * unset and the identity layer falls back). Memoized per-cwd because the
 * secret gather runs gitleaks + grep-secrets, and both want the same
 * salt without a second `git rev-list`.
 */
export function tryResolveSalt(cwd: string): string | null {
  const cached = saltCache.get(cwd);
  if (cached !== undefined) return cached;
  let salt: string | null;
  try {
    salt = resolveSalt(cwd).salt;
  } catch {
    salt = null;
  }
  saltCache.set(cwd, salt);
  return salt;
}
