/**
 * How a python root installs (CLAUDE.md Rule 6), split out of `python.ts`
 * (the node-install.ts precedent) so the remediation capabilities can read
 * the SAME strategy without a module cycle: one variant per dependency
 * artifact, in preference order.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - The frozen forms are the ones that REFUSE a stale lockfile
 *     (`uv sync --locked`, `pipenv install --deploy`, and `poetry install`,
 *     which aborts when pyproject moved ahead of poetry.lock).
 *   - uv and pipenv resync through the ONE command that both rewrites the
 *     lockfile and installs. poetry's resync is `poetry lock --no-update`
 *     (rewrite only what pyproject requires, poetry 1.x spelling) with the
 *     plain `poetry lock` as the intrinsic unsupported-flag fallback:
 *     poetry 2 removed `--no-update` because its behavior became the
 *     default, so the rejected flag routes to the plain spelling: the
 *     yarn `--frozen-lockfile`/`--immutable` dance, one ladder, disclosed.
 *   - Lockfile-sync checks are the non-installing dry-runs each manager
 *     actually has: `poetry check --lock` (pyproject ↔ poetry.lock
 *     consistency), `uv lock --check` (assert the lockfile would not
 *     change), `pipenv verify` (the Pipfile hash recorded in
 *     Pipfile.lock). Plain requirements roots have no lockfile, so they
 *     declare neither a resync nor a sync check.
 *   - No ecosystem tolerance exists here: python resolvers have no
 *     peer-check analogue, so no repo-authorized fallbacks are declared.
 */
import type { ExecutionRequirement } from '../execution';
import { declareInstallStrategy } from './capabilities/install-strategy';

/** Installs run on the ambient python toolchain, any host, no build. */
export const PYTHON_INSTALL_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['python'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

export const pythonInstallStrategy = declareInstallStrategy(
  [
    {
      when: ['poetry.lock'],
      strategy: {
        manager: 'poetry',
        lockfile: 'poetry.lock',
        modes: {
          frozen: { primary: { bin: 'poetry', args: ['install'] }, fallbacks: [] },
          resync: {
            primary: { bin: 'poetry', args: ['lock', '--no-update'] },
            fallbacks: [
              {
                command: { bin: 'poetry', args: ['lock'] },
                when: 'unsupported-flag',
                // Only the flag REJECTION routes here (cleo's "does not
                // exist" / click's "no such option" naming --no-update); a
                // real resolution failure never matches.
                matches: (output) =>
                  /no-update/.test(output) &&
                  /no such option|does not exist|unknown option|unexpected argument/i.test(output),
                disclosure:
                  'poetry 2 removed --no-update (its behavior became the default); ' +
                  'retried with the plain lock',
                // The rendered chain retries blanket, so the guard confines
                // it to poetry >= 2, where the plain lock IS the minimal
                // resync; on poetry 1.x it would re-resolve everything.
                shellGuard: 'poetry --version 2>/dev/null | grep -qE "version [2-9]"',
              },
            ],
          },
        },
        syncCheck: {
          kind: 'command',
          command: { bin: 'poetry', args: ['check', '--lock'] },
          tolerates: [],
        },
        execution: PYTHON_INSTALL_EXECUTION,
      },
    },
    {
      when: ['uv.lock'],
      strategy: {
        manager: 'uv',
        lockfile: 'uv.lock',
        modes: {
          frozen: { primary: { bin: 'uv', args: ['sync', '--locked'] }, fallbacks: [] },
          resync: { primary: { bin: 'uv', args: ['sync'] }, fallbacks: [] },
        },
        syncCheck: {
          kind: 'command',
          command: { bin: 'uv', args: ['lock', '--check'] },
          tolerates: [],
        },
        execution: PYTHON_INSTALL_EXECUTION,
      },
    },
    {
      when: ['Pipfile.lock'],
      strategy: {
        manager: 'pipenv',
        lockfile: 'Pipfile.lock',
        modes: {
          frozen: { primary: { bin: 'pipenv', args: ['install', '--deploy'] }, fallbacks: [] },
          resync: { primary: { bin: 'pipenv', args: ['install'] }, fallbacks: [] },
        },
        syncCheck: {
          kind: 'command',
          command: { bin: 'pipenv', args: ['verify'] },
          tolerates: [],
        },
        execution: PYTHON_INSTALL_EXECUTION,
      },
    },
    {
      when: ['requirements.txt'],
      strategy: {
        manager: 'pip',
        lockfile: null,
        modes: {
          frozen: {
            primary: { bin: 'pip', args: ['install', '-r', 'requirements.txt'] },
            fallbacks: [],
          },
        },
        execution: PYTHON_INSTALL_EXECUTION,
      },
    },
  ],
  { ciDependencyInstall: false },
);
