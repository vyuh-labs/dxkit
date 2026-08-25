/**
 * The recipe executor contract (remediate rethink, section 3B): the
 * deterministic tier's execution shapes. A recipe EXECUTES a work order
 * without an agent (the frame runs it inside the remediate run, before any
 * driver spawns), and its result is one of exactly three honest outcomes:
 *
 *   - `applied`: the fix is on the working tree and the recipe's own verify
 *     confirmed it (the order's ids are gone). The frame then enforces the
 *     envelope, commits, and the ONE tree verification remains the final
 *     arbiter.
 *   - `refused`: the recipe decided NOT to act, for a named reason, at $0,
 *     the design's core move (a refusal with the advisory named beats a red
 *     verification). The tree is untouched (the runner resets defensively).
 *   - `failed`: the recipe acted but a step broke or its verify did not
 *     confirm. The step is named, the evidence is the output tail, and the
 *     runner DISCARDS the partial diff: a recipe never lands unverified
 *     work.
 *
 * SECURITY (Rule 17): recipes spawn installs and linters, so execution is
 * gated on the REQUIRED typed `AnalysisTrustContext` at the phase entry
 * point (`run-recipes.ts`): an untrusted tree yields disclosed refusals
 * before anything spawns. Every spawn goes through the injected bounded
 * exec; a recipe never `execSync`s on its own.
 */
import type { AnalysisTrustContext } from '../../analysis-trust';
import type { CommandExec } from '../../analyzers/tools/bounded-exec';
import type { FindingSeverity } from '../../baseline/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { OsvPackageQuery } from '../../analyzers/tools/osv';

export type RecipeOutcome =
  | {
      readonly kind: 'applied';
      /** Repo-relative files the recipe changed (what it believes; the
       *  runner's envelope enforcement re-reads git for ground truth). */
      readonly changedFiles: readonly string[];
      /** Disclosed side notes (a tolerated fallback that ran, an OSV
       *  pre-check that could not be reached). */
      readonly notes?: readonly string[];
    }
  | {
      /** The recipe decided not to act. The reason is a full sentence a
       *  ledger reader can act on; the tree is untouched. */
      readonly kind: 'refused';
      readonly reason: string;
    }
  | {
      /** The recipe acted and a step broke (or its verify did not confirm).
       *  The runner discards the partial diff. */
      readonly kind: 'failed';
      readonly step: string;
      /** Captured output tail / verify evidence (display-sized). */
      readonly output: string;
    };

/** What a recipe executes with. Everything spawnable or network-shaped is
 *  injected so recipes unit-test against fixture repos with fake exec. */
export interface RecipeExecuteContext {
  readonly cwd: string;
  /** REQUIRED typed trust (Rule 17). The phase runner refuses before any
   *  execute when repo execution is not allowed; recipes may assume a
   *  trusted context but never re-derive one. */
  readonly trust: AnalysisTrustContext;
  /** The ONE bounded spawn primitive: every install / linter / registry
   *  probe a recipe runs goes through this. */
  readonly exec: CommandExec;
  /** OSV query-by-package (the $0 pre-check). Defaults to the real client
   *  wrapped in a per-run cache; injected in tests. `null` results are
   *  DISCLOSED, never read as clean. */
  readonly queryOsv: OsvPackageQuery;
  /** The advisory severities that REFUSE a candidate version, from the ONE
   *  policy normalizer (`newAdvisoryBlockSeverities`) so the pre-checks and
   *  the guardrail's new-advisory tier can never diverge (Rule 2.30). */
  readonly blockSeverities: ReadonlySet<FindingSeverity>;
  /** Dependency re-audit over the ONE dispatch primitive
   *  (`gatherDepVulnsWithAvailability`). `null` = the audit could not run;
   *  the recipe fails its verify rather than claim an unobserved clean. */
  readonly auditDepVulns: (cwd: string) => Promise<readonly DepVulnFinding[] | null>;
}
