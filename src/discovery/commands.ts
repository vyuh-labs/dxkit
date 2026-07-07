/**
 * The command capability registry — dxkit's single source of truth for
 * "what user-facing capabilities exist and how a user (and an agent)
 * discovers them."
 *
 * Every top-level CLI command declares ONE descriptor here. That one
 * registry drives every discovery surface:
 *   - the grouped `vyuh-dxkit` help index (`renderCommandIndex`);
 *   - `doctor` advisor mode (a command's `whenToRecommend` probe);
 *   - the agent-facing skill mapping (`skill`);
 *   - generated docs.
 *
 * Enforcement (CLAUDE.md Rule 16 — the block-if-unregistered gate, mirror
 * of Rule 15's managed-write gate):
 *   - `scripts/check-architecture.sh` diffs the top-level `case '<id>':`
 *     set in `src/cli.ts` against the ids + aliases declared here — a new
 *     command that skips registration fails the pre-commit gate;
 *   - `test/discovery-playbook.test.ts` asserts field completeness for
 *     user-facing commands, that every referenced `skill` file exists, and
 *     (synthetic-command injection) that the parity checker actually bites.
 *
 * Because the registry is the ground truth, a capability cannot be added
 * without declaring how it is discovered — discoverability is part of a
 * feature's definition of done, not a docs afterthought.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveBaselineMode } from '../baseline/modes';
import type { RepoVisibility } from '../baseline/visibility';
import { FLOW_CONFIG_SCHEMA_VERSION } from '../analyzers/flow/config';
import { isClaudeLoopInstalled } from '../loop/scaffold';

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
      'Configure branch protection so the guardrail check is a required status. `protect` is the dry-run-first alias.',
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
    summary: 'Run every analyzer + dashboard in one shot (full audit)',
    docsBlurb:
      'One command to run all analyzers and render the dashboard — the full-audit entry point.',
    skill: 'dxkit-reports',
  },
  {
    id: 'metrics',
    audience: 'user',
    group: 'assess',
    summary: 'Findings the gate stopped before merge — the ROI series from the loop ledger',
    docsBlurb:
      'The champion ROI report, computed not narrated: net-new findings the guardrail intercepted before they reached the base branch, per week and by category, from the append-only loop ledger. Interceptions are the ungameable number; --since <ref|date> scopes the window.',
    skill: 'dxkit-reports',
  },

  // ── Gate ───────────────────────────────────────────────────────────────
  {
    id: 'baseline',
    audience: 'user',
    group: 'gate',
    summary: 'Capture / show per-finding baselines for the guardrail',
    docsBlurb:
      'Record per-finding identities the guardrail check diffs against to gate net-new regressions.',
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

/**
 * A widened view of the registry as `CapabilityDescriptor[]`. `COMMANDS` is
 * `as const`, so its element union narrows away optional fields (`aliases`)
 * on entries that omit them; helpers read the widened view so optional
 * access type-checks, while `CommandId` still derives from the const tuple.
 */
const ALL: readonly CapabilityDescriptor[] = COMMANDS;

/** Every id + alias that the dispatcher must accept (the "known command" set). */
export function allCommandTokens(): string[] {
  const tokens: string[] = [];
  for (const c of ALL) {
    tokens.push(c.id);
    for (const a of c.aliases ?? []) tokens.push(a);
  }
  return tokens;
}

/** Look up a descriptor by id or alias. */
export function getCommand(idOrAlias: string): CapabilityDescriptor | undefined {
  return ALL.find((c) => c.id === idOrAlias || (c.aliases ?? []).includes(idOrAlias));
}

/** User-facing commands only (the help index + docs surface). */
export function userCommands(): readonly CapabilityDescriptor[] {
  return ALL.filter((c) => c.audience === 'user');
}

/** Human labels for each group, in help-index display order. */
export const GROUP_LABELS: Record<Exclude<CommandGroup, 'internal'>, string> = {
  assess: 'Assess',
  gate: 'Gate',
  integrate: 'Integrate',
  explore: 'Explore',
  setup: 'Setup',
  export: 'Export',
};

/** Display order for the grouped help index. */
export const GROUP_ORDER: Array<Exclude<CommandGroup, 'internal'>> = [
  'assess',
  'gate',
  'integrate',
  'explore',
  'setup',
  'export',
];

/**
 * A grouped, one-line-per-command index of the user-facing commands.
 * Drives the unknown-command hint today; the top-level `--help` index next.
 */
export function renderCommandIndex(): string[] {
  const lines: string[] = [];
  for (const group of GROUP_ORDER) {
    const cmds = userCommands().filter((c) => c.group === group);
    if (cmds.length === 0) continue;
    lines.push(`  ${GROUP_LABELS[group]}`);
    for (const c of cmds) {
      const name = c.aliases?.length ? `${c.id} (${c.aliases.join(', ')})` : c.id;
      lines.push(`    ${name.padEnd(28)} ${c.summary}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Best-effort "did you mean" for an unknown command token: user-facing ids
 * (and aliases) that share a prefix with, contain, or are contained by the
 * input. Deliberately simple — a typo hint, not fuzzy search.
 */
export function suggestCommand(input: string): string[] {
  const q = input.toLowerCase();
  if (q.length === 0) return [];
  const hits = new Set<string>();
  for (const c of userCommands()) {
    for (const token of [c.id, ...(c.aliases ?? [])]) {
      const t = token.toLowerCase();
      if (t.startsWith(q) || q.startsWith(t) || t.includes(q) || q.includes(t)) {
        hits.add(c.id);
        break;
      }
    }
  }
  return [...hits];
}

// ─── Doctor advisor probes ──────────────────────────────────────────────────
// Grounded, cheap recommendations `doctor` surfaces for capabilities the repo
// would benefit from but isn't using. Each probe is self-contained (cwd + fs
// only) and conservative — it fires only on a clear signal and returns null
// once the capability is in use, so `doctor` never nags about what's already
// set up. New capabilities attach their own probe here as they land (the gate
// runner's "you have ungated repo checks" probe is the marquee future case).

function existsAt(...parts: string[]): boolean {
  try {
    return fs.existsSync(path.join(...parts));
  } catch {
    return false;
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function dirHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
}

/** Recommend `baseline create` when dxkit is installed but has no baseline. */
function recommendBaseline(ctx: RecommendContext): Recommendation | null {
  // Only relevant once dxkit is installed (the manifest exists). Without a
  // baseline, `guardrail check` has nothing to diff against.
  if (!existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (dirHasEntries(path.join(ctx.cwd, '.dxkit', 'baselines'))) return null;
  return {
    reason:
      'dxkit is installed but no baseline exists — the guardrail cannot gate net-new findings without one',
    command: 'vyuh-dxkit baseline create',
  };
}

/**
 * Signal: this repo has a UI framework but no flow setup yet — the case where
 * flow's UI→API integration gate adds value. Shared by BOTH the doctor probe
 * (`recommendFlow`) and the deterministic planner (`planFlowMode`) so the two
 * never diverge (Rule 2 — one concept, one code path).
 */
function hasFlowSignal(cwd: string): boolean {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  if (!pkg) return false;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  const uiFrameworks = ['react', 'next', 'vue', 'svelte', '@angular/core'];
  if (!uiFrameworks.some((f) => f in deps)) return false;
  // Already configured? workspace.json or a flow policy block means yes.
  if (existsAt(cwd, '.dxkit', 'workspace.json')) return false;
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json'));
  if (policy && 'flow' in policy) return false;
  return true;
}

/** Recommend `flow init` on a UI repo with no flow setup. */
function recommendFlow(ctx: RecommendContext): Recommendation | null {
  if (!hasFlowSignal(ctx.cwd)) return null;
  return {
    reason:
      'detected a UI framework but no flow setup — flow maps UI→API calls and gates changes that break an integration',
    command: 'vyuh-dxkit flow init',
  };
}

/**
 * Recommend the custom-check gate when the repo runs a linter but hasn't wired
 * it into dxkit's guardrail. The gate is opt-in default-off, so a repo with a
 * clear lint signal and no `checks` / `lint` policy block is exactly the case
 * where "block only net-new lint errors" adds value without the user knowing to
 * ask for it. Conservative: fires only on a concrete linter signal, and goes
 * silent once the policy opts in.
 */
/**
 * Signal: this repo runs a linter but has NOT wired it into dxkit's gate. Shared
 * by the doctor probe (`recommendChecks`) and the deterministic planner
 * (`planLintGate`) so they never diverge (Rule 2). Conservative: fires only on
 * a concrete linter config / `lint` script, and goes silent the moment the
 * `checks` / `lint` policy opts in.
 */
function hasLintSignal(cwd: string): boolean {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json')) ?? {};
  // `.dxkit/policy.json` is flat (resolvePolicy spreads it at the top level),
  // so `checks` / `lint` are top-level keys — mirror of the flow probe's
  // `'flow' in policy`.
  const checks = policy.checks;
  const lint = policy.lint as Record<string, unknown> | undefined;
  // Already opted in? (a declared check, or the lint gate enabled) → silent.
  if (Array.isArray(checks) && checks.length > 0) return false;
  if (lint?.enabled === true) return false;

  // A concrete linter signal: a standalone lint config, or a package.json
  // `lint` script. Kept conservative so this never nags a repo without one.
  const lintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'ruff.toml',
    '.ruff.toml',
    '.rubocop.yml',
    '.golangci.yml',
    '.golangci.yaml',
  ];
  if (lintConfigs.some((f) => existsAt(cwd, f))) return true;
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};
  return typeof scripts.lint === 'string';
}

function recommendChecks(ctx: RecommendContext): Recommendation | null {
  if (!hasLintSignal(ctx.cwd)) return null;
  return {
    reason:
      'this repo runs a linter but it is not a guardrail gate — enable the lint gate so net-new lint errors block (pre-existing debt is grandfathered)',
    command: 'vyuh-dxkit checks',
  };
}

/** One command's advisor recommendation, tagged with the command id. */
export interface CommandRecommendation {
  id: string;
  recommendation: Recommendation;
}

/**
 * Run every user-facing command's `whenToRecommend` probe against `cwd` and
 * collect the recommendations that fired. Fail-open per probe: a throwing
 * probe is skipped, never breaks `doctor`. This is the data behind doctor
 * advisor mode — contextual capability discovery grounded in the repo.
 */
export function gatherRecommendations(cwd: string): CommandRecommendation[] {
  const out: CommandRecommendation[] = [];
  for (const c of userCommands()) {
    if (!c.whenToRecommend) continue;
    try {
      const rec = c.whenToRecommend({ cwd });
      if (rec) out.push({ id: c.id, recommendation: rec });
    } catch {
      // A probe never breaks doctor.
    }
  }
  return out;
}

// ─── Deterministic config planners (`vyuh-dxkit configure`) ──────────────────
// Each is a PURE function of observable repo facts — same repo, same plan, every
// run and every environment. That reproducibility is the whole point: the config
// value is COMPUTED, never chosen by an agent. Each returns null when there's
// nothing to recommend (already pinned, or no signal), exactly like the doctor
// probes above. New capabilities attach their own `planConfig` to their
// descriptor and are picked up by `gatherConfigPlan` with no other edit.

/**
 * Baseline mode: pin the visibility-derived default explicitly so every
 * developer and CI job agree. This is load-bearing, not cosmetic — a developer
 * without `gh` access resolves visibility to 'unknown' (→ committed-full) while
 * CI with `gh` sees 'public' (→ ref-based), so an UNPINNED repo silently uses
 * two different postures. Reuses the canonical resolver (Rule 11); returns null
 * once `baseline.mode` is pinned.
 */
function planBaselineMode(ctx: ConfigContext): ConfigPlanItem | null {
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  const baseline = policy.baseline as Record<string, unknown> | undefined;
  if (baseline && typeof baseline.mode === 'string') return null; // already pinned
  const resolved = resolveBaselineMode({
    cwd: ctx.cwd,
    probeVisibility: ctx.probeVisibility,
    probeDefaultRef: ctx.probeDefaultRef,
  });
  const patchBaseline: Record<string, unknown> = { mode: resolved.mode };
  if (resolved.mode === 'ref-based' && resolved.ref) patchBaseline.ref = resolved.ref;
  const summary =
    resolved.mode === 'ref-based' && resolved.ref
      ? `${resolved.mode} (${resolved.ref})`
      : resolved.mode;
  return {
    capability: 'baseline',
    section: 'baseline.mode',
    summary,
    patch: { baseline: patchBaseline },
    reason: `pin the baseline posture so every developer + CI agree (${resolved.explanation})`,
    evidence: `source=${resolved.source}`,
  };
}

/**
 * Flow gate: on a UI repo with no flow setup, seed the safe default posture —
 * `warn` (surface net-new broken integrations, never fail a build). The team
 * moves it to `block` later via the dxkit-flow skill. Reuses `hasFlowSignal`
 * (shared with the doctor probe, Rule 2).
 */
function planFlowMode(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasFlowSignal(ctx.cwd)) return null;
  return {
    capability: 'flow',
    section: 'flow.mode',
    summary: 'warn',
    patch: { flow: { mode: 'warn', schemaVersion: FLOW_CONFIG_SCHEMA_VERSION } },
    reason: 'seed the UI→API integration gate at the safe default (warn, never fails a build)',
    evidence: 'UI framework in package.json, no flow config yet',
  };
}

/**
 * Lint gate: on a repo that runs a linter but hasn't wired it in, enable the
 * gate WARN-only (`blocking: false`) — net-new lint errors surface without the
 * pre-existing backlog suddenly blocking. The team flips `blocking: true` once
 * the backlog is clean. Reuses `hasLintSignal` (shared with the doctor probe).
 */
function planLintGate(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasLintSignal(ctx.cwd)) return null;
  return {
    capability: 'checks',
    section: 'lint',
    summary: 'enabled, warn-only',
    patch: { lint: { enabled: true, blocking: false } },
    reason: 'gate net-new lint errors without blocking on the pre-existing backlog',
    evidence: 'linter config / lint script present, no lint policy yet',
  };
}

/**
 * Loop posture: if the Stop-gate is installed but `loop.preset` is unpinned,
 * pin the safe default (`security-only`). Rarely fires in practice — the loop
 * scaffold seeds the preset at install — so this is a safety net. Reuses the
 * canonical Stop-hook detector (`isClaudeLoopInstalled`, Rule 2).
 */
function planLoopPreset(ctx: ConfigContext): ConfigPlanItem | null {
  if (!isClaudeLoopInstalled(ctx.cwd)) return null;
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  const loop = policy.loop as Record<string, unknown> | undefined;
  if (loop && typeof loop.preset === 'string') return null; // already pinned
  return {
    capability: 'loop',
    section: 'loop.preset',
    summary: 'security-only',
    patch: { loop: { preset: 'security-only' } },
    reason: 'pin the safe default loop posture (blocks net-new security, warns on debt)',
    evidence: 'loop Stop-gate installed, no preset pinned',
  };
}

/**
 * Recommend `configure` from doctor when dxkit is installed but nothing is
 * configured yet (no `.dxkit/policy.json`). Cheap probe — it does not compute
 * the full plan, just the clearest "unconfigured" signal.
 */
function recommendConfigure(ctx: RecommendContext): Recommendation | null {
  if (!existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (existsAt(ctx.cwd, '.dxkit', 'policy.json')) return null;
  return {
    reason:
      'dxkit is installed but nothing is configured — compute a deterministic config plan from this repo',
    command: 'vyuh-dxkit configure --plan',
  };
}

/**
 * Run every capability's `planConfig` against `cwd` and collect the
 * deterministic items that fired — the data behind `vyuh-dxkit configure`.
 * Registry-driven: iterates `userCommands()`, so a new capability that declares
 * `planConfig` is covered with no edit here. Fail-open per planner (a throwing
 * planner is skipped, never aborts the pass). The driving `skill` is stamped
 * from the descriptor so the agent knows which skill owns each item.
 */
export function gatherConfigPlan(
  cwd: string,
  opts: Omit<ConfigContext, 'cwd'> = {},
  registry: readonly CapabilityDescriptor[] = userCommands(),
): ConfigPlanItem[] {
  const out: ConfigPlanItem[] = [];
  for (const c of registry) {
    if (!c.planConfig) continue;
    try {
      const item = c.planConfig({ cwd, ...opts });
      if (item) out.push({ ...item, skill: item.skill ?? c.skill });
    } catch {
      // A planner never aborts the configure pass.
    }
  }
  return out;
}
