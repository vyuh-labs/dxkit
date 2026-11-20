/**
 * Git environment variables that point git at a specific repository
 * (`git rev-parse --local-env-vars`). A git hook exports some of them
 * (GIT_DIR, and GIT_INDEX_FILE / GIT_PREFIX in some hooks); a test or the
 * code under test that runs git in a temp directory with them inherited
 * operates on the hook's repository instead of the temp one.
 */
export const REPO_LOCAL_GIT_ENV: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

/** A copy of `env` without the repository-local git variables. */
export function withoutInheritedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of REPO_LOCAL_GIT_ENV) delete out[k];
  return out;
}
