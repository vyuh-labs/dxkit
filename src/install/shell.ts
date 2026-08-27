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
  type InstallStrategyProvider,
  type InstallVariant,
} from '../languages/capabilities/install-strategy';
import type { ResolvedTolerances } from './tolerances';

/** The whole-line placeholder a workflow template carries where its
 *  dependency install goes. */
export const INSTALL_DEPS_PLACEHOLDER = '__DXKIT_INSTALL_DEPS__';

/** The last resort when no package.json exists at all: CI still needs the
 *  dxkit CLI on PATH. A dxkit-CLI fact, not a pack fact. */
const NO_MANIFEST_INSTALL = 'npm install -g @vyuhlabs/dxkit';

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
      ? `{ ${f.shellGuard} && ${installCommandText(f.command)}; }`
      : installCommandText(f.command),
  );
  return [installCommandText(frozen.primary), ...segments].join(' || ');
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
  const lines: string[] = ['corepack enable >/dev/null 2>&1 || true'];
  ciInstallVariants(providers).forEach((v, i) => {
    const cond = v.when.map((f) => `[ -f ${f} ]`).join(' || ');
    lines.push(`${i === 0 ? 'if' : 'elif'} ${cond}; then`);
    for (const s of v.strategy.ciSetup ?? []) lines.push(`  ${s}`);
    lines.push(`  ${renderInstallLine(v, tolerances)}`);
  });
  lines.push('else', `  ${NO_MANIFEST_INSTALL}`, 'fi');
  return lines.map((l) => indent + l).join('\n');
}
