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
 * Every ecosystem fact comes from the producing pack's declared
 * `remediation.declareDependency` capability (Rule 6): the specifier rail,
 * the registry version probe, the install command, the OSV ecosystem. A
 * pack without the capability carries a declared exemption whose reason is
 * this refusal (the registry's `matches` already tiers such orders to the
 * agent, disclosed). A project-path identity (leading `./`) names a
 * missing FILE, which no install can declare, so such orders are refused
 * with the reason.
 */
import * as path from 'path';
import { runSingleResolutionCheck } from '../../analyzers/correctness/single-checks';
import { isProjectPathIdentity } from '../../languages/capabilities/correctness';
import { isTestSourceFile } from '../../analyzers/tools/walk-source-files';
import type { FloorEvidence, WorkOrder } from '../work-orders/types';
import {
  ambiguousRootReason,
  environmentRefusal,
  execStepFailure,
  exemptionReason,
  osvBlockTier,
  owningManifestEntry,
  packDeclaration,
  packStrategyAt,
} from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

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
  const declaration = packDeclaration(pack, 'declareDependency');
  if (declaration === undefined) {
    return { kind: 'refused', reason: `no registered language pack has the id '${pack}'` };
  }
  if (declaration.kind === 'exemption') {
    return { kind: 'refused', reason: exemptionReason(pack, declaration) };
  }
  const provider = declaration.provider;
  // Rule 20, decided before anything spawns: the provider's declared
  // environment requirement gates the whole attempt with a disclosed
  // refusal (the runners' skipped-environment doctrine).
  const envRefusal = environmentRefusal(
    `the ${pack} pack's dependency declaration`,
    (cwd) => provider.execution(cwd),
    ctx.cwd,
  );
  if (envRefusal) return envRefusal;
  // Rule 11 argument-injection rail: a specifier is attacker-influencable
  // source text and flows into package-manager argv below. Anything outside
  // the pack's declared name shape (a leading dash, spaces, a URL) is
  // refused BEFORE any argv exists; the registry's matches applies the same
  // shape at planning time, so this is the defense-in-depth boundary.
  const malformed = cands.filter((c) => !provider.validSpecifier(c.specifier));
  if (malformed.length > 0) {
    return {
      kind: 'refused',
      reason:
        `${malformed.map((c) => `'${c.specifier}'`).join(', ')} ` +
        (malformed.length === 1
          ? `is not a valid ${provider.packageNameLabel}`
          : `are not valid ${provider.packageNameLabel}s`) +
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
  const root = owningManifestEntry(order, provider.manifestFiles);
  if (root === null) {
    return {
      kind: 'refused',
      reason: ambiguousRootReason(provider.manifestFiles, 'the manifest to declare into'),
    };
  }
  const rootDir = root.dir;
  const strategy = packStrategyAt(pack, ctx.cwd, rootDir);
  if (strategy === null || strategy.lockfile === null) {
    return {
      kind: 'refused',
      reason: `no lockfile exists at ${rootDir || 'the repo root'}, so declaring a dependency here cannot be lockfile-verified`,
    };
  }
  const rootAbs = path.join(ctx.cwd, rootDir);

  // Resolve + pre-check EVERY candidate before installing ANY: a refusal
  // must cost $0 and leave the tree untouched.
  const notes: string[] = [];
  const resolved: Array<Candidate & { version: string; dev: boolean }> = [];
  for (const c of cands) {
    // The pack's registry version probe resolves the version the install
    // would take (honoring the repo's own registry configuration).
    const probe = provider.versionProbe({ cwd: ctx.cwd, rootDir, specifier: c.specifier });
    const view = ctx.exec({ bin: probe.bin, args: [...probe.args] }, rootAbs);
    if (!view.available) {
      return {
        kind: 'failed',
        step: 'resolve-version',
        output: `${probe.bin} is not available here`,
      };
    }
    if (view.timedOut || view.overflowed) {
      return {
        kind: 'failed',
        step: 'resolve-version',
        output: `${probe.bin} ${view.timedOut ? 'timed out' : 'overflowed the capture buffer'}`,
      };
    }
    if (view.code !== 0) {
      // An infrastructure-shaped probe failure (an old CLI without the
      // probe subcommand, an unprovisioned environment) is a named failure
      // of THIS run, never a verdict on the specifier: the generic tool-CLI
      // shapes here, plus whatever the pack declares (Rule 6).
      const infrastructure =
        /unknown command|no such command|command not found|is not recognized/i.test(view.output) ||
        (provider.probeInfrastructure?.(view.output) ?? false);
      if (infrastructure) {
        return {
          kind: 'failed',
          step: 'resolve-version',
          output: `${probe.bin} cannot answer a version probe here: ${view.output.trim().split('\n')[0] ?? ''}`,
        };
      }
      return {
        kind: 'refused',
        reason:
          `'${c.specifier}' does not resolve in the package registry: likely a typo, a ` +
          'private package, or something that should not be a dependency at all. Not installing',
      };
    }
    const version = provider.parseProbeOutput(view.output);
    if (version === null) {
      return {
        kind: 'refused',
        reason: `could not determine a concrete registry version for '${c.specifier}' (got '${view.output.trim().split('\n').pop()?.trim() ?? ''}')`,
      };
    }
    const known = await ctx.queryOsv(c.specifier, version, provider.osvEcosystem);
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
    // A package imported ONLY from test files is a dev dependency.
    const dev = c.importingFiles.length > 0 && c.importingFiles.every((f) => isTestSourceFile(f));
    resolved.push({ ...c, version, dev });
  }

  for (const r of resolved) {
    const cmd = provider.installCommand({
      cwd: ctx.cwd,
      rootDir,
      specifier: r.specifier,
      version: r.version,
      dev: r.dev,
    });
    const install = ctx.exec({ bin: cmd.bin, args: [...cmd.args] }, rootAbs);
    const failure = execStepFailure('install', [cmd.bin, ...cmd.args].join(' '), install);
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
  const manifestPath = rootDir ? `${rootDir}/${root.file}` : root.file;
  const lockPath = rootDir ? `${rootDir}/${strategy.lockfile}` : strategy.lockfile;
  return {
    kind: 'applied',
    changedFiles: [manifestPath, lockPath],
    ...(notes.length > 0 ? { notes } : {}),
  };
}
