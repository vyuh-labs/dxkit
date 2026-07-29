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

/** Repo facts the scaffold tailors on. Plain data (no registry imports) so
 *  the metadata module stays a leaf; the caller builds it from the language
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

export const POLICY_PARAMS: readonly PolicyParamMeta[] = [
  {
    path: 'baseline.mode',
    summary: 'how the guardrail finds its "before"',
    anchor: 'baseline-mode',
    enumValues: ['committed-full', 'committed-sanitized', 'ref-based'],
  },
  {
    path: 'baseline.refreshCadence',
    summary: 'how often the refresh workflow runs',
    anchor: 'refresh-cadence',
    enumValues: ['weekly', 'daily'],
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
    path: 'reports.onMerge',
    summary: 'publish report snapshots to the dxkit-reports ref on merge',
    anchor: 'reports-on-merge',
  },
  {
    path: 'loop.preset',
    summary: 'what blocks an autonomous loop from declaring done',
    anchor: 'loop-preset',
    enumValues: ['security-only', 'full-debt'],
  },
];

const paramByPath = new Map(POLICY_PARAMS.map((p) => [p.path, p]));

/** The parameter row for a dotted path, when one exists. */
export function paramMetaFor(path: string): PolicyParamMeta | undefined {
  return paramByPath.get(path);
}

export const POLICY_STANZAS: readonly PolicyStanzaMeta[] = [
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
