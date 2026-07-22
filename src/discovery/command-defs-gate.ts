/** The GATE-group partition of the command registry (Rule 16): baseline /
 *  guardrail / allowlist / checks / loop and their probes. Split from
 *  `command-defs.ts` purely for file size (the registry grew past the
 *  large-file floor); spread into `COMMANDS` there — same pattern as
 *  `command-defs-internal.ts` — so the one registry and the literal
 *  `CommandId` union are unchanged. */
import type { CapabilityDescriptor } from './command-types';
import {
  recommendBaseline,
  recommendChecks,
  recommendDebt,
  recommendExtensions,
  recommendLoopPreset,
  recommendNewAdvisoryTier,
  planBaselineMode,
  planFlowSources,
  planLintGate,
  planLoopPreset,
} from './advisor';

export const GATE_COMMANDS = [
  {
    id: 'baseline',
    audience: 'user',
    group: 'gate',
    summary: 'Capture / publish / show per-finding baselines for the guardrail',
    typicalRuntime: '30 sec - 2 min',
    docsBlurb:
      'Record per-finding identities the guardrail check diffs against to gate net-new ' +
      'regressions. `baseline refresh` is the scheduled-refresh capture with the advisory ' +
      'decision lane (new advisories held out + raised as a base-branch decision PR, never ' +
      'silently absorbed); `baseline publish` pushes the captured anchor to the side branch on ' +
      'the `branch` anchor transport.',
    whenToRecommend: recommendBaseline,
    planConfig: planBaselineMode,
  },
  {
    id: 'guardrail',
    audience: 'user',
    group: 'gate',
    summary: 'Diff current scan vs baseline; block on net-new regressions',
    typicalRuntime: '30 sec - 2 min',
    docsBlurb:
      'The brownfield gate: fail on findings introduced by a change, grandfathering pre-existing ' +
      'debt. Newly published advisories (dep-vulns the feed disclosed after baseline capture, on ' +
      'a diff touching no manifest) gate by the `newAdvisories.blockSeverities` tier — default ' +
      'critical/high block, medium/low warn.',
    skill: 'dxkit-action',
    whenToRecommend: recommendNewAdvisoryTier,
  },
  {
    id: 'receipt',
    audience: 'user',
    group: 'gate',
    summary: 'Emit the PR "dxkit signals" block (verdict + allowlist + score delta)',
    typicalRuntime: '< 30 sec',
    docsBlurb:
      'The ready-to-paste PR signals block, computed not narrated: the guardrail verdict, the allowlist delta, and (with --since) health-score movement vs the base ref. Reuses the session verdict cache so it never re-runs an unchanged scan.',
    skill: 'dxkit-pr',
  },
  {
    id: 'pr',
    audience: 'user',
    group: 'gate',
    summary: 'Compute a reviewable PR body from the branch (title, changes, signals, checklist)',
    typicalRuntime: '< 30 sec (longer with --since)',
    docsBlurb:
      'The deterministic core of the dxkit-pr skill: reads the branch commits + diff and computes the title, bucketed Changes, the receipt signals block, suggested reviewers, a diff-derived reviewer checklist, and the structural-duplicate seam prompts — leaving only "What & why" for the author. Prints markdown or --json; never opens the PR.',
    skill: 'dxkit-pr',
  },
  {
    id: 'allowlist',
    audience: 'user',
    group: 'gate',
    summary: 'Suppress / audit individual findings with typed reasons',
    typicalRuntime: '< 1 sec',
    docsBlurb:
      'Accept a finding with a typed category + required reason + optional expiry; audit and prune ' +
      'entries. `defer` bulk-defers newly published dep-vuln advisories time-boxed (dep-vuln-only).',
    skill: 'dxkit-allowlist',
  },
  {
    id: 'ingest',
    audience: 'user',
    group: 'gate',
    summary: 'Ingest external SAST findings (Snyk / Sonar / CodeQL / SARIF) as first-class',
    typicalRuntime: 'varies (reads engine API or SARIF)',
    docsBlurb:
      'Pull Snyk Code / SonarQube (API) or CodeQL / Semgrep-Pro (SARIF) findings into dxkit so external findings share one fingerprint + gate.',
    skill: 'dxkit-ingest',
  },
  {
    id: 'loop',
    audience: 'user',
    group: 'gate',
    summary: 'Autonomous-loop utilities (doctor / ledger / snapshot)',
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'Inspect and verify the autonomous-loop Stop-gate wiring, its ledger, and the correctness-floor snapshot.',
    skill: 'dxkit-loop',
    whenToRecommend: recommendLoopPreset,
    planConfig: planLoopPreset,
  },
  {
    id: 'debt',
    audience: 'user',
    group: 'assess',
    summary: 'The prioritized repair inventory: floor debt + finding debt',
    typicalRuntime: 'varies (runs your compile + tests)',
    docsBlurb:
      'One agent-readable inventory of everything the baseline grandfathered: the correctness-floor ' +
      'debt (broken build / failing tests, with reproduction commands and captured error output, ' +
      'live-run and diffed against the baseline envelope) plus the fingerprinted finding debt by ' +
      'severity — ordered into a repair plan (build first, then tests, then findings). ' +
      'Informational: it never gates.',
    skill: 'dxkit-action',
    whenToRecommend: recommendDebt,
  },
  {
    id: 'checks',
    audience: 'user',
    group: 'gate',
    summary: 'List / dry-run your custom repo-invariant + lint gates',
    typicalRuntime: 'varies (runs your checks)',
    docsBlurb:
      'Declare repo invariants (a project rule, a lint gate) as first-class gate citizens: the guardrail fingerprints their failures and blocks only net-new ones, grandfathering pre-existing debt. `checks list` shows what is configured; `checks run` dry-runs them.',
    skill: 'dxkit-checks',
    whenToRecommend: recommendChecks,
    planConfig: planLintGate,
  },
  {
    id: 'extensions',
    audience: 'user',
    group: 'gate',
    summary: 'Plug your own extractors and sinks into dxkit (any language)',
    typicalRuntime: 'seconds (the `dev` loop)',
    docsBlurb:
      'Declare an extension — a manifest pointing at your existing script — and dxkit runs it at ' +
      'refresh time, validates its emitted contract/inventory/findings/export document, and routes ' +
      'it through the same machines native output gets (the flow join, the report trend, the ' +
      'net-new finding gate). `extensions dev <name>` is the seconds-fast authoring loop; ' +
      '`extensions init` scaffolds a manifest that passes validation immediately, and ' +
      '`extensions init --plugin` scaffolds a rung-4 TypeScript plugin (flow dialects, custom ' +
      'artifact readers, URL rewrites, integration verifiers) — the dxkit-author-extension ' +
      'skill writes either rung from a prose description.',
    skill: 'dxkit-extensions',
    whenToRecommend: recommendExtensions,
    planConfig: planFlowSources,
  },
] as const satisfies readonly CapabilityDescriptor[];
