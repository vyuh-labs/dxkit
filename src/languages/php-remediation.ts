/**
 * The php ecosystem's remediation capabilities (the pack's `remediation`,
 * Rule 6, the node-remediation.ts sibling): every composer fact the
 * recipe executors consume through the capability seam.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - Composer has no override table; its documented way to constrain a
 *     transitive dependency is REQUIRING IT DIRECTLY with the constraint.
 *     The pin therefore lands as an exact-version `require` entry (the
 *     explicit-entry pin, the Gemfile/poetry sibling). The alternative
 *     `conflict` + `require` pattern was deliberately NOT chosen: a
 *     `conflict` entry only forbids the vulnerable version, it cannot
 *     force a resolution on its own and fails opaquely when nothing else
 *     satisfies the graph, while a direct require both constrains and
 *     resolves, and reverts by removing one entry. A package already in
 *     `require`/`require-dev` refuses (the honest fix is upgrading the
 *     declared dependency, the dep-bump lane's job).
 *   - `declareDependency` is a REASONED EXEMPTION: the php resolution
 *     check reports unresolved NAMESPACE roots (`Monolog\`), and a
 *     namespace does not identify a Packagist package (`Symfony\Component
 *     \Console` is symfony/console); deriving vendor/package from a
 *     namespace mechanically would be a guess, and the bias is to refuse.
 *   - `lintFix` is a REASONED EXEMPTION: the pack's lint gate is phpcs,
 *     and its fixer phpcbf reports what it FIXED rather than what
 *     remains, so one fix run cannot also verify the order's findings are
 *     gone (the seam's one-run fix-and-verify contract); a different
 *     fixer (pint, php-cs-fixer) answers different rules than the gate's
 *     sniffs and would read as net-new leftovers.
 */
import { serializePreservingJson } from '../files';
import type { ExecutionRequirement } from '../execution';
import type {
  ManifestTextEdit,
  PinPlanResult,
  PinTransitiveProvider,
  RemediationSupport,
} from './capabilities/remediation';

/** Remediation commands run on the ambient php toolchain (composer rides
 *  the php CLI), any host, no build. */
const PHP_REMEDIATION_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['php'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

/** Composer's documented `vendor/package` name shape (lowercase, dots,
 *  dashes, underscores; exactly one slash). The Rule 11 rail for the pin's
 *  package token before it lands in manifest text. */
const COMPOSER_PACKAGE_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;

export function isValidComposerPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && COMPOSER_PACKAGE_NAME.test(name);
}

/** A composer version shape (digits-led, optional stability suffix). */
const COMPOSER_VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

/** The exact-version `require` entry as a PURE text transform, preserving
 *  the manifest's own indentation and trailing newline (the one
 *  style-preserving JSON writer). Refuses a direct dependency. */
function composerRequireTransform(pkg: string, version: string): ManifestTextEdit['transform'] {
  return (text) => {
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { refused: 'the composer.json here is not a JSON object, so it cannot be edited' };
      }
      manifest = parsed as Record<string, unknown>;
    } catch {
      return { refused: 'the composer.json here does not parse as JSON, so it cannot be edited' };
    }
    for (const section of ['require', 'require-dev'] as const) {
      const deps = manifest[section];
      if (deps && typeof deps === 'object' && pkg in (deps as Record<string, unknown>)) {
        return {
          refused:
            `'${pkg}' is a direct ${section} dependency of this manifest; the honest fix is ` +
            'upgrading the declared dependency (the dep-bump lane), not pinning it again',
        };
      }
    }
    const require =
      manifest.require && typeof manifest.require === 'object'
        ? (manifest.require as Record<string, unknown>)
        : {};
    require[pkg] = version;
    manifest.require = require;
    return { text: serializePreservingJson(text, manifest) };
  };
}

const phpPinTransitive: PinTransitiveProvider = {
  manifestFiles: ['composer.json'],
  osvEcosystem: 'Packagist',
  plan(ctx): PinPlanResult {
    // Rule 11: both tokens land in manifest text verbatim.
    if (!isValidComposerPackageName(ctx.pkg) || !COMPOSER_VERSION.test(ctx.version)) {
      return {
        kind: 'refused',
        reason:
          `'${ctx.pkg}@${ctx.version}' is not a composer package name + version shape ` +
          'dxkit will write into a manifest',
      };
    }
    const at = ctx.rootDir ? `${ctx.rootDir}/` : '';
    return {
      kind: 'plan',
      edit: { file: 'composer.json', transform: composerRequireTransform(ctx.pkg, ctx.version) },
      revert: `remove the "require" entry for '${ctx.pkg}' from ${at}composer.json and re-run the lock resync`,
      // Deliberate churn, disclosed on the ledger: composer has no scoped
      // lock-writing resync dxkit can name, so the full `composer update`
      // may also refresh unrelated packages within their declared
      // constraints. The re-audit and the run guardrail check the whole
      // tree, so nothing rides in unchecked; the diff is just wider.
      notes: [
        'the composer lock resync (composer update) may also refresh unrelated packages in ' +
          'composer.lock within their declared constraints; the re-audit and the guardrail ' +
          'check the whole tree',
      ],
    };
  },
  execution: () => PHP_REMEDIATION_EXECUTION,
};

/** The php pack's remediation declarations: resync + pin are capabilities
 *  (both ride composer through the install strategy); declare + lintFix
 *  are reasoned exemptions (the doctrine block above says why). */
export const phpRemediation: RemediationSupport = {
  resyncLockfile: { kind: 'capability', provider: { manifestFiles: ['composer.json'] } },
  pinTransitive: { kind: 'capability', provider: phpPinTransitive },
  declareDependency: {
    kind: 'exemption',
    reason:
      'an unresolved php import names a namespace, and a namespace does not identify a ' +
      'Packagist package (the vendor/package name cannot be derived from it mechanically); ' +
      'these orders stay on the agent tier',
  },
  lintFix: {
    kind: 'exemption',
    reason:
      'phpcbf, the phpcs fixer, reports what it fixed rather than what remains, so a single ' +
      "fix run cannot also verify the order's findings are gone; these orders stay on the " +
      'agent tier',
  },
};
