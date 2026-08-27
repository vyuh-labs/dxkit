/**
 * Frame-owned tree invariants (4.4.6): the responsibilities the remediate
 * frame RESERVES to itself and forbids the agent from performing, declared
 * once and consumed by both the frame step that re-establishes them and the
 * prompt that tells the agent the contract (Rule 2.30: one definition).
 *
 * The class this closes. The frame owned "the dependency tree is installed
 * and the lockfile records the manifest": it denied the agent every install
 * command and told it so. Then it trusted the tree the agent left as
 * coherent. An agent with no other way to "update a version" hand-edited
 * the lockfile; the frozen install correctly refused it; and because the
 * invariant was never re-established between the agent and the
 * verification, the only remedy was to discard the run. Two halves of one
 * contract, each defined in its own place: the prohibition in the tool
 * policy, the expectation nowhere.
 *
 * The model. A `TreeInvariant` names one coherence property of the tree at
 * one root: which changed paths make it APPLY (`appliesWhen`), which paths
 * the frame OWNS (the agent must not edit them), how the frame
 * RE-ESTABLISHES it (a command ladder through the ONE install executor, or
 * null when the ecosystem gives no command), and how it VERIFIES it (the
 * same check shape the correctness floor runs, so the frame and the floor
 * cannot disagree on "consistent"). The frame runs every applicable
 * invariant after EVERY agent order and after every recipe group, BEFORE
 * verification, and discloses the outcome per order; an invariant that
 * cannot be re-established fails the order at that step, named.
 *
 * Two sources, one collector (`collectTreeInvariants` in `languages/index.ts`):
 *
 *   - the DEPENDENCY invariant is DERIVED from a pack's install strategy by
 *     `dependencyTreeInvariant` (the strategy's resync mode re-establishes,
 *     its sync check verifies, its lockfile is the owned path), so a pack
 *     that declares an install strategy gets it with no second declaration;
 *   - every pack declares `treeInvariants` (REQUIRED on `LanguageSupport`;
 *     `NO_TREE_INVARIANTS` for a pack with nothing beyond its dependency
 *     tree) for the ecosystem's other frame-owned properties: formatting,
 *     generated artifacts, a lock sync the install strategy does not model.
 *
 * Declarations are PURE and repo-intrinsic (file reads under the repo only;
 * never PATH, never the host): the Rule 19 / Rule 20 discipline, pinned per
 * pack by `test/languages-contract.test.ts`.
 */
import * as path from 'path';
import type { LockfileCheck } from './correctness';
import { lockfileCheckFromStrategy } from './correctness';
import type { InstallPlan, InstallStrategy } from './install-strategy';
import { installCommandText } from './install-strategy';
import type { ResolvedTolerances } from '../../install/tolerances';

/** How the frame checks an invariant holds: the correctness floor's own
 *  check shape (a command, a tolerated failure, or a disclosed skip), or a
 *  declared absence with the reason. Reused so "consistent" is one
 *  definition for the frame and the floor. */
export type TreeInvariantCheck = LockfileCheck | { readonly kind: 'none'; readonly reason: string };

export interface TreeInvariant {
  /** Stable id (`lockfile-sync`, `formatting`): the ledger and prompt key. */
  readonly id: string;
  /** The declaring pack. */
  readonly pack: string;
  /** Repo-relative root the invariant holds at (`''` = the repo root). */
  readonly root: string;
  /** One line: what the frame owns, in the ecosystem's words. */
  readonly summary: string;
  /** Repo-relative paths the frame owns outright: the agent must not edit
   *  them, and the frame's re-establishment may rewrite them. */
  readonly ownedPaths: readonly string[];
  /** The one path (or file kind) the agent SHOULD edit instead, for the
   *  contract line ("change package.json and stop"). */
  readonly agentEdits: string;
  /** Does a change to these repo-relative paths make the invariant apply?
   *  Pure over the path list. */
  appliesWhen(changedPaths: readonly string[]): boolean;
  /** The command ladder that re-establishes the invariant at `root`,
   *  executed through the ONE install executor; null when the ecosystem
   *  gives the frame no command (verify-only: a broken invariant then
   *  fails the order with that reason). */
  readonly reestablish: InstallPlan | null;
  readonly verify: TreeInvariantCheck;
}

export interface TreeInvariantProvider {
  /**
   * The pack's invariants beyond its dependency tree, at `cwd`. Pure and
   * repo-intrinsic. `candidatePaths` are the paths a caller expects to
   * change (an order envelope, an agent's diff): a provider that keys its
   * roots on them may narrow, but an invariant returned here still gates
   * itself through `appliesWhen`.
   */
  invariants(cwd: string, candidatePaths: readonly string[]): readonly TreeInvariant[];
}

/** The declared "nothing beyond the dependency tree" provider. */
export const NO_TREE_INVARIANTS: TreeInvariantProvider = {
  invariants: () => [],
};

/** The id of the derived dependency invariant (shared with the floor's
 *  lockfile-sync label by design: one property, one name). */
export const DEPENDENCY_INVARIANT_ID = 'lockfile-sync';

/** Is `filePath` at or below `root` (repo-relative POSIX; `''` = root)? */
export function pathUnderRoot(filePath: string, root: string): boolean {
  if (root === '') return true;
  return filePath === root || filePath.startsWith(root + '/');
}

/** The directory of a repo-relative POSIX path (an empty string for a
 *  root-level file). */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * The ONE derivation of the dependency invariant from an install strategy,
 * anchored to the OWNING dependency root (never a bare dirname): it applies
 * to the strategy's lockfile, to a manifest sitting AT the root itself, and
 * to a nested manifest under the root only when the root is
 * lockfile-anchored (a workspace member resolves to the workspace root's
 * strategy) and the path is not owned by another discovered root
 * (`otherRoots`). A manifest in a directory with neither its own lockfile
 * nor a lockfile-anchored parent maps to NO invariant (the collector
 * discloses it; the frame never guesses an install). Owned = the lockfile;
 * re-established by the strategy's RESYNC mode; verified by the strategy's
 * sync check under the repo's authorized tolerances
 * (`lockfileCheckFromStrategy`, the same derivation the floor reads).
 */
export function dependencyTreeInvariant(args: {
  readonly pack: string;
  readonly root: string;
  readonly strategy: InstallStrategy;
  readonly manifestPatterns: readonly string[];
  readonly matchesManifest: (filePath: string, pattern: string) => boolean;
  readonly tolerances: ResolvedTolerances;
  /** The pack's OTHER dependency roots: a path under one of them belongs
   *  to that root's invariant, never this one's. */
  readonly otherRoots?: readonly string[];
}): TreeInvariant {
  const { pack, root, strategy, manifestPatterns, matchesManifest, tolerances } = args;
  const otherRoots = args.otherRoots ?? [];
  const lockfilePath = strategy.lockfile === null ? null : path.posix.join(root, strategy.lockfile);
  const isManifest = (p: string) => manifestPatterns.some((m) => matchesManifest(p, m));
  const underOther = (p: string) =>
    otherRoots.some((r) => r !== root && r !== '' && pathUnderRoot(p, r));
  const check = lockfileCheckFromStrategy(strategy, tolerances);
  const manifestWord =
    manifestPatterns.length > 0 ? manifestPatterns[0] : 'the dependency manifest';
  return {
    id: DEPENDENCY_INVARIANT_ID,
    pack,
    root,
    summary:
      `the ${strategy.manager} dependency tree at ${root === '' ? 'the repo root' : root} is ` +
      'installed by the frame and its lockfile records the manifest',
    ownedPaths: lockfilePath === null ? [] : [lockfilePath],
    agentEdits: root === '' ? manifestWord : path.posix.join(root, manifestWord),
    appliesWhen: (changedPaths) =>
      changedPaths.some((p) => {
        if (lockfilePath !== null && p === lockfilePath) return true;
        if (!pathUnderRoot(p, root) || underOther(p)) return false;
        if (!isManifest(p)) return false;
        // The root's own manifest always applies; a nested manifest applies
        // only under a lockfile-anchored root (a workspace member, whose
        // resync happens at the root that owns the lockfile).
        return dirOf(p) === root || lockfilePath !== null;
      }),
    reestablish: strategy.modes.resync ?? null,
    verify:
      check === null
        ? {
            kind: 'none',
            reason: `the ${strategy.manager} strategy declares no lockfile-sync check`,
          }
        : check,
  };
}

/**
 * The contract line the agent is told, rendered from the SAME invariant the
 * frame will apply (R2: an agent is never forbidden an action without being
 * told who performs it). One definition; the prompt renderer and the ledger
 * both read it.
 */
export function renderTreeInvariantContract(inv: TreeInvariant): string {
  const owned =
    inv.ownedPaths.length > 0
      ? `do not edit ${inv.ownedPaths.join(' or ')}`
      : 'do not re-establish it yourself';
  const reestablish =
    inv.reestablish === null
      ? 'the frame verifies it after you finish'
      : `the frame runs \`${installCommandText(inv.reestablish.primary)}\` and re-checks it after you finish`;
  return (
    `${inv.id} (${inv.pack}, ${inv.root === '' ? 'repo root' : inv.root}): ${inv.summary}; ` +
    `${owned} or run installs; change ${inv.agentEdits} and stop; ${reestablish}.`
  );
}
