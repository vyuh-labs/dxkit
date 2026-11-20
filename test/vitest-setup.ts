import { REPO_LOCAL_GIT_ENV } from './git-env';

/**
 * Suite-wide environment defaults.
 *
 * DXKIT_BASELINE_NO_FLOOR: `createBaseline` captures the floor-debt
 * envelope (a full compile + test pass) by DEFAULT in the product — but the
 * suite calls `createBaseline` on hundreds of throwaway fixture repos, and
 * paying a floor run per fixture would add minutes of pure noise (fixtures
 * have no real toolchain to measure). The env opt-out keeps the suite fast;
 * the capture path itself is exercised explicitly by
 * `test/baseline/floor-debt.test.ts`, which passes `floor: true` (an
 * explicit option always beats the env).
 */
process.env.DXKIT_BASELINE_NO_FLOOR = '1';

/**
 * Inherited repository-local git variables (GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, ...): cleared for every worker. The pre-push hook runs this
 * suite, and git exports GIT_DIR to hooks (an absolute path from a linked
 * worktree). Every fixture test, and every code path under test, that runs
 * git in a temp directory would then operate on the pushing repository:
 * commits on its branch, its config rewritten. Cleared here once, so no
 * test or helper has to remember. Pinned by `test/git-env-isolation.test.ts`.
 */
for (const key of REPO_LOCAL_GIT_ENV) delete process.env[key];
