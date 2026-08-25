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
import { executeDeclareDependency } from '../recipes/declare-dependency';
import { executeLintAutofix } from '../recipes/lint-autofix';
import { executeLockfileSync } from '../recipes/lockfile-sync';
import { executeOverridePin } from '../recipes/override-pin';
import type { RecipeExecuteContext, RecipeOutcome } from '../recipes/types';
import { WORK_ORDER_CLASSES, type WorkOrder, type WorkOrderClass } from './types';

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
    matches: (order) => order.constraints.install !== undefined,
    execute: executeLockfileSync,
  },
  {
    id: 'override-pin',
    class: classServedBy('override-pin'),
    summary: 'pin a fixed version through a pm-aware override when no direct upgrade path exists',
    implemented: true,
    // Needs a known fixed version for EVERY advisory in the order, and an
    // install command the frame can run; an advisory with no fix is agent
    // (or human) territory.
    matches: (order) =>
      order.constraints.install !== undefined &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'dep-vuln' && typeof f.evidence.fixedVersion === 'string',
      ),
    execute: executeOverridePin,
  },
  {
    id: 'declare-dependency',
    class: classServedBy('declare-dependency'),
    summary:
      'declare and install a bare import, refusing with the reason when the candidate carries a block-tier advisory',
    implemented: true,
    // Every finding must carry the unresolved specifier, and that specifier
    // must name a PACKAGE. Bareness is a producer fact (the resolutionCheck
    // contract): a project-path identity (leading `./`, the ONE canonical
    // discriminator `isProjectPathIdentity`) names a missing FILE, which no
    // install can declare, so those orders tier to the agent. The frame must
    // also hold the producing pack's install command.
    matches: (order) =>
      order.constraints.install !== undefined &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) =>
          f.evidence.type === 'floor' &&
          typeof f.evidence.specifier === 'string' &&
          !isProjectPathIdentity(f.evidence.specifier),
      ),
    execute: executeDeclareDependency,
  },
  {
    id: 'lint-autofix',
    class: classServedBy('lint-autofix'),
    summary: "the pack linter's own autofix, restricted to the order's file and rules",
    implemented: true,
    // Every finding must carry a rule: an unparsed diagnostic cannot be
    // scoped to a fixer. Which rules a pack's fixer covers is the executor's
    // (pack-declared) knowledge, not the registry's.
    matches: (order) =>
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'custom-check' && typeof f.evidence.rule === 'string',
      ),
    execute: executeLintAutofix,
  },
];

/** The first recipe of the order's class whose `matches` accepts it. */
export function matchRecipe(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.class === order.class && r.matches(order));
}
