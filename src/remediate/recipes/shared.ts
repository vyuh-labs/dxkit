/**
 * Helpers the recipe executors share: the owning-manifest-root derivation
 * (from the order's own envelope and the PACK-DECLARED manifest basenames,
 * never a second discovery walk), the one resync-install runner (the
 * lock-writing install with its declared fallback doctrine, executed
 * through the injected bounded exec), the capability resolution the
 * registry's `matches`, the plan disclosure, and the executors ALL read
 * (one code path, Rule 2.30), the concrete-semver shape, and the OSV
 * pre-checks' block filter, which asks the guardrail's own predicate.
 *
 * Nothing here knows an ecosystem: every manifest name, package-manager
 * command, and override mechanism comes from the packs' `remediation`
 * declarations (`src/languages/capabilities/remediation.ts`, Rule 6). The
 * arch-check bans package-manager literals in this directory.
 */
import * as path from 'path';
import { tail, type CommandOutcome } from '../../analyzers/tools/bounded-exec';
import { classifyOsvSeverity, type OsvVuln } from '../../analyzers/tools/osv';
import { isMaliciousAdvisory } from '../../analyzers/security/malicious';
import { wouldBlockAddedDepVuln, type CandidateDepVuln } from '../../baseline/candidate-verdict';
import type { BrownfieldPolicy } from '../../baseline/policy';
import { getLanguage, languagesDeclaringRemediation, remediationSupport } from '../../languages';
import type { LanguageId } from '../../languages/types';
import type {
  PinTransitiveProvider,
  PinVersionScheme,
  RemediationCapabilityId,
  RemediationSupport,
} from '../../languages/capabilities/remediation';
import {
  installCommandText,
  type InstallStrategy,
} from '../../languages/capabilities/install-strategy';
import { describeInfrastructure, runInstall } from '../../install/run';
// exec-requirement-ok: this is the recipe tier's ONE Rule 20 consumption
// point (environmentRefusal below); both dependency executors route their
// pre-spawn gate through it, mirroring the runners' disclosed skips.
import { currentEnvironment, describeUnmetRequirement, unmetRequirement } from '../../execution';
import type { ExecutionRequirement } from '../../execution';
import type { WorkOrder } from '../work-orders/types';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

// The concrete-semver shape and the default pin grammar live on the seam
// itself (`capabilities/remediation.ts`), beside `PinVersionScheme`, so a
// pack composing on the semver order (go's v-prefixed grammar) reads the
// ONE comparator. Re-exported here for the recipe tier's consumers.
import { DEFAULT_PIN_VERSIONS } from '../../languages/capabilities/remediation';
export {
  compareConcreteSemver,
  DEFAULT_PIN_VERSIONS,
  isConcreteSemver,
} from '../../languages/capabilities/remediation';

/** The version grammar serving a pin provider: its declared scheme, or the
 *  semver default. The ONE resolution consumed by the registry's `matches`
 *  and the executor's pick, so the tier decision and the runtime pick can
 *  never grade a fixed version differently. */
export function pinVersionScheme(
  provider: Pick<PinTransitiveProvider, 'versions'>,
): PinVersionScheme {
  return provider.versions ?? DEFAULT_PIN_VERSIONS;
}

/** The pin an override-pin order applies: the highest CONCRETE version among
 *  the known fixed versions under the owning pack's version grammar, or
 *  null when any is range-shaped (refuse, never guess a range's meaning). */
export function pickPinVersion(
  versions: readonly string[],
  scheme: PinVersionScheme = DEFAULT_PIN_VERSIONS,
): string | null {
  if (versions.length === 0 || !versions.every((v) => scheme.concrete(v))) return null;
  return versions.reduce((best, v) => (scheme.compare(v, best) > 0 ? v : best));
}

/** What the recipe knows about the candidate PACKAGE beyond what OSV says
 *  about the version: reachability is a property of the repo's import graph,
 *  so the order's own findings answer it (any reachable advisory on the
 *  package means the package is reachable). Absent = not known here. */
export interface OsvCandidateSignals {
  readonly reachable?: boolean;
}

/** One OSV record as the guardrail would see it: its severity through the
 *  ONE OSV classifier (`unknown` stays ABSENT, which the guardrail treats
 *  conservatively, never as low), the malicious signal through the ONE
 *  canonical predicate, and the package's reachability from the order. */
export function osvCandidate(vuln: OsvVuln, signals: OsvCandidateSignals = {}): CandidateDepVuln {
  const severity = classifyOsvSeverity(vuln);
  const malicious = isMaliciousAdvisory({
    id: vuln.id ?? '',
    ...(vuln.aliases !== undefined ? { aliases: vuln.aliases } : {}),
    ...(vuln.summary !== undefined ? { summary: vuln.summary } : {}),
  });
  return {
    ...(severity !== 'unknown' ? { severity } : {}),
    ...(signals.reachable === true ? { reachable: true } : {}),
    ...(malicious ? { malicious: true } : {}),
  };
}

/**
 * The advisories on a candidate version that the guardrail would BLOCK as
 * `added` (Rule 2.30, #371): which advisories REFUSE a recipe is the exact
 * question the frame's guardrail answers afterwards, so each record is put
 * to the guardrail's own predicate (`wouldBlockAddedDepVuln`: the policy's
 * `block` list plus its armed block rules, through `classify` itself), never
 * a sibling severity knob. The shipped class: the pre-check read
 * `newAdvisories.blockSeverities`, the tier for advisories published AFTER
 * capture, which a repo can legitimately set to `[]`; that disarmed the
 * pre-check while the guardrail still blocked every `added` dep-vuln.
 */
export function osvBlockingAdvisories(
  vulns: readonly OsvVuln[],
  policy: BrownfieldPolicy,
  signals: OsvCandidateSignals = {},
): OsvVuln[] {
  return vulns.filter((v) => wouldBlockAddedDepVuln(policy, osvCandidate(v, signals)));
}

/** The one infrastructure-shaped triage of a bounded-exec outcome: null when
 *  the command ran to completion cleanly; a named `failed` otherwise. The
 *  resync runner and the declare-dependency install share it. */
export function execStepFailure(
  step: string,
  label: string,
  outcome: CommandOutcome,
): Extract<RecipeOutcome, { kind: 'failed' }> | null {
  if (!outcome.available) {
    return { kind: 'failed', step, output: `${label}: binary not available here` };
  }
  if (outcome.timedOut) return { kind: 'failed', step, output: `${label} timed out` };
  if (outcome.overflowed) {
    return { kind: 'failed', step, output: `${label} overflowed the capture buffer` };
  }
  if (outcome.code !== 0) {
    return { kind: 'failed', step, output: tail(`${label}: ${outcome.output || 'non-zero exit'}`) };
  }
  return null;
}

/**
 * The dependency root an order's fix belongs to, derived from the order's
 * OWN envelope (the planner already scoped it): the directory of the ONE
 * envelope entry whose basename is among the pack-declared manifest
 * basenames. Two roots in one envelope means the planner could not decide
 * (the all-roots fallback); the recipe refuses rather than guess which
 * manifest to edit.
 */
export function owningManifestRoot(
  order: WorkOrder,
  manifestFiles: readonly string[],
): string | null {
  return owningManifestEntry(order, manifestFiles)?.dir ?? null;
}

/** The owning root WITH the manifest basename the envelope matched (the
 *  file a dependency edit's `changedFiles` names). When several declared
 *  basenames sit at ONE root, the FIRST-declared one wins deterministically
 *  (`manifestFiles` order is the pack's preference order, part of the
 *  provider contract); envelope order never decides. */
export function owningManifestEntry(
  order: WorkOrder,
  manifestFiles: readonly string[],
): { dir: string; file: string } | null {
  const dirs = new Map<string, string>();
  for (const f of manifestFiles) {
    for (const p of order.envelope.paths) {
      const dir = p === f ? '' : p.endsWith(`/${f}`) ? p.slice(0, -(f.length + 1)) : null;
      if (dir !== null && !dirs.has(dir)) dirs.set(dir, f);
    }
  }
  if (dirs.size !== 1) return null;
  const [dir, file] = [...dirs.entries()][0];
  return { dir, file };
}

/** The ONE refusal phrasing for an envelope that does not resolve one
 *  owning root (shared by every dependency-shaped recipe). */
export function ambiguousRootReason(manifestFiles: readonly string[], what: string): string {
  return (
    `the envelope does not name exactly one ${manifestFiles.join(' / ')}, so ` +
    `${what} is ambiguous`
  );
}

/** The producing pack's install strategy at `rootDir` (repo-relative;
 *  '' = repo root), through the pack's ONE install seam (Rule 2: the
 *  resync command and the lockfile come from `installStrategy`, never a
 *  second table in a recipe). */
export function packStrategyAt(pack: string, cwd: string, rootDir: string): InstallStrategy | null {
  return packInstallStrategy(pack)?.strategy(path.join(cwd, rootDir)) ?? null;
}

/** A pack's install-strategy provider by evidence pack id (a plain string). */
export function packInstallStrategy(pack: string) {
  return getLanguage(pack as LanguageId)?.installStrategy;
}

/** A pack's remediation declaration for one capability, by evidence pack
 *  id. Undefined only when no registered pack carries the id. */
export function packDeclaration<K extends RemediationCapabilityId>(
  pack: string,
  capability: K,
): RemediationSupport[K] | undefined {
  return remediationSupport(pack)?.[capability];
}

/** How the executors and the registry's `matches` name a pack's declared
 *  exemption in refusals and plan output (one phrasing). */
export function exemptionReason(pack: string, exemption: { reason: string }): string {
  return `the ${pack} pack declares this capability exempt: ${exemption.reason}`;
}

/**
 * The Rule 20 gate for a remediation provider's spawns, decided BEFORE
 * anything runs: the provider's declared `execution(cwd)` against the ONE
 * environment probe, phrased by the ONE describer (the same disclosed-skip
 * doctrine the correctness and custom-check runners apply). Null when the
 * environment satisfies the requirement; a disclosed refusal otherwise, so
 * an environment boundary reads as routing ("runs where windows is
 * available"), never as a code failure.
 */
export function environmentRefusal(
  what: string,
  execution: (cwd: string) => ExecutionRequirement,
  cwd: string,
): Extract<RecipeOutcome, { kind: 'refused' }> | null {
  const env = currentEnvironment();
  const unmet = unmetRequirement(execution(cwd), env);
  if (unmet === null) return null;
  return {
    kind: 'refused',
    reason: `${what} cannot run in this environment: ${describeUnmetRequirement(unmet, env.host)}`,
  };
}

/**
 * Resolve the `pinTransitive` capability serving a dependency-advisory
 * order, the ONE resolution the registry's `matches`, the plan's exemption
 * disclosure, and the override-pin executor all consume (Rule 2.30):
 *
 *   - when the order's dep-vuln evidence names exactly one producing pack,
 *     that pack's declaration decides (capability or exemption);
 *   - when the evidence names none (a baseline-debt advisory predating the
 *     pack stamp), the unique registry pack DECLARING the capability whose
 *     manifest basenames resolve an owning root in the envelope serves it;
 *   - anything else is `unknown` (ambiguous evidence, or no declaring pack
 *     matches the envelope), and the order stays on the agent tier.
 *
 * Pure over the order and the pack registry: no repo file is read, so the
 * planner's tier decision stays order-intrinsic.
 */
export type PinResolution =
  | {
      readonly kind: 'capability';
      readonly pack: string;
      readonly provider: PinTransitiveProvider;
      readonly rootDir: string | null;
    }
  | { readonly kind: 'exemption'; readonly pack: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export function resolvePinCapability(order: WorkOrder): PinResolution {
  const evidencePacks = new Set<string>();
  for (const f of order.findings) {
    if (f.evidence.type === 'dep-vuln' && f.evidence.pack !== undefined) {
      evidencePacks.add(f.evidence.pack);
    }
  }
  if (evidencePacks.size > 1) {
    return {
      kind: 'unknown',
      reason: `the order's findings name more than one producing pack (${[...evidencePacks].sort().join(', ')})`,
    };
  }
  if (evidencePacks.size === 1) {
    const pack = [...evidencePacks][0];
    const declaration = packDeclaration(pack, 'pinTransitive');
    if (declaration === undefined) {
      return { kind: 'unknown', reason: `no registered language pack has the id '${pack}'` };
    }
    if (declaration.kind === 'exemption') {
      return { kind: 'exemption', pack, reason: declaration.reason };
    }
    return {
      kind: 'capability',
      pack,
      provider: declaration.provider,
      rootDir: owningManifestRoot(order, declaration.provider.manifestFiles),
    };
  }
  const candidates = languagesDeclaringRemediation('pinTransitive').flatMap((l) => {
    const declaration = l.remediation.pinTransitive;
    if (declaration.kind !== 'capability') return [];
    const rootDir = owningManifestRoot(order, declaration.provider.manifestFiles);
    return rootDir === null ? [] : [{ pack: l.id, provider: declaration.provider, rootDir }];
  });
  if (candidates.length === 1) return { kind: 'capability', ...candidates[0] };
  return {
    kind: 'unknown',
    reason:
      candidates.length === 0
        ? 'no pack declaring transitive pinning owns a manifest the envelope names'
        : `the envelope matches more than one pack's manifest (${candidates.map((c) => c.pack).join(', ')})`,
  };
}

/**
 * Run a strategy's lock-writing RESYNC at a root through the ONE install
 * executor (the declared fallback ladder under the repo's authorized
 * tolerances, never a blanket retry). Returns null on success, or a
 * `failed` outcome naming the step. Infrastructure (missing binary,
 * timeout, capture overflow) is a failure of THIS recipe run, named; the
 * order simply stays open for the agent tier. A strategy with no resync
 * mode is a named failure too: the recipe cannot rewrite what the
 * ecosystem gives it no command for.
 */
export function runResyncInstall(
  strategy: InstallStrategy,
  rootAbs: string,
  ctx: Pick<RecipeExecuteContext, 'exec' | 'tolerances'>,
): Extract<RecipeOutcome, { kind: 'failed' }> | null {
  const plan = strategy.modes.resync;
  if (plan === undefined) {
    return {
      kind: 'failed',
      step: 'install',
      output: `the ${strategy.manager} install strategy declares no lock-writing resync`,
    };
  }
  const r = runInstall(plan, rootAbs, ctx.exec, ctx.tolerances, {
    execution: strategy.execution,
  });
  switch (r.status) {
    case 'ok':
      return null;
    case 'infrastructure':
      return { kind: 'failed', step: 'install', output: describeInfrastructure(r) };
    case 'failed':
      return {
        kind: 'failed',
        step: 'install',
        output: tail(`${installCommandText(r.command)}: ${r.output || 'non-zero exit'}`),
      };
  }
}
