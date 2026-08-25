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
 * Mirrors the pack/capability architecture: the registry is the one place a
 * class is mapped to a recipe, and the planner reads it (a synthetic entry
 * injected in tests must flip the tier, or the planner has stopped reading
 * the registry).
 */
import type { WorkOrder, WorkOrderClass } from './types';

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

/** A bare specifier: not relative, not absolute, not a URL scheme. */
function isBareSpecifier(specifier: string): boolean {
  return !/^(\.{1,2}\/|\/|[a-z]+:)/i.test(specifier);
}

export const RECIPE_REGISTRY: readonly RecipeDeclaration[] = [
  {
    id: 'lockfile-sync',
    class: 'stale-lockfile',
    summary: "reinstall with the repo's package manager so the lockfile follows the manifest",
    implemented: false,
    matches: (order) => order.class === 'stale-lockfile',
  },
  {
    id: 'override-pin',
    class: 'dep-advisory',
    summary: 'pin a fixed version through a pm-aware override when no direct upgrade path exists',
    implemented: false,
    // Needs a known fixed version for EVERY advisory in the order; an
    // advisory with no fix is agent (or human) territory.
    matches: (order) =>
      order.class === 'dep-advisory' &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'dep-vuln' && typeof f.evidence.fixedVersion === 'string',
      ),
  },
  {
    id: 'declare-dependency',
    class: 'unresolved-import',
    summary:
      'declare and install a bare import, refusing with the reason when the candidate carries a block-tier advisory',
    implemented: false,
    matches: (order) =>
      order.class === 'unresolved-import' &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) =>
          f.evidence.type === 'floor' &&
          typeof f.evidence.specifier === 'string' &&
          isBareSpecifier(f.evidence.specifier),
      ),
  },
  {
    id: 'lint-autofix',
    class: 'lint-located',
    summary: "the pack linter's own autofix, restricted to the order's file and rules",
    implemented: false,
    // Every finding must carry a rule: an unparsed diagnostic cannot be
    // scoped to a fixer. Which rules a pack's fixer covers is the executor's
    // (pack-declared) knowledge, not the registry's.
    matches: (order) =>
      order.class === 'lint-located' &&
      order.findings.length > 0 &&
      order.findings.every(
        (f) => f.evidence.type === 'custom-check' && typeof f.evidence.rule === 'string',
      ),
  },
];

/** The first registry entry that matches the order, or undefined. */
export function matchRecipe(
  order: WorkOrder,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.matches(order));
}

export function recipeById(
  id: string,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): RecipeDeclaration | undefined {
  return registry.find((r) => r.id === id);
}
