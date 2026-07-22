/** THE command registry data (CLAUDE.md Rule 16) — one descriptor per top-level
 *  CLI command; `commands.ts` re-exports `COMMANDS` + `CommandId` + helpers. */
import type { CapabilityDescriptor } from './command-types';
import { INTERNAL_COMMANDS } from './command-defs-internal';
import { GATE_COMMANDS } from './command-defs-gate';
import {
  recommendConfigure,
  recommendEvaluate,
  recommendFlow,
  recommendSchema,
  recommendDuplication,
  recommendReportsOnMerge,
  planFlowMode,
  planSchemaMode,
  planDuplicationMode,
} from './advisor';

/** THE registry. One entry per command, in rough help-index order within each group. */
export const COMMANDS = [
  // ── Setup ──────────────────────────────────────────────────────────────
  {
    id: 'init',
    audience: 'user',
    group: 'setup',
    summary: 'Install dxkit agent DX in this repo',
    typicalRuntime: '5-30 sec',
    docsBlurb:
      'Scaffold dxkit into a repo: agent skills, CLAUDE.md, and any opted-in hooks/CI/devcontainer.',
    skill: 'dxkit-init',
  },
  {
    id: 'update',
    audience: 'user',
    group: 'setup',
    summary: 'Re-generate managed files (preserves your edits)',
    typicalRuntime: '5-30 sec',
    docsBlurb:
      'Refresh dxkit-owned files to the current version, provenance-aware — never clobbers files you evolved.',
    skill: 'dxkit-update',
  },
  {
    id: 'uninstall',
    audience: 'user',
    group: 'setup',
    summary: 'Remove dxkit, restoring the exact pre-dxkit state',
    typicalRuntime: '< 30 sec',
    docsBlurb:
      'Delete files dxkit created and surgically revert its additive merges. Dry-run by default; --yes applies.',
    skill: 'dxkit-uninstall',
  },
  {
    id: 'doctor',
    audience: 'user',
    group: 'setup',
    summary: 'Verify setup — and recommend capabilities you are not using',
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'Check that dxkit is wired correctly, and advise on unused capabilities that fit this repo.',
  },
  {
    id: 'configure',
    audience: 'user',
    group: 'setup',
    summary: 'Compute + apply a deterministic config plan for this repo',
    typicalRuntime: '< 30 sec',
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
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'The capability catalog — every command with its group, summary, and driving skill, plus repo-grounded recommendations. `--json` is the agent-queryable menu for configuring dxkit conversationally.',
    skill: 'dxkit-learn',
  },
  {
    id: 'tools',
    audience: 'user',
    group: 'setup',
    summary: 'Show / install required analysis tools',
    typicalRuntime: '< 5 sec (list); install varies',
    docsBlurb:
      'Report the status of external analysis tools (semgrep, gitleaks, …) and install missing ones.',
  },
  {
    id: 'hooks',
    audience: 'user',
    group: 'setup',
    summary: 'Activate the dxkit git hooks (core.hooksPath)',
    typicalRuntime: '< 5 sec',
    docsBlurb: 'Idempotently point git at .githooks so the pre-push guardrail runs on every push.',
    skill: 'dxkit-hooks',
  },
  {
    id: 'setup-branch-protection',
    audience: 'user',
    group: 'setup',
    aliases: ['protect'],
    summary: 'Set up branch protection / required checks (dry-run by default)',
    typicalRuntime: '< 5 sec',
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
    typicalRuntime: '< 5 sec',
    docsBlurb: 'Install a GitHub Actions workflow that prebuilds the dxkit devcontainer image.',
  },
  {
    id: 'upgrade',
    audience: 'user',
    group: 'setup',
    summary: 'Plan / apply a dxkit version upgrade',
    typicalRuntime: '1-3 min',
    docsBlurb:
      'Show a package-manager-aware upgrade plan for the dxkit devDependency and its transition steps.',
  },
  {
    id: 'issue',
    audience: 'user',
    group: 'setup',
    summary: 'Open a pre-filled GitHub issue against dxkit',
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'Compose a typed feedback issue (false-positive / bug / feature-request / …); nothing submits until you confirm in the browser.',
  },
  // ── Assess ─────────────────────────────────────────────────────────────
  {
    id: 'health',
    audience: 'user',
    group: 'assess',
    summary: 'Run the deterministic 6-dimension health analysis',
    typicalRuntime: '1-4 min',
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
    typicalRuntime: '1-3 min',
    docsBlurb:
      'Secrets, SAST, and dependency-vulnerability findings with CVSS scoring and remediation proposals.',
    skill: 'dxkit-reports',
  },
  {
    id: 'test-gaps',
    audience: 'user',
    group: 'assess',
    summary: 'Analyze test coverage gaps',
    typicalRuntime: '30-90 sec',
    docsBlurb:
      'Surface untested source files by risk tier, crediting coverage artifacts and import-graph reachability.',
    skill: 'dxkit-test',
  },
  {
    id: 'tests',
    audience: 'user',
    group: 'assess',
    summary: 'Select tests affected by a diff via the code graph',
    typicalRuntime: '< 5 sec (queries the graph)',
    docsBlurb:
      '`tests affected --diff <ref>` lists the test files a change reaches, computed from the call graph (beats module-graph selection in composition-root repos). Fails safe to the full suite when the graph is missing, stale, or unreliable for a changed language.',
    skill: 'dxkit-test',
  },
  {
    id: 'evaluate',
    audience: 'user',
    group: 'assess',
    summary: 'Zero-write trial: replay your recent landings through the gate',
    typicalRuntime: '30 sec - 1 min per landing',
    docsBlurb:
      'What dxkit would have blocked on your last N merged changes, plus what enabling it costs (measured gate latency, interruption rate, setup) — computed in disposable worktrees, writing nothing to your repo.',
    skill: 'dxkit-evaluate',
    whenToRecommend: recommendEvaluate,
  },
  {
    id: 'quality',
    audience: 'user',
    group: 'assess',
    summary: 'Code quality + slop detection',
    typicalRuntime: '1-8 min (jscpd is the long-pole)',
    docsBlurb:
      'Duplication, complexity, and AI-slop signals rolled into the Code Quality dimension. ' +
      'The opt-in structural-duplicate (seam) gate (`duplication.mode`) additionally flags a ' +
      'net-new function that copy-pastes another — read from the call graph, so it survives ' +
      'rename/reformat where token duplication does not.',
    skill: 'dxkit-action',
    whenToRecommend: recommendDuplication,
    planConfig: planDuplicationMode,
  },
  {
    id: 'dev-report',
    audience: 'user',
    group: 'assess',
    summary: 'Developer activity analysis',
    typicalRuntime: '5-30 sec',
    docsBlurb: 'Recency-weighted git activity: active owners, bus-factor, and contribution shape.',
  },
  {
    id: 'licenses',
    audience: 'user',
    group: 'assess',
    summary: 'Dependency license inventory',
    typicalRuntime: '30-60 sec',
    docsBlurb: 'Enumerate dependency licenses and attribution for the dependency tree.',
  },
  {
    id: 'bom',
    audience: 'user',
    group: 'assess',
    summary: 'Bill of Materials (licenses + vulnerabilities joined)',
    typicalRuntime: '1-3 min',
    docsBlurb: 'Join the license inventory with the vulnerability scan into one dependency BOM.',
  },
  {
    id: 'coverage',
    audience: 'user',
    group: 'assess',
    summary: 'Run per-pack test-with-coverage (materializes the artifact)',
    typicalRuntime: 'varies (runs your tests)',
    docsBlurb:
      'Side-effecting: run each active pack’s coverage command so health/test-gaps read line-level truth.',
  },
  {
    id: 'dashboard',
    audience: 'user',
    group: 'assess',
    summary: 'Render .dxkit/reports/ into one HTML dashboard',
    typicalRuntime: '< 5 sec (renders existing reports)',
    docsBlurb: 'Combine the generated reports into a single browsable HTML dashboard.',
    skill: 'dxkit-reports',
  },
  {
    id: 'report',
    audience: 'user',
    group: 'assess',
    summary: 'Full audit (report), or publish/read a score snapshot (report snapshot|history)',
    typicalRuntime: '5-30 min',
    docsBlurb:
      'One command to run all analyzers and render the dashboard — the full-audit entry point. ' +
      '`report snapshot` publishes a per-merge score snapshot to the dxkit-reports ref; ' +
      '`report history` renders the score-over-time trend (`--markdown` emits a "score moved X→Y" ' +
      'block for a CI job summary or PR comment). Automate snapshots on merge with ' +
      '`policy.json:reports.onMerge` (the dxkit-reports-refresh workflow).',
    skill: 'dxkit-reports',
    whenToRecommend: recommendReportsOnMerge,
  },
  {
    id: 'metrics',
    audience: 'user',
    group: 'assess',
    summary: 'Findings the gate stopped before merge + the score-over-time trend',
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'The champion ROI report, computed not narrated: net-new findings the guardrail intercepted before they reached the base branch, per week and by category, from the append-only loop ledger. Interceptions are the ungameable number; --since <ref|date> scopes the window. Also surfaces the score-over-time trend (how each dimension moved) from the dxkit-reports snapshots when on-merge reports are enabled.',
    skill: 'dxkit-reports',
  },
  // ── Gate ── (partitioned by group for file size — command-defs-gate.ts)
  ...GATE_COMMANDS,
  // ── Integrate ──────────────────────────────────────────────────────────
  {
    id: 'schema',
    audience: 'user',
    group: 'gate',
    summary: 'Data-model inventory + the schema drift gate',
    typicalRuntime: '5-30 sec',
    docsBlurb:
      'Extract every declared data model (ORM entities, tagged structs, spec schemas) and ' +
      'gate breaking changes — a removed field, a changed type, an optional field made ' +
      'required. `schema` lists the inventory, `schema diff --ref <base>` previews the exact ' +
      'verdict the guardrail will reach; a deliberate breaking change ships via an expiring ' +
      'accepted-risk allowlist entry.',
    skill: 'dxkit-schema',
    whenToRecommend: recommendSchema,
    planConfig: planSchemaMode,
  },
  {
    id: 'flow',
    audience: 'user',
    group: 'integrate',
    summary: 'UI→API integration mapping + the broken-integration gate',
    typicalRuntime: '5-30 sec',
    docsBlurb:
      'Map client calls to served endpoints and gate changes that break a UI→API contract across ' +
      'repos. `flow` also surfaces the tiered dead-surface inventory — served routes with no ' +
      'consumer, classified removable / likely / expected, plus the seam-convergence callout (a ' +
      'route that is BOTH unconsumed AND a structural duplicate). `flow publish --land` refreshes ' +
      '+ lands the committed contract snapshots (the on-merge refresh workflow runs it; `pr` opens ' +
      'one standing reviewable PR, `push` commits directly on unprotected trunks).',
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
    typicalRuntime: '< 5 sec (queries the graph)',
    docsBlurb:
      'Query the graphify artifact: hot-files, entry-points, communities, api-surface, per-file/feature context.',
  },
  {
    id: 'context',
    audience: 'user',
    group: 'explore',
    summary: 'Slim structural code slice for a query (token-efficient)',
    typicalRuntime: '< 5 sec (queries the graph)',
    docsBlurb:
      'Budget-bounded structural context for a query — a compact codebase slice for an LLM.',
  },
  {
    id: 'reviewers',
    audience: 'user',
    group: 'explore',
    summary: 'Suggest reviewers via the active-owner model',
    typicalRuntime: '< 5 sec',
    docsBlurb:
      'Rank reviewers by recency-weighted ownership of the touched files, blended with CODEOWNERS, with a bus-factor signal.',
  },
  {
    id: 'describe',
    audience: 'user',
    group: 'explore',
    summary: 'Zero-write repo card + a self-contained contract-map HTML',
    typicalRuntime: '< 10 sec',
    docsBlurb:
      'A shareable snapshot of what dxkit sees: the stack, the HTTP flow spine (routes served, calls made, how they bind), and the data models — every count labeled observed / derived / inferred / unknown so the picture is honest. Prints a terminal summary, --json for the versioned repo card, or --html for a screenshot-worthy contract map (--out <file> to save it). Writes nothing to your repo unless you pass --out.',
    skill: 'dxkit-describe',
  },

  // ── Export ─────────────────────────────────────────────────────────────
  {
    id: 'to-xlsx',
    audience: 'user',
    group: 'export',
    summary: 'Convert a dxkit JSON report to XLSX',
    typicalRuntime: '< 5 sec',
    docsBlurb: 'Render a dxkit JSON report into a 15-column spreadsheet for sharing.',
  },

  ...INTERNAL_COMMANDS, // machine-invoked partition — command-defs-internal.ts
  {
    id: 'demo',
    audience: 'user',
    group: 'explore',
    summary: 'Offline, no-API demonstration walkthroughs',
    typicalRuntime: '1-2 min (interactive walkthrough)',
    docsBlurb:
      'Run a self-contained walkthrough (default: the loop-guardrail demo) with no network or API key.',
  },
] as const satisfies readonly CapabilityDescriptor[];

/** The literal union of every registered command id. */
export type CommandId = (typeof COMMANDS)[number]['id'];
