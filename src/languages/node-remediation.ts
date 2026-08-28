/**
 * The node ecosystem's remediation capabilities (the TypeScript pack's
 * `remediation`, Rule 6): every npm/pnpm/yarn/bun fact the recipe executors
 * consume through the capability seam. Before this, the same facts lived
 * inline in `src/remediate/recipes/` (the npm `overrides` edit, the
 * `npm view` probe, the npm package-name rail), which is exactly the
 * hardcoding the seam exists to kill: an executor that knows npm cannot
 * serve a python repo, and a second ecosystem added inline would fork the
 * refusal taxonomy.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - The pin mechanism implemented this round is npm `overrides`; the
 *     pnpm (`pnpm.overrides`) and yarn (`resolutions`) mechanisms are
 *     DECLARED refusals from `plan` (reason named), never half-implemented.
 *   - A DIRECT dependency refuses the pin: the honest fix is upgrading the
 *     declared dependency (the dep-bump lane's job), not overriding it.
 *   - `npm view` resolves the registry version the install would take,
 *     honoring the repo's own `.npmrc` (registry, scopes). npm ships with
 *     the Node runtime dxkit requires, so the probe holds for every node
 *     package manager.
 */
import { join } from 'path';
import { serializePreservingJson } from '../files';
import { detectLockfile, upgradeArgv } from '../package-manager';
import type {
  DeclareDependencyProvider,
  PinPlanResult,
  PinTransitiveProvider,
  RemediationSupport,
} from './capabilities/remediation';
import { NODE_EXECUTION } from './node-install';

/**
 * A strict npm package-name shape (name, or @scope/name): lowercase-biased
 * URL-safe characters, first character alphanumeric. Load-bearing for the
 * Rule 11 argument-injection discipline, not just hygiene: an unresolved
 * "specifier" is attacker-influencable text from source code, and a
 * leading-dash value handed to a package-manager argv is a flag (a
 * `--registry=...` import would redirect the install). Everything outside
 * this shape is refused before any argv is built.
 */
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i;

export function isValidNpmPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_PACKAGE_NAME.test(name);
}

/** The `overrides[pkg] = version` edit as a PURE text transform, preserving
 *  the manifest's own indentation and trailing newline. Refuses when the
 *  package is a DIRECT dependency of the manifest. */
function npmOverrideTransform(
  pkg: string,
  version: string,
): (text: string) => { text: string } | { refused: string } {
  return (text) => {
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { refused: 'the package.json here is not a JSON object, so it cannot be edited' };
      }
      manifest = parsed as Record<string, unknown>;
    } catch {
      return { refused: 'the package.json here does not parse as JSON, so it cannot be edited' };
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const deps = manifest[section];
      if (deps && typeof deps === 'object' && pkg in (deps as Record<string, unknown>)) {
        return {
          refused:
            `'${pkg}' is a direct ${section.replace(/ies$/, 'y')} of this manifest; the honest ` +
            'fix is upgrading the declared dependency (the dep-bump lane), not overriding it',
        };
      }
    }
    const overrides =
      manifest.overrides && typeof manifest.overrides === 'object'
        ? (manifest.overrides as Record<string, unknown>)
        : {};
    overrides[pkg] = version;
    manifest.overrides = overrides;
    // The one style-preserving JSON writer (files.ts): indentation, compact
    // form, and trailing newline survive, so the override is a one-key diff.
    return { text: serializePreservingJson(text, manifest) };
  };
}

const nodePinTransitive: PinTransitiveProvider = {
  manifestFiles: ['package.json'],
  osvEcosystem: 'npm',
  plan(ctx): PinPlanResult {
    const lock = detectLockfile(join(ctx.cwd, ctx.rootDir));
    if (lock !== null && lock.pm !== 'npm') {
      return {
        kind: 'refused',
        reason:
          `the '${lock.pm}' override mechanism (${lock.pm === 'yarn' ? 'resolutions' : `${lock.pm}.overrides`}) ` +
          'is not implemented in this recipe yet (npm overrides only this round)',
      };
    }
    return {
      kind: 'plan',
      edit: { file: 'package.json', transform: npmOverrideTransform(ctx.pkg, ctx.version) },
      revert:
        `remove the "overrides" entry for '${ctx.pkg}' from ` +
        `${ctx.rootDir ? `${ctx.rootDir}/` : ''}package.json and re-run the lock resync`,
    };
  },
  execution: () => NODE_EXECUTION,
};

const nodeDeclareDependency: DeclareDependencyProvider = {
  manifestFiles: ['package.json'],
  osvEcosystem: 'npm',
  packageNameLabel: 'npm package name',
  validSpecifier: isValidNpmPackageName,
  versionProbe: (ctx) => ({ bin: 'npm', args: ['view', ctx.specifier, 'version'] }),
  parseProbeOutput(output) {
    const version = output.trim().split('\n').pop()?.trim() ?? '';
    return /^\d/.test(version) ? version : null;
  },
  installCommand(ctx) {
    // The manager owning this root, from the lockfile actually present (the
    // ONE detector); a lockfile-less root was already refused upstream.
    const pm = detectLockfile(join(ctx.cwd, ctx.rootDir))?.pm ?? 'npm';
    const [bin, ...args] = upgradeArgv(
      pm,
      ctx.specifier,
      ctx.version,
      ctx.dev ? 'devDependencies' : 'dependencies',
    );
    return { bin, args };
  },
  execution: () => NODE_EXECUTION,
};

/** The TypeScript/JavaScript pack's remediation declarations: all four
 *  capabilities. The resync command rides `nodeInstallStrategy` and the
 *  lint fix rides the eslint `fixCommand` (Rule 2: one code path each). */
export const nodeRemediation: RemediationSupport = {
  resyncLockfile: { kind: 'capability', provider: { manifestFiles: ['package.json'] } },
  pinTransitive: { kind: 'capability', provider: nodePinTransitive },
  declareDependency: { kind: 'capability', provider: nodeDeclareDependency },
  lintFix: { kind: 'capability' },
};
