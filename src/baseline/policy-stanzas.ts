/**
 * The scaffold's commented opt-in STANZAS and the declared scaffold
 * exemptions: the second half of the one policy metadata table
 * (`policy-metadata.ts`), split at the large-file bar and re-exported
 * there so `from './policy-metadata'` stays the one import path. The
 * per-parameter rows (`POLICY_PARAMS`) live in the sibling; the stanza
 * types are declared HERE, in the leaf, so the import edge runs one way
 * (metadata re-exports from this module, this module imports nothing).
 */

/** Repo facts the scaffold tailors on. Plain data (no registry imports) so
 *  the metadata modules stay leaves; the caller builds it from the language
 *  registry. */
export interface ScaffoldCtx {
  readonly packIds: readonly string[];
  /** Does any active pack declare a `lintGate`? */
  readonly lintCapable: boolean;
}

/** One commented-out opt-in stanza in the generated scaffold. */
export interface PolicyStanzaMeta {
  /** Top-level policy key the stanza teaches (`pairedChecks`, `depBump`, …).
   *  A key already active in the rendered policy suppresses its stanza. */
  readonly key: string;
  /** `POSTURE_KNOBS` paths this stanza covers; the scaffold-coverage test
   *  resolves every knob through these. */
  readonly coversKnobs: readonly string[];
  /** Section title rendered in the stanza's header comment. */
  readonly title: string;
  /** Teaching lines rendered as comments above the stanza. */
  readonly blurb: readonly string[];
  /** Guide anchor for the whole stanza. */
  readonly anchor: string;
  /** The syntactically-complete example value; uncommenting it IS activation
   *  (E3). A function of ctx so examples can tailor per stack. */
  readonly example: (ctx: ScaffoldCtx) => unknown;
  /** Extra comment lines after the stanza (e.g. "then run: vyuh-dxkit update"). */
  readonly followUp?: readonly string[];
  /** Omit the stanza entirely when false (per-stack tailoring). */
  readonly appliesWhen?: (ctx: ScaffoldCtx) => boolean;
}

/** A `POSTURE_KNOBS` path deliberately absent from the scaffold; a declared
 *  exemption with a reason, never a silent omission. */
export interface ScaffoldExemptKnob {
  readonly path: string;
  readonly reason: string;
}

export const POLICY_STANZAS: readonly PolicyStanzaMeta[] = [
  {
    key: 'extends',
    coversKnobs: ['extends'],
    title: 'Policy base',
    blurb: [
      'The posture this file REFINES. Without it, a minimal file silently',
      'inherits every armed rule of the fully armed compiled default.',
    ],
    anchor: 'policy-base',
    example: () => 'security-only',
  },
  {
    key: 'baseline',
    coversKnobs: ['baseline.mode', 'baseline.refreshCadence'],
    title: 'Baseline mode',
    blurb: [
      'Pin how the guardrail finds its "before" side. Usually set by init/',
      'configure from repo visibility; tune refreshCadence via policy-guide#refresh-cadence.',
    ],
    anchor: 'baseline-mode',
    example: () => ({ mode: 'committed-full' }),
  },
  {
    key: 'flow',
    coversKnobs: ['flow.mode', 'flow.sources'],
    title: 'UI-to-API integration gate',
    blurb: [
      'Blocks a change that breaks a consumed route (catch-all-aware).',
      'Extension call sources join via flow.sources → policy-guide#flow-sources.',
    ],
    anchor: 'flow-mode',
    example: () => ({ mode: 'warn' }),
  },
  {
    key: 'schema',
    coversKnobs: ['schema.mode'],
    title: 'Data-model drift gate',
    blurb: ['Blocks a model change that breaks the declared wire contract.'],
    anchor: 'schema-mode',
    example: () => ({ mode: 'warn' }),
  },
  {
    key: 'duplication',
    coversKnobs: ['duplication.mode'],
    title: 'Copy-paste seam gate',
    blurb: ['Flags net-new duplicated blocks across the change.'],
    anchor: 'duplication-mode',
    example: () => ({ mode: 'warn' }),
  },
  {
    key: 'lint',
    coversKnobs: ['lint'],
    title: 'Lint gate',
    blurb: [
      "Runs the pack's own linter as a gate: net-new errors surface, the",
      'pre-existing backlog stays grandfathered.',
    ],
    anchor: 'lint-gate',
    example: () => ({ enabled: true, blocking: false }),
    appliesWhen: (ctx) => ctx.lintCapable,
  },
  {
    key: 'checks',
    coversKnobs: ['checks'],
    title: 'Custom checks',
    blurb: [
      'Your own invariants as gate citizens. Commands run from THIS committed',
      'file only; review edits here like CI config.',
    ],
    anchor: 'custom-checks',
    example: () => [
      {
        name: 'architecture',
        command: 'bash scripts/check-architecture.sh',
        parse: 'exit',
      },
    ],
  },
  {
    key: 'pairedChecks',
    coversKnobs: ['pairedChecks'],
    title: 'Paired-change rules',
    blurb: [
      'Blocks a change to X that ships without its Y (deletions count).',
      'Declarative; nothing is spawned, so it gates on every surface.',
    ],
    anchor: 'paired-change-rules',
    example: () => [
      {
        name: 'model-needs-migration',
        if: ['src/models/**'],
        then: ['migrations/**'],
        message: 'a data-model change ships with its migration',
      },
    ],
  },
  {
    key: 'licenses',
    coversKnobs: ['licenses.prohibited'],
    title: 'Prohibited licenses',
    blurb: [
      'Blocks a net-new dependency whose license matches a prefix here.',
      'Which licenses your business prohibits is a legal posture; yours.',
    ],
    anchor: 'prohibited-licenses',
    example: () => ({ prohibited: ['GPL-', 'AGPL-'] }),
  },
  {
    key: 'newAdvisories',
    coversKnobs: ['newAdvisories.blockSeverities', 'newAdvisories.commentCommands'],
    title: 'Newly published advisories',
    blurb: ['Posture for advisories published AFTER your baseline was captured.'],
    anchor: 'new-advisories',
    example: () => ({ blockSeverities: ['critical', 'high'], commentCommands: true }),
    followUp: ['commentCommands installs a managed workflow: run `vyuh-dxkit update` after.'],
  },
  {
    key: 'depBump',
    coversKnobs: ['depBump.enabled'],
    title: 'Scheduled dependency bumps',
    blurb: [
      'Deterministic, floor-verified bump PRs for version-solvable advisories.',
      'No LLM, no key; the agentic remediate lane handles what bumps cannot.',
    ],
    anchor: 'dep-bump',
    example: () => ({ enabled: true }),
    followUp: ['Installs a managed workflow: run `vyuh-dxkit update` after enabling.'],
  },
  {
    key: 'expiryNotice',
    coversKnobs: ['expiryNotice.enabled'],
    title: 'Expiring-suppression notice',
    blurb: [
      'A deferral is a promise with a date on it. The guardrail check already',
      'warns every PR while the window is open — this covers the quiet week:',
      'the scheduled refresh maintains ONE issue naming what lapses, who',
      'accepted it, and when, and closes it once nothing is lapsing.',
      'Never blocks; the expiry itself stays the forcing function.',
    ],
    anchor: 'expiry-notice',
    example: () => ({ enabled: true }),
    followUp: [
      'Grants the refresh workflow `issues: write`: run `vyuh-dxkit update` after enabling.',
    ],
  },
  {
    key: 'reports',
    coversKnobs: ['reports.onMerge'],
    title: 'Report snapshots on merge',
    blurb: ['Publishes score history to the dxkit-reports ref; feeds `vyuh-dxkit metrics`.'],
    anchor: 'reports-on-merge',
    example: () => ({ onMerge: true }),
    followUp: ['Installs a managed workflow: run `vyuh-dxkit update` after enabling.'],
  },
  {
    key: 'loop',
    coversKnobs: ['loop.preset'],
    title: 'Autonomous-loop Stop-gate posture',
    blurb: ['What blocks an unattended coding loop from declaring done.'],
    anchor: 'loop-preset',
    example: () => ({ preset: 'security-only' }),
  },
  {
    key: 'remediate',
    coversKnobs: ['remediate.enabled'],
    title: 'Work-order remediation (recipes first, then a scoped agent, in the verified frame)',
    blurb: [
      'The lane plans debt as finite work orders: deterministic recipes fix what',
      'they can at $0 (recipes.enabled), only the rest goes to an agent (one order',
      'per run, up to maxOrdersPerRun), and a class that keeps failing is paused',
      'by the circuit breaker (pauseAfterFailures). Every run is floor-attributed',
      "+ guardrail-verified before a PR opens (the agent's word is never trusted).",
      'Credentials come from repo secrets, never here.',
    ],
    anchor: 'remediate',
    example: () => ({
      enabled: true,
      tasks: ['fix-vulns'],
      schedule: 'weekly',
      recipes: { enabled: true },
      maxOrdersPerRun: 3,
      pauseAfterFailures: 2,
      agent: {
        driver: 'claude-code',
        model: 'auto',
        budget: { maxTurns: 80, maxMinutes: 30, maxUsd: 5 },
      },
    }),
    followUp: [
      'Installs a managed workflow: run `vyuh-dxkit update` after enabling, and set',
      'the ANTHROPIC_API_KEY repo secret (a scoped key with a spend limit).',
    ],
  },
];

export const SCAFFOLD_EXEMPT_KNOBS: readonly ScaffoldExemptKnob[] = [
  {
    path: 'baseline.anchor',
    reason:
      'auto-derived from effective branch protection at publish time; a hand-set value is ' +
      'the exception; documented in the guide (baseline-anchor), not taught by the scaffold.',
  },
  {
    path: 'graph.refresh',
    reason:
      'a CI-performance transport set by init/update when applicable, not a posture a human ' +
      'tunes; a commented stanza would invite cargo-cult enabling.',
  },
  {
    path: 'deepSast',
    reason:
      'requires an external engine + token that dxkit never selects for the user; the ingest ' +
      'command + dxkit-ingest skill own setup; a bare stanza without a token would not work.',
  },
];
