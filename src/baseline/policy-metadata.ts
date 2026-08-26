/**
 * The ONE per-parameter metadata table for the policy surface (4.3).
 *
 * Three consumers render from this table and may never diverge, because they
 * share it (the Rule 2 discipline applied to documentation):
 *
 *   - the generated policy SCAFFOLD (`policy-template.ts`); per-parameter
 *     trailing comments + the commented opt-in stanzas;
 *   - the generated JSON SCHEMA (`policy.schema.json`); editor hover text
 *     comes from the same `summary` strings;
 *   - the policy GUIDE (`docs/configuration/policy-guide.md`); every
 *     `anchor` here must resolve to a real heading there (the anchor-validity
 *     gate), so the file comment, the editor hover, and the guide teach the
 *     same thing.
 *
 * A knob that ships without a row here is caught by the scaffold-coverage
 * test (every `POSTURE_KNOBS` path is covered by a stanza or carries a
 * declared scaffold exemption; the `DEFERRED_KINDS` discipline; a silent
 * omission fails CI).
 */

/** Hosted home of the per-knob teaching guide. The scaffold's header links it
 *  once; per-parameter comments use the short `policy-guide#<anchor>` form. */
export const POLICY_GUIDE_URL =
  'https://github.com/vyuh-labs/dxkit/blob/main/docs/configuration/policy-guide.md';

/** One policy parameter: the shared source for its file comment, its schema
 *  description, and its guide anchor. */
export interface PolicyParamMeta {
  /** Dotted path from the policy root (e.g. `flow.mode`). */
  readonly path: string;
  /** One-line meaning; rendered as the trailing file comment and the schema
   *  `description`. Keep it short; tuning depth lives in the guide. */
  readonly summary: string;
  /** Heading slug in `docs/configuration/policy-guide.md`. */
  readonly anchor: string;
  /** Closed value set, when one exists; rendered into the comment and the
   *  schema `enum`. */
  readonly enumValues?: readonly string[];
}

export const POLICY_PARAMS: readonly PolicyParamMeta[] = [
  {
    path: 'baseline.mode',
    summary: 'how the guardrail finds its "before"',
    anchor: 'baseline-mode',
    enumValues: ['committed-full', 'committed-sanitized', 'ref-based'],
  },
  {
    // Deliberately NOT an enum: the knob also accepts a 5-field cron line,
    // so a closed value set would lie in the comment, the hover, and the
    // schema all at once.
    path: 'baseline.refreshCadence',
    summary: 'refresh workflow cadence: weekly, daily, or a 5-field cron line',
    anchor: 'refresh-cadence',
  },
  {
    path: 'baseline.anchor',
    summary: 'baseline transport; auto-derived at publish time, rarely set by hand',
    anchor: 'baseline-anchor',
  },
  {
    path: 'flow.mode',
    summary: 'UI-to-API integration gate posture',
    anchor: 'flow-mode',
    enumValues: ['block', 'warn', 'off'],
  },
  {
    path: 'flow.sources',
    summary: 'extension-declared call sources joined into the flow model',
    anchor: 'flow-sources',
  },
  {
    path: 'schema.mode',
    summary: 'data-model drift gate posture',
    anchor: 'schema-mode',
    enumValues: ['block', 'warn', 'off'],
  },
  {
    path: 'duplication.mode',
    summary: 'net-new copy-paste (seam) gate posture',
    anchor: 'duplication-mode',
    enumValues: ['block', 'warn', 'off'],
  },
  {
    path: 'lint.enabled',
    summary: 'run the pack-declared linter as a gate citizen',
    anchor: 'lint-gate',
  },
  {
    path: 'lint.blocking',
    summary: 'net-new lint errors block (true) or warn (false)',
    anchor: 'lint-gate',
  },
  {
    path: 'checks',
    summary: 'your own repo invariants as first-class gate citizens',
    anchor: 'custom-checks',
  },
  {
    path: 'extends',
    summary: 'the base posture this file refines (absent = the fully armed compiled default)',
    anchor: 'policy-base',
    enumValues: ['security-only', 'full-debt', 'default'],
  },
  {
    path: 'floor.required',
    summary: 'a gate verdict requires the correctness floor to have run (default true)',
    anchor: 'floor-required',
  },
  {
    path: 'pairedChecks',
    summary: 'changing X requires also changing Y; declarative, nothing spawned',
    anchor: 'paired-change-rules',
  },
  {
    path: 'licenses.prohibited',
    summary: 'license prefixes a dependency may not carry',
    anchor: 'prohibited-licenses',
  },
  {
    path: 'newAdvisories.blockSeverities',
    summary: 'which newly published advisory severities block',
    anchor: 'new-advisories',
  },
  {
    path: 'newAdvisories.commentCommands',
    summary: 'reviewer defer commands in the PR conversation',
    anchor: 'new-advisories',
  },
  {
    path: 'depBump.enabled',
    summary: 'scheduled deterministic dependency-bump PRs',
    anchor: 'dep-bump',
  },
  {
    path: 'depBump.allowMajor',
    summary: 'let the bump lane cross major versions',
    anchor: 'dep-bump',
  },
  {
    // Same open shape as baseline.refreshCadence / remediate.schedule: named
    // cadences OR a cron. Absent = the lane's own Monday 07:00 UTC default.
    path: 'depBump.schedule',
    summary: 'cadence: weekly, daily, or a 5-field cron line',
    anchor: 'dep-bump',
  },
  {
    path: 'expiryNotice.enabled',
    summary: 'maintain one issue naming allowlist suppressions about to lapse',
    anchor: 'expiry-notice',
  },
  {
    path: 'reports.onMerge',
    summary: 'publish report snapshots to the dxkit-reports ref on merge',
    anchor: 'reports-on-merge',
  },
  {
    // Settable because dxkit's own guidance (docs + the learn assistant)
    // points users at exactly this field — a knob the product recommends
    // must be reachable through `policy set`, not a hand edit (the
    // guidance/settability drift class). Still scaffold-exempt: it is a CI
    // transport, not a posture.
    path: 'graph.refresh',
    summary: 'code-graph CI transport: "cache" installs the graph-refresh workflow on update',
    anchor: 'graph-refresh',
    enumValues: ['cache', 'off'],
  },
  {
    path: 'loop.preset',
    summary: 'what blocks an autonomous loop from declaring done',
    anchor: 'loop-preset',
    enumValues: ['security-only', 'full-debt'],
  },
  {
    path: 'remediate.enabled',
    summary: 'scheduled agent runs inside the verified frame',
    anchor: 'remediate',
  },
  {
    path: 'remediate.tasks',
    summary: 'which registry tasks the agent works',
    anchor: 'remediate-tasks',
  },
  {
    // Same open shape as baseline.refreshCadence: named cadences OR a cron.
    path: 'remediate.schedule',
    summary: 'cadence: weekly, daily, or a 5-field cron line',
    anchor: 'remediate-schedule',
  },
  {
    path: 'remediate.salvage',
    summary:
      'fate of partial/blocked work: auto (default — per task shape: open-ended tasks ' +
      'draft-pr, bounded tasks discard), or pin one value for every task',
    anchor: 'remediate-salvage',
    enumValues: ['auto', 'discard', 'draft-pr'],
  },
  {
    path: 'remediate.agent.driver',
    summary: 'which agent CLI runs the task',
    anchor: 'remediate-driver',
  },
  {
    // Deliberately NOT an enum: auto + the three tiers are documented, but a
    // driver-native id must pass through (new models outrun dxkit releases).
    path: 'remediate.agent.model',
    summary: 'auto (per-task tier), a tier (light|standard|deep), or a driver-native id',
    anchor: 'remediate-model',
  },
  {
    path: 'remediate.agent.budget.maxTurns',
    summary: 'agent iteration cap',
    anchor: 'remediate-budget',
  },
  {
    path: 'remediate.agent.budget.maxMinutes',
    summary: 'wall-clock cap; salvage policy applies on a hit',
    anchor: 'remediate-budget',
  },
  {
    // Honest about enforcement: the shipped driver REPORTS spend after the
    // run (budgetSupport.cost = 'reported'), so this cap is advisory there;
    // turns + wall clock are what bound real spend. See the guide.
    path: 'remediate.agent.budget.maxUsd',
    summary:
      'spend cap; advisory where the driver only reports spend post-run (the shipped ' +
      'driver), enforced where it can stop mid-run',
    anchor: 'remediate-budget',
  },
  {
    path: 'remediate.taskBudgets',
    summary: 'per-task {maxTurns, maxMinutes, maxUsd} overrides merged over agent.budget',
    anchor: 'remediate-task-budgets',
  },
  {
    path: 'remediate.maxSpendPerRun',
    summary: 'run-level USD ceiling over the per-task caps; tasks beyond it defer (0 = none)',
    anchor: 'remediate-spend-per-run',
  },
  {
    path: 'remediate.maxDispatchBudget',
    summary:
      'the most a workflow_dispatch override may raise maxUsd to; clamps max_turns ' +
      'proportionally (0 = dispatch can only lower)',
    anchor: 'remediate-dispatch-budget',
  },
  {
    path: 'remediate.resume',
    summary:
      'opt-in: continue a prior draft-PR salvage branch instead of starting over ' +
      '(needs an effective draft-pr salvage; capped attempts)',
    anchor: 'remediate-resume',
  },
  {
    path: 'remediate.workOrders.maxSliceSize',
    summary: 'largest number of findings one debt work order may carry (default 25)',
    anchor: 'remediate-work-orders',
  },
  {
    path: 'remediate.recipes.enabled',
    summary:
      'run deterministic recipe-tier work orders inside the frame before any agent spawns (default true)',
    anchor: 'remediate-recipes',
  },
];

const paramByPath = new Map(POLICY_PARAMS.map((p) => [p.path, p]));

/** The parameter row for a dotted path, when one exists. */
export function paramMetaFor(path: string): PolicyParamMeta | undefined {
  return paramByPath.get(path);
}

// The stanza + scaffold-exemption tables and their types live in
// policy-stanzas.ts (split at the large-file bar; the types live in the LEAF
// so no import edge points back here); re-exported so this module stays the
// ONE import path for policy metadata.
export { POLICY_STANZAS, SCAFFOLD_EXEMPT_KNOBS } from './policy-stanzas';
export type { ScaffoldCtx, PolicyStanzaMeta, ScaffoldExemptKnob } from './policy-stanzas';
