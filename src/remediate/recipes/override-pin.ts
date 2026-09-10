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
 *     ecosystem, and every advisory against it is put to the GUARDRAIL'S OWN
 *     block predicate over the run's policy (`osvBlockingAdvisories`, Rule
 *     2.30, #371), never a sibling severity knob. An advisory with a concrete
 *     fixed version RAISES the pin to it and re-checks (bounded, disclosed:
 *     "raised from X to Y: GHSA-... on X"), so the recipe walks to the first
 *     clean version instead of handing the order to an agent that re-applies
 *     the same pin; a blocking advisory with no concrete fix refuses with
 *     the advisory and version named, so the recipe never trades one red
 *     gate for another;
 *   - verify is a re-audit through the ONE dep-audit dispatch: the order's
 *     package must audit clean afterwards (its known advisories gone AND
 *     nothing new minted on it), or the recipe fails and the diff is
 *     discarded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractOsvFixedEvents, selectFixVersion, type OsvVuln } from '../../analyzers/tools/osv';
import type {
  PinTransitiveProvider,
  PinVersionScheme,
} from '../../languages/capabilities/remediation';
import type { WorkOrder } from '../work-orders/types';
import type { DepAdvisoryEvidence } from '../work-orders/types';
import {
  ambiguousRootReason,
  environmentRefusal,
  execStepFailure,
  osvBlockingAdvisories,
  packStrategyAt,
  pickPinVersion,
  pinVersionScheme,
  resolvePinCapability,
  runResyncInstall,
} from './shared';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

/** The most raises one order pays before refusing: each hop is one cached
 *  OSV query, and a package whose every fixed version carries a further
 *  advisory is agent (or human) territory, not a recipe walking forever. */
export const MAX_PIN_RAISES = 3;

type PinPrecheck =
  | { readonly kind: 'clean'; readonly pin: string; readonly notes: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

function advisoryId(v: OsvVuln): string {
  return v.id ?? 'unidentified advisory';
}

/** The fixed version that clears THIS pin for one advisory: the smallest
 *  fixed event above it under the owning pack's version grammar (the ONE
 *  selection `resolveFixVersions` uses, with the pack's comparator), or
 *  null when the record declares no concrete fix above the pin. */
function fixAbove(vuln: OsvVuln, pin: string, scheme: PinVersionScheme): string | null {
  const events = extractOsvFixedEvents(vuln).filter((e) => scheme.concrete(e));
  return selectFixVersion(events, pin, scheme.compare) ?? null;
}

/**
 * The $0 pre-check, as a bounded walk: ask OSV about the candidate, put
 * every advisory to the guardrail's block predicate, and either accept the
 * pin, RAISE it to the highest fixed version the advisories declare and
 * re-check, or refuse with the advisory and version that drove it.
 *
 *   - a null OSV answer is a DISCLOSED note (the re-audit and the frame's
 *     guardrail stay the backstop); it is never read as clean;
 *   - a BLOCKING advisory with no concrete fix above the pin refuses (the
 *     guardrail would go red, and no version this recipe can pick clears it);
 *   - any advisory with a concrete fix raises the pin (blocking or not: the
 *     re-audit verify demands the package audit CLEAN, so applying a version
 *     a known advisory still covers only buys a verify failure);
 *   - a non-blocking advisory with no fix is disclosed and the pin proceeds
 *     (the guardrail would warn, not block; the re-audit decides);
 *   - the walk is bounded by `MAX_PIN_RAISES`.
 */
async function precheckPin(args: {
  readonly pkg: string;
  readonly pin: string;
  readonly provider: PinTransitiveProvider;
  readonly scheme: PinVersionScheme;
  readonly reachable: boolean | undefined;
  readonly ctx: RecipeExecuteContext;
}): Promise<PinPrecheck> {
  const { pkg, provider, scheme, ctx } = args;
  const notes: string[] = [];
  let pin = args.pin;
  for (let raises = 0; ; raises += 1) {
    // The pack may declare the form OSV stores (go: bare, no v prefix) so
    // the pre-check queries what the database actually records.
    const osvPin = provider.osvVersion?.(pin) ?? pin;
    const known = await ctx.queryOsv(pkg, osvPin, provider.osvEcosystem);
    if (known === null) {
      notes.push(`OSV pre-check for ${pkg}@${pin} could not be reached; the re-audit verifies`);
      return { kind: 'clean', pin, notes };
    }
    if (known.length === 0) return { kind: 'clean', pin, notes };
    const blocking = new Set(
      osvBlockingAdvisories(known, ctx.policy, {
        ...(args.reachable === true ? { reachable: true } : {}),
      }),
    );
    const fixed = known.map((v) => ({ vuln: v, fix: fixAbove(v, pin, scheme) }));
    const raisedSoFar = notes.length > 0 ? ` (after ${notes.join('; ')})` : '';
    const unfixableBlocking = fixed.filter((f) => f.fix === null && blocking.has(f.vuln));
    if (unfixableBlocking.length > 0) {
      const ids = unfixableBlocking.map((f) => advisoryId(f.vuln)).join(', ');
      return {
        kind: 'refused',
        reason:
          `pinning ${pkg} to ${pin} would leave a block-tier advisory in place: ${ids} on ` +
          `${pin}, with no concrete fixed version above ${pin} known${raisedSoFar}. ` +
          'A different fix is needed; not applying',
      };
    }
    const raisable = fixed.filter((f): f is { vuln: OsvVuln; fix: string } => f.fix !== null);
    if (raisable.length === 0) {
      // Only non-blocking advisories without a fix remain: the guardrail
      // would warn, not block. Disclosed; the re-audit verify decides.
      notes.push(
        `${pkg}@${pin} still carries ${known.map(advisoryId).join(', ')}, below this repo's ` +
          `block tier and with no concrete fixed version above ${pin}; the re-audit verifies`,
      );
      return { kind: 'clean', pin, notes };
    }
    if (raises === MAX_PIN_RAISES) {
      return {
        kind: 'refused',
        reason:
          `${pkg}@${pin} still carries ${raisable.map((f) => advisoryId(f.vuln)).join(', ')} ` +
          `after ${MAX_PIN_RAISES} raises${raisedSoFar}; not walking further. ` +
          'A different fix is needed; not applying',
      };
    }
    // The highest fix across the advisories clears every one of them at
    // once (the same pick the initial pin made over the order's own fixes).
    const next = pickPinVersion(
      raisable.map((f) => f.fix),
      scheme,
    )!;
    notes.push(
      `raised from ${pin} to ${next}: ` +
        raisable.map((f) => `${advisoryId(f.vuln)} on ${pin}`).join(', '),
    );
    pin = next;
  }
}

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

  // The pin: the highest known CONCRETE fixed version (under the owning
  // pack's declared version grammar, the same scheme the registry's
  // `matches` graded) clears every advisory at once. A range-shaped fixed
  // string refuses rather than guesses (the planner already tiers such
  // orders to the agent, so this is the defensive rail).
  const scheme = pinVersionScheme(provider);
  const initial = pickPinVersion(fixedVersions, scheme);
  if (initial === null) {
    return {
      kind: 'refused',
      reason:
        `the known fixed versions for '${pkg}' are not all concrete versions this ` +
        `ecosystem can pin verbatim (${fixedVersions.join(', ')})`,
    };
  }

  // $0 pre-check, then the raise walk: would the pinned version itself
  // carry an advisory the guardrail blocks? Reachability is the package's
  // (the import graph does not change with the pinned version), so the
  // order's own findings answer it for every hop.
  const reachable = advs.some((a) => a.reachable === true) ? true : undefined;
  const checked = await precheckPin({ pkg, pin: initial, provider, scheme, reachable, ctx });
  if (checked.kind === 'refused') return checked;
  const pin = checked.pin;

  // The pack's pin plan on the FINAL pin: a pure decision. Refusals here
  // (an override mechanism not implemented for this manager) cost nothing
  // beyond the cached OSV answers and touch nothing.
  const plan = provider.plan({ cwd: ctx.cwd, rootDir, pkg, version: pin });
  if (plan.kind === 'refused') return { kind: 'refused', reason: plan.reason };

  // The ledger's disclosures: the pre-check's raises / unreachable notes,
  // then the pack-declared side effects (composer's lock resync may refresh
  // unrelated packages).
  const notes: string[] = [...checked.notes, ...(plan.notes ?? [])];

  // Apply the pin, per the plan's declared shape:
  //   - an EDIT plan: the executor owns the read and the write; the pack's
  //     pure transform owns the format (and may still refuse: a direct
  //     dependency it only sees with the text in hand). Then the lock
  //     resync through the pack's install strategy at the same root (the
  //     ONE install seam; never a second install path).
  //   - a COMMAND plan (the tool-owned ecosystems): the pack's declared
  //     command rewrites the dependency files itself, consistently, so no
  //     separate resync runs.
  const rootAbs = path.join(ctx.cwd, rootDir);
  let changedFiles: string[];
  if (plan.kind === 'command') {
    const applied = ctx.exec({ bin: plan.command.bin, args: [...plan.command.args] }, rootAbs);
    const failure = execStepFailure(
      'apply-pin',
      [plan.command.bin, ...plan.command.args].join(' '),
      applied,
    );
    if (failure) return failure;
    changedFiles = plan.writes.map((f) => (rootDir ? `${rootDir}/${f}` : f));
  } else {
    const manifestAbs = path.join(rootAbs, plan.edit.file);
    const edited = plan.edit.transform(fs.readFileSync(manifestAbs, 'utf8'));
    if ('refused' in edited) return { kind: 'refused', reason: edited.refused };
    fs.writeFileSync(manifestAbs, edited.text);

    const installFailure = runResyncInstall(strategy, rootAbs, ctx);
    if (installFailure) return installFailure;
    const manifestPath = rootDir ? `${rootDir}/${plan.edit.file}` : plan.edit.file;
    const lockPath = rootDir ? `${rootDir}/${strategy.lockfile}` : strategy.lockfile;
    changedFiles = [manifestPath, lockPath];
  }

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
  return {
    kind: 'applied',
    changedFiles,
    revert: plan.revert,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
