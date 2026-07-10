/**
 * THE command registry data (CLAUDE.md Rule 16) — one descriptor per top-level
 * CLI command. Split out of `commands.ts` as pure data; the facade in
 * `commands.ts` re-exports `COMMANDS` + `CommandId` and adds the registry
 * helpers, so every existing importer of `./commands` is unchanged.
 */
import type { CapabilityDescriptor } from './command-types';
import {
  recommendConfigure,
  recommendBaseline,
  recommendFlow,
  recommendChecks,
  planBaselineMode,
  planFlowMode,
  planLintGate,
  planLoopPreset,
} from './advisor';

/**
 * THE registry. One entry per top-level command. Keep in rough help-index
 * order within each group; `renderCommandIndex` regroups by `group`.
 */
export const COMMANDS = [
  // ── Setup ──────────────────────────────────────────────────────────────
  {
    id: 'init',
    audience: 'user',
    group: 'setup',
    summary: 'Install dxkit agent DX in this repo',
    docsBlurb:
      'Scaffold dxkit into a repo: agent skills, CLAUDE.md, and any opted-in hooks/CI/devcontainer.',
    skill: 'dxkit-init',
  },
  {
    id: 'update',
    audience: 'user',
    group: 'setup',
    summary: 'Re-generate managed files (preserves your edits)',
    docsBlurb:
      'Refresh dxkit-owned files to the current version, provenance-aware — never clobbers files you evolved.',
    skill: 'dxkit-update',
  },
  {
    id: 'uninstall',
    audience: 'user',
    group: 'setup',
    summary: 'Remove dxkit, restoring the exact pre-dxkit state',
    docsBlurb:
      'Delete files dxkit created and surgically revert its additive merges. Dry-run by default; --yes applies.',
    skill: 'dxkit-uninstall',
  },
  {
    id: 'doctor',
    audience: 'user',
    group: 'setup',
    summary: 'Verify setup — and recommend capabilities you are not using',
    docsBlurb:
      'Check that dxkit is wired correctly, and advise on unused capabilities that fit this repo.',
  },
  {
    id: 'configure',
    audience: 'user',
    group: 'setup',
    summary: 'Compute + apply a deterministic config plan for this repo',
    docsBlurb:
      'Walk every capability the registry exposes and compute the config each should take from observable repo facts — a pure, reproducible plan (same repo → same plan). `--plan` shows it, `--apply` merge-writes it into .dxkit/policy.json without clobbering your edits. New capabilities join the plan automatically.',
    skill: 'dxkit-onboard',
    whenToRecommend: recommendConfigure,
  },
  {
    id: 'capabilities',
    audience: 'user',
    group: 'setup',
    summary: 'List every dxkit capability + what this repo should adopt',
    docsBlurb:
      'The capability catalog — every command with its group, summary, and driving skill, plus repo-grounded recommendations. `--json` is the agent-queryable menu for configuring dxkit conversationally.',
    skill: 'dxkit-learn',
  },
  {
    id: 'tools',
    audience: 'user',
    group: 'setup',
    summary: 'Show / install required analysis tools',
    docsBlurb:
      'Report the status of external analysis tools (semgrep, gitleaks, …) and install missing ones.',
  },
  {
    id: 'hooks',
    audience: 'user',
    group: 'setup',
    summary: 'Activate the dxkit git hooks (core.hooksPath)',
    docsBlurb: 'Idempotently point git at .githooks so the pre-push guardrail runs on every push.',
    skill: 'dxkit-hooks',
  },
  {
    id: 'setup-branch-protection',
    audience: 'user',
    group: 'setup',
    aliases: ['protect'],
    summary: 'Set up branch protection / required checks (dry-run by default)',
    docsBlurb:
      'Configure branch protection so the guardrail check is a required status, and add a ' +
      'deletion-protection ruleset for the dxkit anchor side branches. `protect` is the ' +
      'dry-run-first alias.',
  },
  {
    id: 'setup-prebuild',
    audience: 'user',
    group: 'setup',
    summary: 'Set up the devcontainer prebuild workflow',
    docsBlurb: 'Install a GitHub Actions workflow that prebuilds the dxkit devcontainer image.',
  },
  {
    id: 'upgrade',
    audience: 'user',
    group: 'setup',
    summary: 'Plan / apply a dxkit version upgrade',
    docsBlurb:
      'Show a package-manager-aware upgrade plan for the dxkit devDependency and its transition steps.',
  },
  {
    id: 'issue',
    audience: 'user',
    group: 'setup',
    summary: 'Open a pre-filled GitHub issue against dxkit',
    docsBlurb:
      'Compose a typed feedback issue (false-positive / bug / feature-request / …); nothing submits until you confirm in the browser.',
  },

  // ── Assess ─────────────────────────────────────────────────────────────
  {
    id: 'health',
    audience: 'user',
    group: 'assess',
    summary: 'Run the deterministic 6-dimension health analysis',
    docsBlurb:
      'Score Security, Code Quality, Tests, Docs, Maintainability, and Developer Experience with structured deductions.',
    skill: 'dxkit-reports',
  },
  {
    id: 'vulnerabilities',
    audience: 'user',
    group: 'assess',
    aliases: ['vuln'],
    summary: 'Run the deep security scan',
    docsBlurb:
      'Secrets, SAST, and dependency-vulnerability findings with CVSS scoring and remediation proposals.',
    skill: 'dxkit-reports',
  },
  {
    id: 'test-gaps',
    audience: 'user',
    group: 'assess',
    summary: 'Analyze test coverage gaps',
    docsBlurb:
      'Surface untested source files by risk tier, crediting coverage artifacts and import-graph reachability.',
    skill: 'dxkit-test',
  },
  {
    id: 'tests',
    audience: 'user',
    group: 'assess',
    summary: 'Select tests affected by a diff via the code graph',
    docsBlurb:
      '`tests affected --diff <ref>` lists the test files a change reaches, computed from the call graph (beats module-graph selection in composition-root repos). Fails safe to the full suite when the graph is missing, stale, or unreliable for a changed language.',
    skill: 'dxkit-test',
  },
  {
    id: 'quality',
    audience: 'user',
    group: 'assess',
    summary: 'Code quality + slop detection',
    docsBlurb:
      'Duplication, complexity, and AI-slop signals rolled into the Code Quality dimension.',
  },
  {
    id: 'dev-report',
    audience: 'user',
    group: 'assess',
    summary: 'Developer activity analysis',
    docsBlurb: 'Recency-weighted git activity: active owners, bus-factor, and contribution shape.',
  },
  {
    id: 'licenses',
    audience: 'user',
    group: 'assess',
    summary: 'Dependency license inventory',
    docsBlurb: 'Enumerate dependency licenses and attribution for the dependency tree.',
  },
  {
    id: 'bom',
    audience: 'user',
    group: 'assess',
    summary: 'Bill of Materials (licenses + vulnerabilities joined)',
    docsBlurb: 'Join the license inventory with the vulnerability scan into one dependency BOM.',
  },
  {
    id: 'coverage',
    audience: 'user',
    group: 'assess',
    summary: 'Run per-pack test-with-coverage (materializes the artifact)',
    docsBlurb:
      'Side-effecting: run each active pack’s coverage command so health/test-gaps read line-level truth.',
  },
  {
    id: 'dashboard',
    audience: 'user',
    group: 'assess',
    summary: 'Render .dxkit/reports/ into one HTML dashboard',
    docsBlurb: 'Combine the generated reports into a single browsable HTML dashboard.',
    skill: 'dxkit-reports',
  },
  {
    id: 'report',
    audience: 'user',
    group: 'assess',
    summary: 'Full audit (report), or publish/read a score snapshot (report snapshot|history)',
    docsBlurb:
      'One command to run all analyzers and render the dashboard — the full-audit entry point. ' +
      '`report snapshot` publishes a per-merge score snapshot to the dxkit-reports ref; ' +
      '`report history` renders the score-over-time trend (`--markdown` emits a "score moved X→Y" ' +
      'block for a CI job summary or PR comment). Automate snapshots on merge with ' +
      '`policy.json:reports.onMerge` (the dxkit-reports-refresh workflow).',
    skill: 'dxkit-reports',
  },
  {
    id: 'metrics',
    audience: 'user',
    group: 'assess',
    summary: 'Findings the gate stopped before merge + the score-over-time trend',
    docsBlurb:
      'The champion ROI report, computed not narrated: net-new findings the guardrail intercepted before they reached the base branch, per week and by category, from the append-only loop ledger. Interceptions are the ungameable number; --since <ref|date> scopes the window. Also surfaces the score-over-time trend (how each dimension moved) from the dxkit-reports snapshots when on-merge reports are enabled.',
    skill: 'dxkit-reports',
  },

  // ── Gate ───────────────────────────────────────────────────────────────
  {
    id: 'baseline',
    audience: 'user',
    group: 'gate',
    summary: 'Capture / publish / show per-finding baselines for the guardrail',
    docsBlurb:
      'Record per-finding identities the guardrail check diffs against to gate net-new ' +
      'regressions. `baseline publish` pushes the captured anchor to the side branch on the ' +
      '`branch` anchor transport — the one side-ref write path the refresh workflow runs.',
    whenToRecommend: recommendBaseline,
    planConfig: planBaselineMode,
  },
  {
    id: 'guardrail',
    audience: 'user',
    group: 'gate',
    summary: 'Diff current scan vs baseline; block on net-new regressions',
    docsBlurb:
      'The brownfield gate: fail on findings introduced by a change, grandfathering pre-existing debt.',
    skill: 'dxkit-action',
  },
  {
    id: 'receipt',
    audience: 'user',
    group: 'gate',
    summary: 'Emit the PR "dxkit signals" block (verdict + allowlist + score delta)',
    docsBlurb:
      'The ready-to-paste PR signals block, computed not narrated: the guardrail verdict, the allowlist delta, and (with --since) health-score movement vs the base ref. Reuses the session verdict cache so it never re-runs an unchanged scan.',
    skill: 'dxkit-pr',
  },
  {
    id: 'allowlist',
    audience: 'user',
    group: 'gate',
    summary: 'Suppress / audit individual findings with typed reasons',
    docsBlurb:
      'Accept a finding with a typed category + required reason + optional expiry; audit and prune entries.',
    skill: 'dxkit-allowlist',
  },
  {
    id: 'ingest',
    audience: 'user',
    group: 'gate',
    summary: 'Ingest external SAST (SARIF) findings as first-class',
    docsBlurb:
      'Pull CodeQL / Snyk / Semgrep-Pro SARIF into dxkit so external findings share one fingerprint + gate.',
    skill: 'dxkit-ingest',
  },
  {
    id: 'loop',
    audience: 'user',
    group: 'gate',
    summary: 'Autonomous-loop utilities (doctor / ledger / snapshot)',
    docsBlurb:
      'Inspect and verify the autonomous-loop Stop-gate wiring, its ledger, and the correctness-floor snapshot.',
    skill: 'dxkit-loop',
    planConfig: planLoopPreset,
  },
  {
    id: 'checks',
    audience: 'user',
    group: 'gate',
    summary: 'List / dry-run your custom repo-invariant + lint gates',
    docsBlurb:
      'Declare repo invariants (a project rule, a lint gate) as first-class gate citizens: the guardrail fingerprints their failures and blocks only net-new ones, grandfathering pre-existing debt. `checks list` shows what is configured; `checks run` dry-runs them.',
    skill: 'dxkit-checks',
    whenToRecommend: recommendChecks,
    planConfig: planLintGate,
  },

  // ── Integrate ──────────────────────────────────────────────────────────
  {
    id: 'flow',
    audience: 'user',
    group: 'integrate',
    summary: 'UI→API integration mapping + the broken-integration gate',
    docsBlurb:
      'Map client calls to served endpoints and gate changes that break a UI→API contract across repos.',
    skill: 'dxkit-flow',
    whenToRecommend: recommendFlow,
    planConfig: planFlowMode,
  },

  // ── Explore ────────────────────────────────────────────────────────────
  {
    id: 'explore',
    audience: 'user',
    group: 'explore',
    summary: 'Repo exploration via the code graph',
    docsBlurb:
      'Query the graphify artifact: hot-files, entry-points, communities, api-surface, per-file/feature context.',
  },
  {
    id: 'context',
    audience: 'user',
    group: 'explore',
    summary: 'Slim structural code slice for a query (token-efficient)',
    docsBlurb:
      'Budget-bounded structural context for a query — a compact codebase slice for an LLM.',
  },
  {
    id: 'reviewers',
    audience: 'user',
    group: 'explore',
    summary: 'Suggest reviewers via the active-owner model',
    docsBlurb:
      'Rank reviewers by recency-weighted ownership of the touched files, blended with CODEOWNERS, with a bus-factor signal.',
  },

  // ── Export ─────────────────────────────────────────────────────────────
  {
    id: 'to-xlsx',
    audience: 'user',
    group: 'export',
    summary: 'Convert a dxkit JSON report to XLSX',
    docsBlurb: 'Render a dxkit JSON report into a 15-column spreadsheet for sharing.',
  },

  // ── Internal (machine-invoked; registered, not user-facing) ────────────
  {
    id: 'context-hook',
    audience: 'internal',
    group: 'internal',
    summary: 'Claude Code PreToolUse hook body (graph context injection)',
  },
  {
    id: 'hook',
    audience: 'internal',
    group: 'internal',
    summary: 'Claude Code lifecycle-hook bodies for the loop pack (stop-gate)',
  },
  {
    id: 'floor',
    audience: 'internal',
    group: 'internal',
    summary: 'Correctness-floor plumbing (snapshot / check) for the loop + hooks',
  },
  {
    id: 'demo',
    audience: 'user',
    group: 'explore',
    summary: 'Offline, no-API demonstration walkthroughs',
    docsBlurb:
      'Run a self-contained walkthrough (default: the loop-guardrail demo) with no network or API key.',
  },
] as const satisfies readonly CapabilityDescriptor[];

/** The literal union of every registered command id. */
export type CommandId = (typeof COMMANDS)[number]['id'];
