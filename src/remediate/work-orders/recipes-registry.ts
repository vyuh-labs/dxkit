/**
 * The recipe registry (remediate rethink, section 3B): the deterministic tier.
 *
 * This module holds ONLY the declarative contract, `{ id, class, matches }`,
 * and the four planned recipes as DECLARED entries. None of them is
 * executable here: `implemented: false` says so, and the planner tiers an
 * order `recipe` on a match so the plan surface shows where determinism WILL
 * apply. The executors (`apply(order) -> diff`, `verify`) land in the next
 * unit and attach to these same ids; nothing is stubbed in their place.
 *
 * The class each recipe serves is a READ of the class table (`recipe` on
 * `WORK_ORDER_CLASSES`); the contract test pins that every declared recipe
 * id is named there and vice versa. `matches` is consulted only for orders
 * of the recipe's own class.
 */
import { WORK_ORDER_CLASSES, type WorkOrder, type WorkOrderClass } from './types';

export interface RecipeDeclaration {
  readonly id: string;
  /** The work-order class this recipe serves. */
  readonly class: WorkOrderClass;
  /** One-line intent, rendered in the plan surface. */
  readonly summary: string;
  /** Whether an executor exists for this id. `false` = declared for tiering
   *  and planning only; the plan says "recipe (not yet executable)". */
  readonly implemented: boolean;
  /** Does this recipe apply to THIS order? Pure over the order's findings and
   *  evidence (a recipe never inspects the repo at planning time). */
  readonly matches: (order: WorkOrder) => boolean;
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
    implemented: false,
    matches: (order) => order.constraints.install !== undefined,
  },
  {
    id: 'override-pin',
    class: classServedBy('override-pin'),
    summary: 'pin a fixed version through a pm-aware override when no direct upgrade path exists',
    implemented: false,
    // Needs a known fixed version for EVERY advisory in the order, and an
    // install command the frame can run; an advisory with no fix is agent
    // (or human) territory.
    matches: (order) =>
      order.constraints.install !== undefined &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'dep-vuln' && typeof f.evidence.fixedVersion === 'string',
      ),
  },
  {
    id: 'declare-dependency',
    class: classServedBy('declare-dependency'),
    summary:
      'declare and install a bare import, refusing with the reason when the candidate carries a block-tier advisory',
    implemented: false,
    // Every finding must carry the unresolved specifier (bare BY THE
    // resolutionCheck CONTRACT — packs only report bare specifiers, so
    // bareness is a producer fact, never re-derived here with an
    // ecosystem-flavored regex), and the frame must have the producing
    // pack's install command to run the declare + install step.
    matches: (order) =>
      order.constraints.install !== undefined &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'floor' && typeof f.evidence.specifier === 'string',
      ),
  },
  {
    id: 'lint-autofix',
    class: classServedBy('lint-autofix'),
    summary: "the pack linter's own autofix, restricted to the order's file and rules",
    implemented: false,
    // Every finding must carry a rule: an unparsed diagnostic cannot be
    // scoped to a fixer. Which rules a pack's fixer covers is the executor's
    // (pack-declared) knowledge, not the registry's.
    matches: (order) =>
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'custom-check' && typeof f.evidence.rule === 'string',
      ),
  },
];

/** The first recipe of the order's class whose `matches` accepts it. */
export function matchRecipe(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.class === order.class && r.matches(order));
}
