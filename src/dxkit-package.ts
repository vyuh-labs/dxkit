/**
 * dxkit's own npm identity: the package name, the version of THIS build, and
 * the exact spec a generated artifact installs dxkit from. A leaf module (fs +
 * path only) so the install-chain renderer, the ship installers and doctor can
 * all reach it without an import cycle through the language registry.
 *
 * Why the spec carries the version (4.5.0): a generated artifact that installs
 * dxkit globally used `npm install -g @vyuhlabs/dxkit`, i.e. whatever npm
 * called latest on the day it ran. A repo then ran a different dxkit than the
 * one that generated its hooks, workflows and devcontainer, and two
 * containers built from the same files on different days disagreed. Every
 * generated global install now names the version that rendered it, through
 * this one function, so `update` (which re-renders) is the only thing that
 * moves it.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DXKIT_PACKAGE_NAME = '@vyuhlabs/dxkit';

/**
 * Package version — the single source of truth is `package.json` at the
 * package root. Compiled output lives in `dist/`, so `__dirname` points
 * to the installed `node_modules/@vyuhlabs/dxkit/dist/` and `../package.json`
 * resolves to the shipped manifest. Falling back to `'0.0.0'` on unreadable
 * package.json keeps the CLI from crashing if someone runs dxkit from a
 * broken install; the fallback is unambiguous in bug reports.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const DXKIT_VERSION = readPackageVersion();

/** The npm spec a generated artifact installs dxkit from: the exact version
 *  that rendered it. A broken install that reads `0.0.0` renders the bare
 *  name rather than a version that does not exist. */
export function dxkitPackageSpec(version: string = DXKIT_VERSION): string {
  return version && version !== '0.0.0' ? `${DXKIT_PACKAGE_NAME}@${version}` : DXKIT_PACKAGE_NAME;
}

/** Placeholder a template carries wherever it names dxkit's npm spec (an
 *  install command or an install hint); the ONE workflow writer and the hook
 *  installer replace it with `dxkitPackageSpec()`. A literal unversioned
 *  `@vyuhlabs/dxkit` in an executable template is the bug
 *  (`test/devcontainer-pins.test.ts` scans every template). */
export const DXKIT_PACKAGE_SPEC_PLACEHOLDER = '__DXKIT_PACKAGE_SPEC__';

/** Replace every spec placeholder in a rendered template. */
export function renderDxkitPackageSpec(content: string, version: string = DXKIT_VERSION): string {
  return content.split(DXKIT_PACKAGE_SPEC_PLACEHOLDER).join(dxkitPackageSpec(version));
}

/** The global install command every generated artifact uses. */
export function dxkitGlobalInstallCommand(version: string = DXKIT_VERSION): string {
  return `npm install -g ${dxkitPackageSpec(version)}`;
}
