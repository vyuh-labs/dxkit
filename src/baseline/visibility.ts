/**
 * Repo visibility detection — probes `gh repo view --json visibility`
 * to learn whether the current repo is public, private, or internal
 * (GitHub Enterprise's middle tier).
 *
 * # Why this module exists
 *
 * Baseline mode resolution (see `./modes.ts`) needs the answer to
 * "is this a public repo?" to pick the right default posture.
 * Public repos default to `ref-based` (no committed baseline,
 * zero disclosure); private repos default to `committed-full`.
 * Without a reliable visibility probe the picker can't be safe-
 * by-default.
 *
 * # Failure semantics
 *
 * Every failure path returns `'unknown'` rather than throwing.
 * Callers treat unknown the same way they treat private — the
 * safe default. Concrete failure modes:
 *
 *   - `gh` binary missing
 *   - `gh auth` not configured
 *   - Repo has no GitHub remote
 *   - Repo is on a non-GitHub host (GitLab, self-hosted)
 *   - Network failure / API throttling
 *   - Repo deleted or made inaccessible to the calling user
 *
 * None of these warrant a surprise switch to sanitized mode — a
 * customer's private repo shouldn't suddenly start writing
 * stripped baselines because `gh auth` lapsed.
 *
 * # Caching
 *
 * The probe is slow (~500ms cold). Results are cached per-process
 * by absolute cwd. Tests clear the cache via `clearVisibilityCache`.
 */

import { execSync } from 'child_process';
import * as path from 'path';

/**
 * The visibility states the picker reads. `'internal'` is GitHub
 * Enterprise's middle tier (visible to org members; not the public).
 * The mode picker treats internal the same as private — internal
 * repos are not safe to expose location data on, but they're not
 * literally public either.
 */
export type RepoVisibility = 'public' | 'private' | 'internal' | 'unknown';

const VISIBILITY_CACHE = new Map<string, RepoVisibility>();

/**
 * Detect the visibility of the repo rooted at `cwd`. Returns
 * `'unknown'` on every failure path — never throws. Cached per
 * absolute cwd for the lifetime of the process.
 *
 * Production callers always use this through `resolveBaselineMode`;
 * direct invocations should be rare. The single-entry contract keeps
 * the `gh` probe count predictable + makes mocking trivial in tests.
 */
export function detectRepoVisibility(cwd: string): RepoVisibility {
  const cacheKey = path.resolve(cwd);
  const cached = VISIBILITY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = detectRepoVisibilityUncached(cwd);
  VISIBILITY_CACHE.set(cacheKey, resolved);
  return resolved;
}

function detectRepoVisibilityUncached(cwd: string): RepoVisibility {
  try {
    const out = execSync('gh repo view --json visibility', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const parsed = JSON.parse(out) as { visibility?: unknown };
    const raw = typeof parsed.visibility === 'string' ? parsed.visibility.toLowerCase() : '';
    if (raw === 'public' || raw === 'private' || raw === 'internal') return raw;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Test seam: clear the per-process visibility cache. Production
 * callers never use this — the cache lives for the entire CLI
 * invocation and dies with the process.
 */
export function clearVisibilityCache(): void {
  VISIBILITY_CACHE.clear();
}
