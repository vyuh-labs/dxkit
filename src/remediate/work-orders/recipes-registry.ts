/**
 * The recipe registry (remediate rethink, section 3B): the deterministic tier.
 *
 * Each entry declares `{ id, class, matches }` for the planner's tier
 * decision AND (4.4.5) its `execute`, the deterministic executor the
 * remediate frame runs BEFORE any agent spawns (`src/remediate/recipes/`).
 * `implemented` and `execute` are one fact stated twice for the plan
 * surface's benefit; the contract test pins `implemented === (execute !==
 * undefined)` so they cannot drift.
 *
 * The class each recipe serves is a READ of the class table (`recipe` on
 * `WORK_ORDER_CLASSES`); the contract test pins that every declared recipe
 * id is named there and vice versa. `matches` is consulted only for orders
 * of the recipe's own class.
 *
 * Every ecosystem fact `matches` consults comes from the packs' declared
 * `remediation` capabilities (Rule 6): which packs can pin, declare, resync
 * or lint-fix is a registry read, never a hardcoded pack list. When a
 * recipe declines an order BECAUSE its owning pack declares the capability
 * exempt, `packExemption` names the pack and the declared reason so the
 * planner can disclose it on the order (never a silent agent tier).
 */
import { isProjectPathIdentity } from '../../languages/capabilities/correctness';
import { getLanguage } from '../../languages';
import type { LanguageId } from '../../languages/types';
import type { RemediationCapabilityId } from '../../languages/capabilities/remediation';
import { executeDeclareDependency } from '../recipes/declare-dependency';
import { executeLintAutofix, lintPackOf } from '../recipes/lint-autofix';
import { executeLockfileSync } from '../recipes/lockfile-sync';
import { executeOverridePin } from '../recipes/override-pin';
import {
  isConcreteSemver,
  owningManifestRoot,
  packDeclaration,
  resolvePinCapability,
} from '../recipes/shared';
import type { RecipeExecuteContext, RecipeOutcome } from '../recipes/types';
import {
  WORK_ORDER_CLASSES,
  type CapabilityExemption,
  type WorkOrder,
  type WorkOrderClass,
} from './types';

// ---------------------------------------------------------------------------
// Feasibility predicates for `matches` (4.4.5 review): every fact knowable
// from the ORDER ITSELF (its evidence, its envelope, the packs' declared
// capabilities) is decided HERE, so an order a recipe's executor would
// always refuse tiers `agent` and the plan never renders it as executable
// determinism. Runtime refusals remain only for repo-state facts (which
// lockfile is present, whether the package is a direct dependency, what the
// registry and OSV answer).
// ---------------------------------------------------------------------------

/** The producing pack, when every finding is floor evidence from one pack. */
function floorPackOf(order: WorkOrder): string | null {
  const packs = new Set(
    order.findings.map((f) => (f.evidence.type === 'floor' ? f.evidence.pack : null)),
  );
  return packs.size === 1 ? [...packs][0] : null;
}

/** The file a located-lint order fixes (its grouping key). */
function lintFileOf(order: WorkOrder): string | null {
  const first = order.findings[0]?.evidence;
  return first && first.type === 'custom-check' && first.file ? first.file : null;
}

/** The lint pack behind a lint-located order's check name, or null. */
function lintOrderPack(order: WorkOrder): string | null {
  const first = order.findings[0]?.evidence;
  return first && first.type === 'custom-check' ? lintPackOf(first.check) : null;
}

/** A pack's declared exemption for one capability, shaped for the order's
 *  plan disclosure, or null when the pack declares a real provider (or the
 *  pack cannot be resolved at all). */
function exemptionOf(
  pack: string | null,
  capability: RemediationCapabilityId,
): CapabilityExemption | null {
  if (pack === null) return null;
  const declaration = packDeclaration(pack, capability);
  if (declaration === undefined || declaration.kind !== 'exemption') return null;
  return { pack, capability, reason: declaration.reason };
}

export interface RecipeDeclaration {
  readonly id: string;
  /** The work-order class this recipe serves. */
  readonly class: WorkOrderClass;
  /** One-line intent, rendered in the plan surface. */
  readonly summary: string;
  /** Whether an executor exists for this id. `false` = declared for tiering
   *  and planning only; the plan says "recipe (not yet executable)". Must
   *  equal `execute !== undefined` (pinned by the contract test). */
  readonly implemented: boolean;
  /** Does this recipe apply to THIS order? Pure over the order's findings and
   *  evidence plus the packs' declared capabilities (a recipe never inspects
   *  the repo at planning time). */
  readonly matches: (order: WorkOrder) => boolean;
  /** The deterministic executor (4.4.5), present iff `implemented`. Runs
   *  inside the remediate frame through the injected bounded exec under the
   *  required trust context; see `../recipes/types.ts` for the contract. */
  readonly execute?: (order: WorkOrder, ctx: RecipeExecuteContext) => Promise<RecipeOutcome>;
  /** OPTIONAL: orders of this recipe with the same non-null key execute as
   *  ONE attempt (the runner merges their findings, runs `execute` once,
   *  and evaluates each order's done individually). Today: lint-autofix
   *  keys by file, because `eslint --fix` on the whole file is one run
   *  whatever slice asked for it (40 slices of one file must not pay 40
   *  linter runs), and any slice's done criterion is checkable against
   *  the one result. */
  readonly groupKey?: (order: WorkOrder) => string | null;
  /** OPTIONAL: when `matches` declines an order BECAUSE the owning pack
   *  declares the needed remediation capability as an exemption, name the
   *  pack, the capability, and the declared reason (the planner discloses
   *  it on the order). Null when the declining reason is anything else
   *  (a range-shaped version, an ambiguous root). Pure. */
  readonly packExemption?: (order: WorkOrder) => CapabilityExemption | null;
}

/** The class a recipe id serves, from the one table. */
function classServedBy(recipeId: string): WorkOrderClass {
  const found = (Object.keys(WORK_ORDER_CLASSES) as Array<keyof typeof WORK_ORDER_CLASSES>).find(
    (c) => WORK_ORDER_CLASSES[c].recipe === recipeId,
  );
  if (!found) throw new Error(`recipe '${recipeId}' is not named by any work-order class`);
  return found;
}

export const RECIPE_REGISTRY: readonly RecipeDeclaration[] = [
  {
    id: 'lockfile-sync',
    class: classServedBy('lockfile-sync'),
    summary: "reinstall with the repo's package manager so the lockfile follows the manifest",
    implemented: true,
    // The producing pack must declare the resync capability (which rides its
    // install strategy) plus the frozen dry-run this recipe verifies with,
    // and the envelope must name one owning root under the pack's declared
    // manifest basenames.
    matches: (order) => {
      const pack = floorPackOf(order);
      if (pack === null || order.constraints.install === undefined) return false;
      const declaration = packDeclaration(pack, 'resyncLockfile');
      return (
        declaration !== undefined &&
        declaration.kind === 'capability' &&
        owningManifestRoot(order, declaration.provider.manifestFiles) !== null &&
        getLanguage(pack as LanguageId)?.correctness?.lockfileCheck !== undefined
      );
    },
    execute: executeLockfileSync,
    packExemption: (order) => exemptionOf(floorPackOf(order), 'resyncLockfile'),
  },
  {
    id: 'override-pin',
    class: classServedBy('override-pin'),
    summary:
      'pin a fixed version through a pack-declared override when no direct upgrade path exists',
    implemented: true,
    // Needs a known CONCRETE fixed version for EVERY advisory in the order
    // (a range-shaped fixed string cannot be pinned verbatim), an owning
    // pack that declares the pin capability, one owning root under its
    // manifests, and an install command the frame can run; an advisory with
    // no fix is agent (or human) territory.
    matches: (order) => {
      if (order.constraints.install === undefined || order.findings.length === 0) return false;
      const resolved = resolvePinCapability(order);
      return (
        resolved.kind === 'capability' &&
        resolved.rootDir !== null &&
        order.findings.every(
          (f) =>
            f.evidence.type === 'dep-vuln' &&
            typeof f.evidence.fixedVersion === 'string' &&
            isConcreteSemver(f.evidence.fixedVersion),
        )
      );
    },
    execute: executeOverridePin,
    packExemption: (order) => {
      const resolved = resolvePinCapability(order);
      return resolved.kind === 'exemption'
        ? { pack: resolved.pack, capability: 'pinTransitive', reason: resolved.reason }
        : null;
    },
  },
  {
    id: 'declare-dependency',
    class: classServedBy('declare-dependency'),
    summary:
      'declare and install a bare import, refusing with the reason when the candidate carries a block-tier advisory',
    implemented: true,
    // Every finding must carry an unresolved specifier that passes the
    // owning pack's declared specifier rail. Bareness is a producer fact
    // (the resolutionCheck contract): a project-path identity (leading
    // `./`, the ONE canonical discriminator `isProjectPathIdentity`) names
    // a missing FILE, which no install can declare; the pack's name shape
    // additionally keeps a flag-shaped specifier out of the recipe tier
    // (the executor re-checks it as the injection rail). Pack support and
    // the owning root are declaration reads; the frame must hold the
    // install command.
    matches: (order) => {
      const pack = floorPackOf(order);
      if (pack === null || order.constraints.install === undefined) return false;
      const declaration = packDeclaration(pack, 'declareDependency');
      if (declaration === undefined || declaration.kind !== 'capability') return false;
      const provider = declaration.provider;
      return (
        owningManifestRoot(order, provider.manifestFiles) !== null &&
        order.findings.length > 0 &&
        order.findings.every(
          (f) =>
            f.evidence.type === 'floor' &&
            typeof f.evidence.specifier === 'string' &&
            !isProjectPathIdentity(f.evidence.specifier) &&
            provider.validSpecifier(f.evidence.specifier),
        )
      );
    },
    execute: executeDeclareDependency,
    packExemption: (order) => exemptionOf(floorPackOf(order), 'declareDependency'),
  },
  {
    id: 'lint-autofix',
    class: classServedBy('lint-autofix'),
    summary: "the pack linter's own autofix, restricted to the order's file and rules",
    implemented: true,
    // Every finding must carry a rule (an unparsed diagnostic cannot be
    // scoped to a fixer) and the check must be a PACK lint gate whose pack
    // declares the lintFix capability (the rider over the lint gate's
    // fixCommand, pinned consistent by the contract test). Sliced orders
    // ARE eligible: the grouped execution (groupKey) runs the file-level
    // fix once for all of a file's slices and evaluates each slice's done
    // individually. Which rules the fixer actually closes stays the
    // executor's runtime verify.
    matches: (order) => {
      if (order.findings.length === 0) return false;
      const pack = lintOrderPack(order);
      return (
        pack !== null &&
        packDeclaration(pack, 'lintFix')?.kind === 'capability' &&
        order.findings.every(
          (f) => f.evidence.type === 'custom-check' && typeof f.evidence.rule === 'string',
        )
      );
    },
    execute: executeLintAutofix,
    groupKey: lintFileOf,
    packExemption: (order) => exemptionOf(lintOrderPack(order), 'lintFix'),
  },
];

/** The first recipe of the order's class whose `matches` accepts it. */
export function matchRecipe(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.class === order.class && r.matches(order));
}

/** The first declared pack exemption blocking a recipe of the order's
 *  class, for the plan's disclosure (consulted only when no recipe
 *  matched). */
export function matchPackExemption(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): CapabilityExemption | null {
  for (const r of registry) {
    if (r.class !== order.class || r.packExemption === undefined) continue;
    const exemption = r.packExemption(order);
    if (exemption !== null) return exemption;
  }
  return null;
}
