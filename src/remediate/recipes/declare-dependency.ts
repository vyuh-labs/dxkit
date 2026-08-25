/**
 * The `declare-dependency` recipe: an `unresolved-import` order (a bare
 * import specifier that resolves against nothing installed) is fixed by
 * declaring the package in the manifest the importing files imply and
 * installing it, with the design's load-bearing twist: the candidate is
 * OSV pre-checked FIRST, and a block-tier advisory refuses at $0 with the
 * advisory named. That is the live fix-build failure class (an agent
 * installing a vulnerable phantom dependency and turning the gate red)
 * converted into a disclosed refusal.
 *
 * Scope this round: orders produced by the TypeScript/JavaScript pack. The
 * resolution-check contract makes bareness a producer fact; a project-path
 * identity (leading `./`) names a missing FILE, which no install can
 * declare, so such orders are refused with the reason (the registry's
 * `matches` already tiers them to the agent).
 */
import * as path from 'path';
import { runSingleResolutionCheck } from '../../analyzers/correctness/single-checks';
import { isProjectPathIdentity } from '../../languages/capabilities/correctness';
import { isTestSourceFile } from '../../analyzers/tools/walk-source-files';
import { upgradeArgv, type DependencySection } from '../../package-manager';
import type { FloorEvidence, WorkOrder } from '../work-orders/types';
import {
  execStepFailure,
  isValidNpmPackageName,
  nodePmAt,
  osvBlockTier,
  owningManifestRoot,
} from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

/** The packs whose resolution-check evidence this recipe can act on. Read
 *  by the registry's `matches` too, so an order from any other pack tiers
 *  to the agent instead of being tiered recipe and refused at runtime. */
export const DECLARABLE_PACKS: readonly string[] = ['typescript'];

interface Candidate {
  readonly specifier: string;
  readonly importingFiles: readonly string[];
}

function candidates(order: WorkOrder): Candidate[] | null {
  const out: Candidate[] = [];
  for (const f of order.findings) {
    const e = f.evidence;
    if (e.type !== 'floor' || typeof e.specifier !== 'string') return null;
    out.push({ specifier: e.specifier, importingFiles: e.importingFiles ?? [] });
  }
  return out;
}

export async function executeDeclareDependency(
  order: WorkOrder,
  ctx: RecipeExecuteContext,
): Promise<RecipeOutcome> {
  const cands = candidates(order);
  if (cands === null || cands.length === 0) {
    return { kind: 'refused', reason: 'the order carries no unresolved-specifier evidence' };
  }
  const pack = (order.findings[0].evidence as FloorEvidence).pack;
  if (!DECLARABLE_PACKS.includes(pack)) {
    return {
      kind: 'refused',
      reason: `declare-dependency is implemented for the ${DECLARABLE_PACKS.join('/')} pack only this round (order came from '${pack}')`,
    };
  }
  // Rule 11 argument-injection rail: a specifier is attacker-influencable
  // source text and flows into package-manager argv below. Anything outside
  // the strict npm name shape (a leading dash, spaces, a URL) is refused
  // BEFORE any argv exists; the registry's matches applies the same shape
  // at planning time, so this is the defense-in-depth boundary.
  const malformed = cands.filter((c) => !isValidNpmPackageName(c.specifier));
  if (malformed.length > 0) {
    return {
      kind: 'refused',
      reason:
        `${malformed.map((c) => `'${c.specifier}'`).join(', ')} ` +
        (malformed.length === 1
          ? 'is not a valid npm package name'
          : 'are not valid npm package names') +
        '; refusing to hand it to the package manager',
    };
  }
  const relative = cands.filter((c) => isProjectPathIdentity(c.specifier));
  if (relative.length > 0) {
    return {
      kind: 'refused',
      reason:
        `${relative.map((c) => `'${c.specifier}'`).join(', ')} name missing FILES in the repo ` +
        'tree, not packages, and no install can declare them; a human or the agent tier must ' +
        'restore or remove the import',
    };
  }
  const rootDir = owningManifestRoot(order);
  if (rootDir === null) {
    return {
      kind: 'refused',
      reason:
        'the envelope does not name exactly one package.json, so the manifest to declare ' +
        'into is ambiguous',
    };
  }
  const lock = nodePmAt(ctx.cwd, rootDir);
  if (lock === null) {
    return {
      kind: 'refused',
      reason: `no lockfile exists at ${rootDir || 'the repo root'}, so declaring a dependency here cannot be lockfile-verified`,
    };
  }
  const rootAbs = path.join(ctx.cwd, rootDir);

  // Resolve + pre-check EVERY candidate before installing ANY: a refusal
  // must cost $0 and leave the tree untouched.
  const notes: string[] = [];
  const resolved: Array<Candidate & { version: string; section: DependencySection }> = [];
  for (const c of cands) {
    // `npm view` resolves the registry version the install would take,
    // honoring the repo's own .npmrc (registry, scopes). npm ships with the
    // Node runtime dxkit requires, so this holds for every node PM.
    const view = ctx.exec({ bin: 'npm', args: ['view', c.specifier, 'version'] }, rootAbs);
    if (!view.available) {
      return { kind: 'failed', step: 'resolve-version', output: 'npm is not available here' };
    }
    if (view.timedOut || view.overflowed || view.code !== 0) {
      return {
        kind: 'refused',
        reason:
          `'${c.specifier}' does not resolve in the package registry: likely a typo, a ` +
          'private package, or something that should not be a dependency at all. Not installing',
      };
    }
    const version = view.output.trim().split('\n').pop()?.trim() ?? '';
    if (!/^\d/.test(version)) {
      return {
        kind: 'refused',
        reason: `could not determine a concrete registry version for '${c.specifier}' (got '${version}')`,
      };
    }
    const known = await ctx.queryOsv(c.specifier, version, 'npm');
    if (known === null) {
      notes.push(
        `OSV pre-check for ${c.specifier}@${version} could not be reached; the guardrail verifies`,
      );
    } else {
      const blockTier = osvBlockTier(known, ctx.blockSeverities);
      if (blockTier.length > 0) {
        const ids = blockTier.map((v) => v.id ?? 'unidentified advisory').join(', ');
        return {
          kind: 'refused',
          reason:
            `installing ${c.specifier}@${version} would introduce a block-tier advisory: ${ids}. ` +
            'The import needs a different fix (a maintained alternative, or removing the import)',
        };
      }
    }
    // Section: a package imported ONLY from test files is a devDependency.
    const section: DependencySection =
      c.importingFiles.length > 0 && c.importingFiles.every((f) => isTestSourceFile(f))
        ? 'devDependencies'
        : 'dependencies';
    resolved.push({ ...c, version, section });
  }

  for (const r of resolved) {
    const [bin, ...args] = upgradeArgv(lock.pm, r.specifier, r.version, r.section);
    const install = ctx.exec({ bin, args }, rootAbs);
    const failure = execStepFailure('install', [bin, ...args].join(' '), install);
    if (failure) return failure;
  }

  // Verify with the pack's own resolution check AT THE OWNING ROOT (the
  // tree the install provisioned; a nested workspace's importers resolve
  // against its own installed tree): the ORDER's specifiers must be gone.
  // Pre-existing unresolved debt elsewhere stays the floor's story.
  const verify = runSingleResolutionCheck(rootAbs, pack);
  if (verify === null || (verify.status !== 'pass' && verify.status !== 'fail')) {
    return {
      kind: 'failed',
      step: 'verify-resolution',
      output: verify?.output ?? 'the import-resolution check could not answer here',
    };
  }
  const still = new Set((verify.unresolved ?? []).map((u) => u.specifier));
  const unfixed = resolved.filter((r) => still.has(r.specifier));
  if (unfixed.length > 0) {
    return {
      kind: 'failed',
      step: 'verify-resolution',
      output: `still unresolved after install: ${unfixed.map((r) => `'${r.specifier}'`).join(', ')}`,
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
