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
 */
import { isProjectPathIdentity } from '../../languages/capabilities/correctness';
import { getLanguage } from '../../languages';
import type { LanguageId } from '../../languages/types';
import { DECLARABLE_PACKS, executeDeclareDependency } from '../recipes/declare-dependency';
import { executeLintAutofix, lintPackOf } from '../recipes/lint-autofix';
import { executeLockfileSync } from '../recipes/lockfile-sync';
import { executeOverridePin } from '../recipes/override-pin';
import { isConcreteSemver, isValidNpmPackageName, owningManifestRoot } from '../recipes/shared';
import type { RecipeExecuteContext, RecipeOutcome } from '../recipes/types';
import { WORK_ORDER_CLASSES, type WorkOrder, type WorkOrderClass } from './types';

// ---------------------------------------------------------------------------
// Feasibility predicates for `matches` (4.4.5 review): every fact knowable
// from the ORDER ITSELF (its evidence, its envelope, the packs' declared
// capabilities) is decided HERE, so an order a recipe's executor would
// always refuse tiers `agent` and the plan never renders it as executable
// determinism. Runtime refusals remain only for repo-state facts (which
// lockfile is present, whether the package is a direct dependency, what the
// registry and OSV answer).
// ---------------------------------------------------------------------------

/** The envelope names exactly one owning package.json root. */
function hasOneManifestRoot(order: WorkOrder): boolean {
  return owningManifestRoot(order) !== null;
}

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
   *  evidence (a recipe never inspects the repo at planning time). */
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
    // The producing pack must declare the frozen dry-run this recipe
    // verifies with, and the envelope must name one owning root.
    matches: (order) => {
      const pack = floorPackOf(order);
      return (
        order.constraints.install !== undefined &&
        hasOneManifestRoot(order) &&
        pack !== null &&
        getLanguage(pack as LanguageId)?.correctness?.lockfileCheck !== undefined
      );
    },
    execute: executeLockfileSync,
  },
  {
    id: 'override-pin',
    class: classServedBy('override-pin'),
    summary: 'pin a fixed version through a pm-aware override when no direct upgrade path exists',
    implemented: true,
    // Needs a known CONCRETE fixed version for EVERY advisory in the order
    // (a range-shaped fixed string cannot be pinned verbatim), one owning
    // root, and an install command the frame can run; an advisory with no
    // fix is agent (or human) territory.
    matches: (order) =>
      order.constraints.install !== undefined &&
      hasOneManifestRoot(order) &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) =>
          f.evidence.type === 'dep-vuln' &&
          typeof f.evidence.fixedVersion === 'string' &&
          isConcreteSemver(f.evidence.fixedVersion),
      ),
    execute: executeOverridePin,
  },
  {
    id: 'declare-dependency',
    class: classServedBy('declare-dependency'),
    summary:
      'declare and install a bare import, refusing with the reason when the candidate carries a block-tier advisory',
    implemented: true,
    // Every finding must carry an unresolved specifier that is a VALID npm
    // package name. Bareness is a producer fact (the resolutionCheck
    // contract): a project-path identity (leading `./`, the ONE canonical
    // discriminator `isProjectPathIdentity`) names a missing FILE, which no
    // install can declare; the strict name shape additionally keeps a
    // flag-shaped specifier out of the recipe tier (the executor re-checks
    // it as the injection rail). Pack support and the owning root are
    // order-intrinsic too; the frame must hold the install command.
    matches: (order) => {
      const pack = floorPackOf(order);
      return (
        order.constraints.install !== undefined &&
        hasOneManifestRoot(order) &&
        pack !== null &&
        DECLARABLE_PACKS.includes(pack) &&
        order.findings.length > 0 &&
        order.findings.every(
          (f) =>
            f.evidence.type === 'floor' &&
            typeof f.evidence.specifier === 'string' &&
            !isProjectPathIdentity(f.evidence.specifier) &&
            isValidNpmPackageName(f.evidence.specifier),
        )
      );
    },
    execute: executeDeclareDependency,
  },
  {
    id: 'lint-autofix',
    class: classServedBy('lint-autofix'),
    summary: "the pack linter's own autofix, restricted to the order's file and rules",
    implemented: true,
    // Every finding must carry a rule (an unparsed diagnostic cannot be
    // scoped to a fixer) and the check must be a PACK lint gate whose pack
    // declares a fix mode. Sliced orders ARE eligible: the grouped
    // execution (groupKey) runs the file-level fix once for all of a
    // file's slices and evaluates each slice's done individually. Which
    // rules the fixer actually closes stays the executor's runtime verify.
    matches: (order) => {
      if (order.findings.length === 0) return false;
      const first = order.findings[0].evidence;
      const pack = first.type === 'custom-check' ? lintPackOf(first.check) : null;
      return (
        pack !== null &&
        getLanguage(pack as LanguageId)?.lintGate?.fixCommand !== undefined &&
        order.findings.every(
          (f) => f.evidence.type === 'custom-check' && typeof f.evidence.rule === 'string',
        )
      );
    },
    execute: executeLintAutofix,
    groupKey: lintFileOf,
  },
];

/** The first recipe of the order's class whose `matches` accepts it. */
export function matchRecipe(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.class === order.class && r.matches(order));
}
