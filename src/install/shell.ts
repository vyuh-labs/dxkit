/**
 * The ONE shell rendering of the dependency install a CI workflow runs
 * before dxkit: rendered from the packs' declared install variants (the
 * same list `strategyFromVariants` picks from in-process) into an if/elif
 * chain keyed on the files each variant selects on, so the workflow's
 * install and the lane's verification cannot pick different commands for
 * one tree. Templates carry the whole-line placeholder; the ONE workflow
 * writer substitutes this block.
 *
 * A declared fallback renders as `primary || fallback` when its tolerance
 * class is authorized for the repo the workflow is written for; a fallback
 * carrying a `shellGuard` renders as `primary || { guard && fallback; }`.
 * Shell cannot evaluate a classifier, so the retry is otherwise
 * unconditional; that is OUTCOME-equivalent because a declared fallback
 * only relaxes the one check its class names and can never succeed where
 * the primary failed for another reason (the guard exists exactly where a
 * manager variant breaks that property: yarn classic silently ignoring
 * berry's flag). The in-process executor gates on the classifier so its
 * ledger names the primary on an unrelated failure.
 */
import {
  installCommandText,
  type InstallStrategy,
  type InstallStrategyProvider,
  type InstallVariant,
} from '../languages/capabilities/install-strategy';
import type { ResolvedTolerances } from './tolerances';

/** The whole-line placeholder a workflow template carries where its
 *  dependency install goes. */
export const INSTALL_DEPS_PLACEHOLDER = '__DXKIT_INSTALL_DEPS__';

/** The last resort when no package.json exists at all: CI still needs the
 *  dxkit CLI on PATH. A dxkit-CLI fact, not a pack fact. */
export const NO_MANIFEST_INSTALL = 'npm install -g @vyuhlabs/dxkit';

/** The ONE path of the install-outcome record, repo-relative: written by
 *  the rendered install step (through `install classify`, `outcome.ts`),
 *  read by the comment step (through `install comment`). Under the
 *  gitignored runtime cache, so it never rides a commit. */
export const INSTALL_OUTCOME_RECORD = '.dxkit/cache/ci-install-outcome.json';

/** The captured install log the rendered chain tees to, beside the record. */
export const INSTALL_OUTCOME_LOG = '.dxkit/cache/ci-install.log';

/** The shell function the rendered chain retries a fallback through: it
 *  echoes the executor's fallback delimiter (`fallbackDelimiter` in
 *  `run.ts`, byte-identical) before running the fallback, so the captured
 *  log splits into the same per-attempt segments the executor classifies. */
export const SHELL_FALLBACK_FN = 'dxkit_fallback';

/** The variants CI must chain: every pack whose strategy declares
 *  `ciDependencyInstall`, in registry order. */
export function ciInstallVariants(
  providers: readonly InstallStrategyProvider[],
): readonly InstallVariant[] {
  return providers.filter((p) => p.ciDependencyInstall).flatMap((p) => p.variants());
}

/** The `primary || fallback...` line for one variant under the repo's
 *  tolerances (the shell projection of the executor's ladder). EVERY
 *  authorized fallback is chained, in declared order, so the shell is never
 *  a lossy first-fallback projection of the ladder. */
export function renderInstallLine(v: InstallVariant, tolerances: ResolvedTolerances): string {
  const frozen = v.strategy.modes.frozen;
  const fallbacks = frozen.fallbacks.filter((f) => tolerances.tolerated.has(f.when));
  const segments = fallbacks.map((f) =>
    f.shellGuard
      ? `{ ${f.shellGuard} && ${SHELL_FALLBACK_FN} ${installCommandText(f.command)}; }`
      : `${SHELL_FALLBACK_FN} ${installCommandText(f.command)}`,
  );
  return [installCommandText(frozen.primary), ...segments].join(' || ');
}

/** The strategy the rendered chain picks for the root at `cwd`: the first
 *  CI-installing provider (registry order) whose variants match, resolved
 *  through the provider's own `strategy(dir)`. The classification side of
 *  the chain reads THIS, so the classified plan is the executed plan. */
export function ciInstallStrategy(
  providers: readonly InstallStrategyProvider[],
  cwd: string,
): InstallStrategy | null {
  for (const p of providers) {
    if (!p.ciDependencyInstall) continue;
    const s = p.strategy(cwd);
    if (s !== null) return s;
  }
  return null;
}

/**
 * The shell block at the given indent (a workflow `run: |` body). corepack
 * provides pnpm/yarn with no extra action, honoring the repo's
 * `packageManager` field; the chain picks the lockfile-appropriate installer
 * so the audited tree is the tree the repo ships, never a fabricated npm
 * resolution of a pnpm workspace.
 */
export function renderInstallDependenciesShell(
  indent: string,
  providers: readonly InstallStrategyProvider[],
  tolerances: ResolvedTolerances,
): string {
  const lines: string[] = [
    'corepack enable >/dev/null 2>&1 || true',
    // The chain runs inside a function whose output is captured (and still
    // streamed to the job log), so a failure can be CLASSIFIED by dxkit's own
    // install classifier afterwards instead of read as "did not run".
    `${SHELL_FALLBACK_FN}() { echo "--- fallback ($*) ---"; "$@"; }`,
    'dxkit_install() {',
  ];
  ciInstallVariants(providers).forEach((v, i) => {
    const cond = v.when.map((f) => `[ -f ${f} ]`).join(' || ');
    lines.push(`  ${i === 0 ? 'if' : 'elif'} ${cond}; then`);
    for (const s of v.strategy.ciSetup ?? []) lines.push(`    ${s}`);
    lines.push(`    ${renderInstallLine(v, tolerances)}`);
  });
  lines.push('  else', `    ${NO_MANIFEST_INSTALL}`, '  fi', '}');
  lines.push(...renderInstallCapture());
  return lines.map((l) => indent + l).join('\n');
}

/**
 * The capture + classify tail of the rendered block. The install's exit
 * code is the step's exit code (nothing downstream runs on a half-installed
 * tree); before exiting, the captured log is handed to `vyuh-dxkit install
 * classify`, which writes the outcome record the comment step reads. The
 * CLI may not be in node_modules after a failed install, so it is resolved
 * from the tree, then PATH, then a global install of the package; when none
 * resolves nothing is recorded and the comment step keeps its generic text.
 */
function renderInstallCapture(): string[] {
  return [
    `mkdir -p "$(dirname ${INSTALL_OUTCOME_LOG})"`,
    'set +e',
    `( set -o pipefail; dxkit_install 2>&1 | tee ${INSTALL_OUTCOME_LOG} )`,
    'DXKIT_INSTALL_CODE=$?',
    'set -e',
    'if [ -x ./node_modules/.bin/vyuh-dxkit ]; then DXKIT=./node_modules/.bin/vyuh-dxkit;',
    'elif command -v vyuh-dxkit >/dev/null 2>&1; then DXKIT=vyuh-dxkit;',
    `elif ${NO_MANIFEST_INSTALL} >/dev/null 2>&1; then DXKIT=vyuh-dxkit;`,
    'else DXKIT=""; fi',
    `[ -z "$DXKIT" ] || "$DXKIT" install classify --log ${INSTALL_OUTCOME_LOG} --code "$DXKIT_INSTALL_CODE" || true`,
    'exit "$DXKIT_INSTALL_CODE"',
  ];
}
