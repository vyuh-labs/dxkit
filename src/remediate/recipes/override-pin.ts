/**
 * The `override-pin` recipe: a `dep-advisory` order whose every advisory has
 * a known fixed version, on a package with no direct upgrade path (a
 * transitive dependency), is fixed by a package-manager override pinning the
 * fixed version, then a lockfile resync.
 *
 * Honesty gates, in order:
 *   - npm first: pnpm `pnpm.overrides` and yarn `resolutions` are
 *     DECLARED-REFUSED this round (reason named), never half-implemented;
 *   - a DIRECT dependency is refused: the honest fix is upgrading the
 *     declared dep (the dep-bump lane's job), not overriding it;
 *   - the candidate pin is OSV pre-checked ($0): a block-tier advisory
 *     against the pinned version refuses with the advisory named, so the
 *     recipe never trades one red gate for another;
 *   - verify is a re-audit through the ONE dep-audit dispatch: the order's
 *     package must audit clean afterwards (its known advisories gone AND
 *     nothing new minted on it), or the recipe fails and the diff is
 *     discarded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { classifyOsvSeverity } from '../../analyzers/tools/osv';
import { maxSemver } from '../../analyzers/bom/gather';
import type { WorkOrder } from '../work-orders/types';
import type { DepAdvisoryEvidence } from '../work-orders/types';
import { nodePmAt, owningManifestRoot, resyncInstallFor, runResyncInstall } from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

function advisories(order: WorkOrder): DepAdvisoryEvidence[] {
  return order.findings
    .map((f) => f.evidence)
    .filter((e): e is DepAdvisoryEvidence => e.type === 'dep-vuln');
}

interface ManifestEdit {
  readonly file: string;
  readonly refused?: string;
}

/** Write `overrides[pkg] = version` into the root package.json, preserving
 *  the file's own indentation and trailing newline. Refuses (without
 *  writing) when the package is a DIRECT dependency there. */
function writeNpmOverride(rootAbs: string, pkg: string, version: string): ManifestEdit {
  const file = path.join(rootAbs, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(text) as Record<string, unknown>;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = manifest[section];
    if (deps && typeof deps === 'object' && pkg in (deps as Record<string, unknown>)) {
      return {
        file,
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
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const trailing = text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, JSON.stringify(manifest, null, indent) + trailing);
  return { file };
}

export async function executeOverridePin(
  order: WorkOrder,
  ctx: RecipeExecuteContext,
): Promise<RecipeOutcome> {
  const advs = advisories(order);
  if (advs.length === 0 || advs.length !== order.findings.length) {
    return { kind: 'refused', reason: 'the order carries non-advisory findings' };
  }
  const pkg = advs[0].package;
  const fixedVersions = advs.map((a) => a.fixedVersion).filter((v): v is string => !!v);
  if (fixedVersions.length !== advs.length) {
    return {
      kind: 'refused',
      reason: `no fixed version is known for every advisory against '${pkg}'`,
    };
  }
  const rootDir = owningManifestRoot(order);
  if (rootDir === null) {
    return {
      kind: 'refused',
      reason:
        'the envelope does not name exactly one package.json, so the owning dependency root ' +
        'is ambiguous',
    };
  }
  const lock = nodePmAt(ctx.cwd, rootDir);
  if (lock === null) {
    return {
      kind: 'refused',
      reason: `no lockfile exists at ${rootDir || 'the repo root'}, and an override cannot be verified without one`,
    };
  }
  if (lock.pm !== 'npm') {
    return {
      kind: 'refused',
      reason:
        `the '${lock.pm}' override mechanism (${lock.pm === 'yarn' ? 'resolutions' : `${lock.pm}.overrides`}) ` +
        'is not implemented in this recipe yet (npm overrides only this round)',
    };
  }

  // The pin: the highest known fixed version clears every advisory at once.
  const pin = maxSemver(fixedVersions);
  const notes: string[] = [];

  // $0 pre-check: would the pinned version itself carry a block-tier
  // advisory? A null answer (network) is disclosed and the re-audit verify
  // plus the frame's guardrail stay the backstop; it is never read as clean.
  const known = await ctx.queryOsv(pkg, pin, 'npm');
  if (known === null) {
    notes.push(`OSV pre-check for ${pkg}@${pin} could not be reached; the re-audit verifies`);
  } else {
    const blockTier = known.filter((v) => {
      const s = classifyOsvSeverity(v);
      return s === 'high' || s === 'critical';
    });
    if (blockTier.length > 0) {
      const ids = blockTier.map((v) => v.id ?? 'unidentified advisory').join(', ');
      return {
        kind: 'refused',
        reason:
          `pinning ${pkg} to ${pin} would leave a block-tier advisory in place: ${ids}. ` +
          'A higher fixed version (or a different fix) is needed; not applying',
      };
    }
  }

  const rootAbs = path.join(ctx.cwd, rootDir);
  const edit = writeNpmOverride(rootAbs, pkg, pin);
  if (edit.refused) return { kind: 'refused', reason: edit.refused };

  const installFailure = runResyncInstall(resyncInstallFor(lock.pm), rootAbs, ctx.exec);
  if (installFailure) return installFailure;

  // Verify: the ONE dep-audit dispatch, then "the order's package audits
  // clean": its known advisories are gone and nothing new was minted on it
  // (an override-pin order carries EVERY advisory of its package, so any
  // remaining finding on the package is a verify failure either way).
  const audited = await ctx.auditDepVulns(ctx.cwd);
  if (audited === null) {
    return {
      kind: 'failed',
      step: 'verify-audit',
      output: 'the dependency re-audit could not run, so the pin cannot be verified here',
    };
  }
  const remaining = audited.filter((f) => f.package === pkg);
  if (remaining.length > 0) {
    return {
      kind: 'failed',
      step: 'verify-audit',
      output:
        `advisories still reported against ${pkg} after pinning ${pin}: ` +
        remaining.map((f) => f.id).join(', '),
    };
  }
  const manifestPath = rootDir ? `${rootDir}/package.json` : 'package.json';
  const lockPath = rootDir ? `${rootDir}/${lock.lockfile}` : lock.lockfile;
  return {
    kind: 'applied',
    changedFiles: [manifestPath, lockPath],
    ...(notes.length > 0 ? { notes } : {}),
  };
}
