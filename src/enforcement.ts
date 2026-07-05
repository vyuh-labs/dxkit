/**
 * Enforcement-path detection — the ONE place dxkit learns whether its guardrail
 * is actually ENFORCED on the default branch, as opposed to merely wired.
 *
 * The wiring (a `dxkit-guardrails.yml` on `pull_request`, a pre-push hook) can
 * be present and green while the real enforcement is zero: if the branch takes
 * direct pushes, or nothing requires the `dxkit-guardrails` check to pass, a PR
 * can merge — or a commit can land — without the guardrail ever blocking it.
 * `doctor` reads this to tell the truth instead of reporting a hollow "wired
 * end-to-end", and the baseline-refresh installer reads it to avoid shipping a
 * direct-push refresh workflow onto a protected branch (a guaranteed deadlock:
 * the push is rejected, and a `[skip ci]` commit can never earn the required
 * checks).
 *
 * Probing shells `gh api` for the branch's protection rule. It is fail-open at
 * every step — a missing / unauthenticated `gh`, no admin scope, or an error
 * yields `probed: false` (unknown), never a throw and never a false "enforced".
 * Results are cached per resolved cwd, mirroring `visibility.ts`.
 */

import * as path from 'path';
import { ghApi, ghCliAvailable, resolveDefaultBranch, GhError } from './setup-gh';

/** The guardrail status check dxkit installs + expects a protected branch to
 *  require. Kept in sync with `setup-branch-protection.ts`. */
export const GUARDRAIL_CHECK = 'dxkit-guardrails';

/** Minimal subset of GitHub's branch-protection payload dxkit reads. */
interface ProtectionPayload {
  required_status_checks?: { contexts?: string[] } | null;
  required_pull_request_reviews?: unknown | null;
  enforce_admins?: { enabled?: boolean } | boolean | null;
}

export interface EnforcementState {
  /** The branch probed (the repo's default branch). */
  readonly branch: string;
  /** Whether dxkit could get a definitive answer. `false` when `gh` is
   *  absent/unauthenticated or the protection read failed (no admin scope,
   *  network). Consumers must treat `false` as "unknown", never "unprotected". */
  readonly probed: boolean;
  /** Direct pushes to `branch` are blocked — a protection rule requires a PR
   *  and/or passing status checks, so a bare `git push` is rejected. */
  readonly directPushBlocked: boolean;
  /** The `dxkit-guardrails` check is a REQUIRED status check on `branch`, i.e.
   *  the guardrail actually gates merges rather than running informationally. */
  readonly guardrailRequired: boolean;
}

/**
 * Pure classifier: given a branch's protection payload (or `null` for "no rule")
 * and whether the probe succeeded, decide the enforcement facts. Exported for
 * direct unit testing without shelling to `gh`.
 */
export function classifyEnforcement(
  branch: string,
  payload: ProtectionPayload | null,
  probed: boolean,
): EnforcementState {
  if (!probed) {
    return { branch, probed: false, directPushBlocked: false, guardrailRequired: false };
  }
  const contexts = payload?.required_status_checks?.contexts ?? [];
  const requiresChecks = contexts.length > 0;
  const requiresPr = payload?.required_pull_request_reviews != null;
  return {
    branch,
    probed: true,
    // Either a required check or a required PR review forces changes through a
    // gate a raw push cannot satisfy — so a direct push is blocked.
    directPushBlocked: requiresChecks || requiresPr,
    guardrailRequired: contexts.includes(GUARDRAIL_CHECK),
  };
}

const CACHE = new Map<string, EnforcementState>();

/** Test seam — drop the per-cwd cache. */
export function clearEnforcementCache(): void {
  CACHE.clear();
}

/**
 * Probe how the default branch is protected. Cached per resolved cwd. Fail-open:
 * an inability to answer → `probed: false`. An injected `probe` (for tests)
 * bypasses `gh`; production shells `gh api .../branches/{branch}/protection`.
 */
export function detectEnforcement(
  cwd: string,
  opts: { probe?: (cwd: string, branch: string) => ProtectionPayload | null } = {},
): EnforcementState {
  const key = path.resolve(cwd);
  const cached = CACHE.get(key);
  if (cached) return cached;

  const probeFn =
    opts.probe ??
    ((c: string, branch: string): ProtectionPayload | null => {
      if (!ghCliAvailable()) throw new GhError('gh unavailable');
      try {
        return ghApi(`repos/{owner}/{repo}/branches/${branch}/protection`, {
          cwd: c,
          method: 'GET',
        }) as ProtectionPayload;
      } catch (e) {
        // 404 = no protection rule (a definitive "unprotected"); anything else
        // (403 no-admin, network) is genuinely unknown.
        if (e instanceof GhError && e.httpStatus === 404) return null;
        throw e;
      }
    });

  const branch = safeDefaultBranch(cwd);
  let state: EnforcementState;
  try {
    const payload = probeFn(cwd, branch);
    state = classifyEnforcement(branch, payload, true);
  } catch {
    state = classifyEnforcement(branch, null, false);
  }
  CACHE.set(key, state);
  return state;
}

/** Resolve the default branch without letting a gh failure escape. */
function safeDefaultBranch(cwd: string): string {
  try {
    return resolveDefaultBranch(cwd);
  } catch {
    return 'main';
  }
}
