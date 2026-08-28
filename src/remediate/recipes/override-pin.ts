/**
 * The `override-pin` recipe: a `dep-advisory` order whose every advisory has
 * a known fixed version, on a package with no direct upgrade path (a
 * transitive dependency), is fixed by the OWNING PACK's declared pin
 * mechanism (`remediation.pinTransitive`, Rule 6: the executor knows no
 * ecosystem; npm overrides live in the ts pack) and a lockfile resync
 * through the pack's install strategy.
 *
 * Honesty gates, in order:
 *   - the owning pack's declaration decides: an exemption (or an
 *     unresolvable pack) refuses with the declared reason; the pack's own
 *     `plan` may refuse too (a mechanism it does not implement yet, a
 *     direct dependency: the honest fix is upgrading the declared dep, the
 *     dep-bump lane's job);
 *   - the candidate pin is OSV pre-checked ($0) in the pack's declared
 *     ecosystem: a block-tier advisory against the pinned version refuses
 *     with the advisory named, so the recipe never trades one red gate for
 *     another;
 *   - verify is a re-audit through the ONE dep-audit dispatch: the order's
 *     package must audit clean afterwards (its known advisories gone AND
 *     nothing new minted on it), or the recipe fails and the diff is
 *     discarded.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { WorkOrder } from '../work-orders/types';
import type { DepAdvisoryEvidence } from '../work-orders/types';
import {
  ambiguousRootReason,
  environmentRefusal,
  osvBlockTier,
  packStrategyAt,
  pickPinVersion,
  resolvePinCapability,
  runResyncInstall,
} from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

function advisories(order: WorkOrder): DepAdvisoryEvidence[] {
  return order.findings
    .map((f) => f.evidence)
    .filter((e): e is DepAdvisoryEvidence => e.type === 'dep-vuln');
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
  // The owning pack's declaration (the ONE resolution `matches` and the plan
  // disclosure also read). At runtime this is the defensive rail: the
  // planner already tiers exemption / unknown orders to the agent.
  const resolved = resolvePinCapability(order);
  if (resolved.kind !== 'capability') {
    return { kind: 'refused', reason: resolved.reason };
  }
  const { pack, provider, rootDir } = resolved;
  // Rule 20, decided before anything spawns: the provider's declared
  // environment requirement gates the whole attempt with a disclosed
  // refusal (the runners' skipped-environment doctrine), never a spawn
  // that fails in a way that reads as a code finding.
  const envRefusal = environmentRefusal(
    `the ${pack} pack's transitive pin`,
    (cwd) => provider.execution(cwd),
    ctx.cwd,
  );
  if (envRefusal) return envRefusal;
  if (rootDir === null) {
    return {
      kind: 'refused',
      reason: ambiguousRootReason(provider.manifestFiles, 'the owning dependency root'),
    };
  }
  const strategy = packStrategyAt(pack, ctx.cwd, rootDir);
  if (strategy === null || strategy.lockfile === null) {
    return {
      kind: 'refused',
      reason: `no lockfile exists at ${rootDir || 'the repo root'}, and an override cannot be verified without one`,
    };
  }

  // The pin: the highest known CONCRETE fixed version clears every advisory
  // at once. Prerelease-aware (1.2.3 outranks 1.2.3-beta.1); a range-shaped
  // fixed string refuses rather than guesses (the registry's `matches`
  // already tiers such orders to the agent, so this is the defensive rail).
  const pin = pickPinVersion(fixedVersions);
  if (pin === null) {
    return {
      kind: 'refused',
      reason:
        `the known fixed versions for '${pkg}' are not all concrete semver values ` +
        `(${fixedVersions.join(', ')}); a range cannot be pinned verbatim`,
    };
  }

  // The pack's pin plan: a pure decision. Refusals here (an override
  // mechanism not implemented for this manager) cost $0 and touch nothing.
  const plan = provider.plan({ cwd: ctx.cwd, rootDir, pkg, version: pin });
  if (plan.kind === 'refused') return { kind: 'refused', reason: plan.reason };

  const notes: string[] = [];

  // $0 pre-check: would the pinned version itself carry a block-tier
  // advisory? A null answer (network) is disclosed and the re-audit verify
  // plus the frame's guardrail stay the backstop; it is never read as clean.
  const known = await ctx.queryOsv(pkg, pin, provider.osvEcosystem);
  if (known === null) {
    notes.push(`OSV pre-check for ${pkg}@${pin} could not be reached; the re-audit verifies`);
  } else {
    const blockTier = osvBlockTier(known, ctx.blockSeverities);
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

  // Apply the pack's pure manifest edit: the executor owns the read and the
  // write; the transform owns the format (and may still refuse: a direct
  // dependency it only sees with the text in hand).
  const rootAbs = path.join(ctx.cwd, rootDir);
  const manifestAbs = path.join(rootAbs, plan.edit.file);
  const edited = plan.edit.transform(fs.readFileSync(manifestAbs, 'utf8'));
  if ('refused' in edited) return { kind: 'refused', reason: edited.refused };
  fs.writeFileSync(manifestAbs, edited.text);

  // The lock resync through the pack's install strategy at the same root
  // (the ONE install seam; never a second install path).
  const installFailure = runResyncInstall(strategy, rootAbs, ctx);
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
  const manifestPath = rootDir ? `${rootDir}/${plan.edit.file}` : plan.edit.file;
  const lockPath = rootDir ? `${rootDir}/${strategy.lockfile}` : strategy.lockfile;
  return {
    kind: 'applied',
    changedFiles: [manifestPath, lockPath],
    revert: plan.revert,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
