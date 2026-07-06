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

  // ── Gate ───────────────────────────────────────────────────────────────
  {
    id: 'baseline',
    audience: 'user',
    group: 'gate',
    summary: 'Capture / show per-finding baselines for the guardrail',
    docsBlurb:
      'Record per-finding identities the guardrail check diffs against to gate net-new regressions.',
    whenToRecommend: recommendBaseline,
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

/** Recommend `flow init` on a UI repo with no flow setup. */
function recommendFlow(ctx: RecommendContext): Recommendation | null {
  const pkg = readJsonSafe(path.join(ctx.cwd, 'package.json'));
  if (!pkg) return null;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  const uiFrameworks = ['react', 'next', 'vue', 'svelte', '@angular/core'];
  if (!uiFrameworks.some((f) => f in deps)) return null;
  // Already configured? workspace.json or a flow policy block means yes.
  if (existsAt(ctx.cwd, '.dxkit', 'workspace.json')) return null;
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json'));
  if (policy && 'flow' in policy) return null;
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
function recommendChecks(ctx: RecommendContext): Recommendation | null {
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  // `.dxkit/policy.json` is flat (resolvePolicy spreads it at the top level),
  // so `checks` / `lint` are top-level keys — mirror of the flow probe's
  // `'flow' in policy`.
  const checks = policy.checks;
  const lint = policy.lint as Record<string, unknown> | undefined;
  // Already opted in? (a declared check, or the lint gate enabled) → silent.
  if (Array.isArray(checks) && checks.length > 0) return null;
  if (lint?.enabled === true) return null;

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
  let signal = lintConfigs.some((f) => existsAt(ctx.cwd, f));
  if (!signal) {
    const pkg = readJsonSafe(path.join(ctx.cwd, 'package.json'));
    const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};
    signal = typeof scripts.lint === 'string';
  }
  if (!signal) return null;

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
