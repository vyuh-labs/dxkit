/**
 * Shared types for the command capability registry (CLAUDE.md Rule 16).
 * Split out of `commands.ts` so the registry data (`command-defs.ts`), the
 * doctor/config probes (`advisor.ts`), and the facade (`commands.ts`) all
 * depend on ONE type module without a value-import cycle between them.
 */
import type { RepoVisibility } from '../baseline/visibility';

/** Job-to-be-done grouping for the help index. `internal` = machine-invoked. */
export type CommandGroup =
  | 'assess'
  | 'gate'
  | 'integrate'
  | 'explore'
  | 'setup'
  | 'export'
  | 'internal';

/**
 * `user` commands are surfaced in the help index + docs and must carry full
 * discovery metadata. `internal` commands are machine-invoked (hook bodies,
 * loop-snapshot plumbing) — still REGISTERED (nothing is invisible), but
 * exempt from the user-facing metadata requirement. `internal` is a declared
 * status, not an omission, so an accidentally-hidden user command can't slip
 * through the gate as merely "unregistered".
 */
export type Audience = 'user' | 'internal';

/**
 * Context handed to a `whenToRecommend` probe by `doctor` advisor mode.
 * Intentionally minimal today; extended as advisor probes land (progressive
 * enhancement — a new field never invalidates an existing descriptor).
 */
export interface RecommendContext {
  cwd: string;
}

/** A proactive recommendation `doctor` surfaces when a probe fires. */
export interface Recommendation {
  /** One-line reason grounded in the repo (e.g. "4 ungated repo checks found"). */
  reason: string;
  /** The concrete next command to run. */
  command: string;
}

/**
 * Context handed to a `planConfig` probe — the deterministic configuration
 * planner (`vyuh-dxkit configure`). Carries `cwd` plus the SAME injectable
 * probes the baseline-mode resolver takes, so a planner that needs repo
 * visibility (baseline) reuses the canonical `resolveBaselineMode` (Rule 11)
 * instead of re-shelling to `gh`, and tests get a deterministic result without
 * a network probe. New planners that need a new signal add a field here
 * (progressive enhancement — never invalidates an existing descriptor).
 */
export interface ConfigContext {
  cwd: string;
  /** Injectable for tests; production omits and the baseline planner lets
   *  `resolveBaselineMode` probe `gh` itself. */
  probeVisibility?: (cwd: string) => RepoVisibility;
  /** Injectable for tests; production omits and the resolver probes
   *  `origin/HEAD`. */
  probeDefaultRef?: (cwd: string) => string | undefined;
}

/**
 * One capability's DETERMINISTIC configuration recommendation — a pure
 * function of observable repo facts, never an agent's judgment. This is what
 * makes `configure` reproducible: the same repo yields the same plan on every
 * run and in every environment. `patch` is the partial `.dxkit/policy.json`
 * object the apply step deep-merges (preserving every other key, the #68
 * discipline); `reason` says why in prose and `evidence` cites the concrete
 * fact(s) that forced the value.
 */
export interface ConfigPlanItem {
  /** The capability this configures — the command id (e.g. 'baseline'). */
  capability: string;
  /** The driving skill, copied from the descriptor for the agent. */
  skill?: string;
  /** Human label of the policy section it sets (e.g. 'baseline.mode'). */
  section: string;
  /** One-line human summary of the value (e.g. 'ref-based (origin/main)'). */
  summary: string;
  /** The partial policy object to deep-merge into `.dxkit/policy.json`. */
  patch: Record<string, unknown>;
  /** Why this value — prose. */
  reason: string;
  /** The observable fact(s) that determined it (e.g. 'visibility=public'). */
  evidence: string;
}

export interface CapabilityDescriptor {
  /** Canonical command id — MUST equal the top-level switch case in `cli.ts`. */
  id: string;
  audience: Audience;
  group: CommandGroup;
  /** One-line usage summary for the help index. Required for every command. */
  summary: string;
  /** Alternate spellings dispatching to the same handler (e.g. `vuln`). */
  aliases?: readonly string[];
  /** A sentence for generated docs/README. Required for user-facing commands. */
  docsBlurb?: string;
  /**
   * What a run costs in wall-clock time (e.g. `'< 5 sec'`, `'1-4 min'`) —
   * the "Typical runtime" column of the generated docs command table.
   * Required for user-facing commands.
   */
  typicalRuntime?: string;
  /** Primary agent-facing skill basename under `.claude/skills/`, if any. */
  skill?: string;
  /**
   * Doctor-advisor probe: should `doctor` PROACTIVELY recommend this to a
   * user not already using it? Progressive enhancement — absence means
   * "listed, not proactively recommended". Presence powers advisor mode.
   */
  whenToRecommend?: (ctx: RecommendContext) => Recommendation | null;
  /**
   * Deterministic config planner (`vyuh-dxkit configure`): given observable
   * repo facts, what config value should this capability take? A PURE function
   * — same repo, same answer, every run — so `configure` is reproducible and
   * free of agent subjectivity. Returns `null` when there's nothing to
   * recommend (already configured, or no clear signal) — the planner then
   * stays silent, exactly like `whenToRecommend`. Symmetric with it, and
   * discovered the same way (`gatherConfigPlan` iterates the registry), so a
   * new capability that declares `planConfig` is covered automatically.
   */
  planConfig?: (ctx: ConfigContext) => ConfigPlanItem | null;
}

/** One command's advisor recommendation, tagged with the command id. */
export interface CommandRecommendation {
  id: string;
  recommendation: Recommendation;
}
