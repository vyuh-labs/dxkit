import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Manifest } from './types';
import { activeLanguagesFromStack } from './languages';
import * as logger from './logger';

/**
 * Three-tier doctor:
 *
 * Tier 1 — Reports prerequisites: the small set of things that must
 * be present for ANY dxkit CLI command to work. Node 18+ and git.
 * Failure here = dxkit can't function = exit 1.
 *
 * Tier 2 — Agent DX prerequisites: the `.vyuh-dxkit.json` manifest +
 * the `.claude/*` scaffolding that `vyuh-dxkit init` generates. These
 * only matter if you want Agent DX features. Failure here =
 * informational warn + a hint to run `init`; exit code unaffected.
 *
 * Tier 3 — Operational health: runtime state that determines whether
 * dxkit is ACTUALLY working end-to-end on this machine. Hooks active,
 * baseline captured, PATH integrity, scanner toolchain healthy,
 * `.npmrc` peer-deps state, CI workflows wired. Each failing check
 * carries fix metadata (a hint + command + skill) so an agent can
 * drive the repair without re-deriving what's wrong.
 *
 * Pre-Tier-3 the doctor counted file existence and called the system
 * "fully scaffolded" when files were present but operational signals
 * (hooks not activated, no baseline, vyuh-dxkit not on PATH, etc.)
 * were broken — actively misleading on Codespaces installs. Tier 3
 * surfaces those operational gaps with fix hints.
 *
 * --json mode prints the full structured `DoctorReport` to stdout
 * (logger prose routed to stderr by `setJsonMode`). dxkit-fix
 * consumes this format to walk the customer through repairs.
 */

export interface CheckResult {
  label: string;
  ok: boolean;
  tier: 'reports' | 'dx' | 'operational';
  /**
   * Fix metadata — present when ok=false AND a fix is known. Absent
   * on passing checks (nothing to fix) and on failures without a
   * canned repair path (some checks just inform).
   */
  fix?: {
    /** One-line human-readable description of what to do. */
    hint: string;
    /** Optional shell command an agent can run to fix it. */
    command?: string;
    /** Optional dxkit-* skill that drives the repair conversationally. */
    skill?: string;
  };
}

export interface DoctorReport {
  schema: 'doctor.v1';
  generatedAt: string;
  cwd: string;
  checks: CheckResult[];
  summary: {
    reports: { pass: number; fail: number; status: 'ok' | 'fail' };
    dx: { pass: number; fail: number; status: 'ok' | 'partial' | 'absent' };
    operational: { pass: number; fail: number; status: 'ok' | 'partial' | 'fail' };
    /**
     * Subset of `checks` where ok=false AND fix metadata is present.
     * dxkit-fix iterates this to drive the repair conversation.
     */
    fixable: CheckResult[];
  };
}

function commandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function nodeMajorVersion(): number {
  const raw = process.versions.node;
  const m = raw.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * `git config --local --get core.hooksPath` returns the configured
 * hooksPath for the current repo, or non-zero if unset. dxkit's
 * pre-push hook lives at `.githooks/pre-push` and only fires when
 * hooksPath is set to `.githooks`. A repo with its own postinstall
 * script (patch-package, husky bootstrap, etc.) silently skips the
 * dxkit auto-activation; this check surfaces that gap.
 */
function readHooksPath(cwd: string): string | null {
  try {
    const out = execSync('git config --local --get core.hooksPath', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Count failing scanner-tool installs by reading the cached
 * dxkit-tools-status sentinel that `vyuh-dxkit tools install --yes`
 * writes. We avoid re-running `tools list` here because it spawns
 * subprocess probes for every tool (slow) and doctor should stay
 * fast. The sentinel lives at `.dxkit/tools-status.json` and reflects
 * the last `tools install` outcome.
 *
 * Returns `{ found: false }` if the sentinel doesn't exist — the
 * check then renders as "unknown" (warn, not fail) because we can't
 * tell. Returns `{ found: true, failed: [...] }` otherwise.
 */
function readToolsStatus(cwd: string): { found: false } | { found: true; failed: string[] } {
  const statusPath = path.join(cwd, '.dxkit', 'tools-status.json');
  if (!fs.existsSync(statusPath)) return { found: false };
  try {
    const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
      tools?: Array<{ name: string; status: string }>;
    };
    const failed = (data.tools ?? [])
      .filter((t) => t.status === 'missing' || t.status === 'failed')
      .map((t) => t.name);
    return { found: true, failed };
  } catch {
    return { found: true, failed: [] };
  }
}

/**
 * Detect whether the package.json install would hit a peer-dep ERESOLVE
 * that requires `legacy-peer-deps=true` in `.npmrc`. We don't run
 * `npm install --dry-run` here (too slow, hits the network). Instead we
 * read the persistence sentinel: if `.npmrc` already has the entry,
 * we're good. If it's missing AND the host has a package.json (i.e.
 * Node project), flag it as "potentially needed" — informational only.
 *
 * The fix command is idempotent so spuriously suggesting it on a
 * package without peer-dep conflicts is harmless.
 */
function npmrcHasLegacyPeerDeps(cwd: string): boolean {
  const npmrcPath = path.join(cwd, '.npmrc');
  if (!fs.existsSync(npmrcPath)) return false;
  try {
    const lines = fs.readFileSync(npmrcPath, 'utf-8').split('\n');
    return lines.some((l) => l.trim() === 'legacy-peer-deps=true');
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// Tier builders — each returns a CheckResult[]. Pure: no logging side
// effects. The renderer below produces the prose/JSON output.
// ────────────────────────────────────────────────────────────────────

function runReportsChecks(): CheckResult[] {
  const nodeMajor = nodeMajorVersion();
  return [
    {
      label: `Node ≥ 18 (running ${process.versions.node})`,
      ok: nodeMajor >= 18,
      tier: 'reports',
      ...(nodeMajor >= 18
        ? {}
        : {
            fix: {
              hint: `Upgrade Node to v18 or newer. dxkit uses Node 22 in its devcontainer.`,
              command: 'nvm install 22 && nvm use 22',
            },
          }),
    },
    {
      label: 'git',
      ok: commandAvailable('git'),
      tier: 'reports',
      ...(commandAvailable('git')
        ? {}
        : {
            fix: {
              hint: 'Install git — dxkit reads git history for fingerprinting + baseline metadata.',
            },
          }),
    },
  ];
}

function runDxChecks(cwd: string, manifest: Manifest | null, hasManifest: boolean): CheckResult[] {
  const checks: CheckResult[] = [];

  checks.push({
    label: '.vyuh-dxkit.json exists',
    ok: hasManifest,
    tier: 'dx',
    ...(hasManifest
      ? {}
      : {
          fix: {
            hint: 'Run `vyuh-dxkit init` to scaffold the manifest + Agent DX surface.',
            command: 'npx vyuh-dxkit init --full --yes',
            skill: 'dxkit-init',
          },
        }),
  });

  if (hasManifest) {
    checks.push({
      label: '.vyuh-dxkit.json is valid JSON',
      ok: manifest !== null,
      tier: 'dx',
      ...(manifest !== null
        ? {}
        : {
            fix: {
              hint: 'Fix the JSON syntax in `.vyuh-dxkit.json`, or regenerate via `vyuh-dxkit update --force`.',
              command: 'npx vyuh-dxkit update --force',
            },
          }),
    });
  }

  const dxFiles: Array<{ label: string; relpath: string }> = [
    { label: 'AGENTS.md', relpath: 'AGENTS.md' },
    { label: 'CLAUDE.md', relpath: 'CLAUDE.md' },
    { label: '.claude/settings.json', relpath: path.join('.claude', 'settings.json') },
  ];
  for (const { label, relpath } of dxFiles) {
    const ok = fs.existsSync(path.join(cwd, relpath));
    checks.push({
      label,
      ok,
      tier: 'dx',
      ...(ok
        ? {}
        : {
            fix: {
              hint: 'Re-run `vyuh-dxkit init --with-dxkit-agents --yes` to land the missing Agent DX files.',
              command: 'npx vyuh-dxkit init --with-dxkit-agents --yes',
              skill: 'dxkit-init',
            },
          }),
    });
  }

  const DXKIT_SKILL_NAMES = [
    'dxkit-learn',
    'dxkit-init',
    'dxkit-config',
    'dxkit-hooks',
    'dxkit-reports',
    'dxkit-action',
    'dxkit-fix',
    'dxkit-update',
    'dxkit-onboard',
  ];
  const presentSkills = DXKIT_SKILL_NAMES.filter((name) =>
    fs.existsSync(path.join(cwd, '.claude', 'skills', name, 'SKILL.md')),
  );
  const allSkillsOk = presentSkills.length === DXKIT_SKILL_NAMES.length;
  checks.push({
    label: `.claude/skills/dxkit-* (${presentSkills.length}/${DXKIT_SKILL_NAMES.length})`,
    ok: allSkillsOk,
    tier: 'dx',
    ...(allSkillsOk
      ? {}
      : {
          fix: {
            hint: `${DXKIT_SKILL_NAMES.length - presentSkills.length} dxkit-* skill(s) missing. Re-run init or update.`,
            command: 'npx vyuh-dxkit update',
          },
        }),
  });

  const expectsRules =
    manifest?.config?.languages &&
    activeLanguagesFromStack(manifest.config).some((l) => l.ruleFile);
  if (expectsRules) {
    const ok = fs.existsSync(path.join(cwd, '.claude', 'rules'));
    checks.push({
      label: '.claude/rules/',
      ok,
      tier: 'dx',
      ...(ok
        ? {}
        : {
            fix: {
              hint: 'Per-language rule files missing. Re-run init or update.',
              command: 'npx vyuh-dxkit update',
            },
          }),
    });
  }

  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    let valid = true;
    try {
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      valid = false;
    }
    checks.push({
      label: 'settings.json is valid JSON',
      ok: valid,
      tier: 'dx',
      ...(valid
        ? {}
        : {
            fix: {
              hint: 'Fix syntax errors in `.claude/settings.json`, or regenerate via `vyuh-dxkit update --force`.',
              command: 'npx vyuh-dxkit update --force',
            },
          }),
    });
  }

  if (manifest?.config?.languages) {
    for (const lang of activeLanguagesFromStack(manifest.config)) {
      for (const bin of lang.cliBinaries ?? []) {
        const ok = commandAvailable(bin);
        checks.push({
          label: bin,
          ok,
          tier: 'dx',
          ...(ok
            ? {}
            : {
                fix: {
                  hint: `${bin} not on PATH — ${lang.id} analyzers will skip until it's available.`,
                },
              }),
        });
      }
    }
  }

  return checks;
}

function runOperationalChecks(cwd: string, hasManifest: boolean): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. Hooks active. `git config core.hooksPath` should be `.githooks`
  // when dxkit's pre-push protection is active. Empty → init's auto-
  // activation didn't fire (most commonly because the repo's existing
  // postinstall script preserved priority).
  const hooksPath = readHooksPath(cwd);
  const hookFileExists = fs.existsSync(path.join(cwd, '.githooks', 'pre-push'));
  if (hookFileExists) {
    const active = hooksPath === '.githooks';
    checks.push({
      label: 'git hooks active (core.hooksPath = .githooks)',
      ok: active,
      tier: 'operational',
      ...(active
        ? {}
        : {
            fix: {
              hint: 'Activate the pre-push hook so dxkit guards regressions before push.',
              command: 'npx vyuh-dxkit hooks activate',
              skill: 'dxkit-hooks',
            },
          }),
    });
  }

  // 2. Baseline captured. Without a baseline, `guardrail check` fails-
  // fast on every push. Requires .dxkit/baselines/main.json.
  if (hasManifest) {
    const baselinePath = path.join(cwd, '.dxkit', 'baselines', 'main.json');
    const exists = fs.existsSync(baselinePath);
    checks.push({
      label: 'baseline captured (.dxkit/baselines/main.json)',
      ok: exists,
      tier: 'operational',
      ...(exists
        ? {}
        : {
            fix: {
              hint: "Capture today's state as the brownfield baseline. Existing findings get locked in; only net-new ones block thereafter.",
              command: 'npx vyuh-dxkit baseline create',
              skill: 'dxkit-init',
            },
          }),
    });
  }

  // 3. PATH integrity. The bare `vyuh-dxkit` command must resolve in
  // the customer's interactive shell — half the dxkit-* skill prose
  // uses bare invocations (auto-adapted by Claude Code but broken for
  // human shells + other agents).
  const onPath = commandAvailable('vyuh-dxkit');
  checks.push({
    label: 'vyuh-dxkit on PATH',
    ok: onPath,
    tier: 'operational',
    ...(onPath
      ? {}
      : {
          fix: {
            hint: 'Install dxkit globally so the bare command resolves in your shell.',
            command: 'npm install -g @vyuhlabs/dxkit',
            skill: 'dxkit-fix',
          },
        }),
  });

  // 4. Scanner toolchain healthy. Reads the cached tools-status.json
  // sentinel from the last `tools install` run. If absent, we don't
  // flag — first-run case where the customer hasn't run install yet.
  const toolsStatus = readToolsStatus(cwd);
  if (toolsStatus.found && toolsStatus.failed.length > 0) {
    checks.push({
      label: `scanner toolchain (${toolsStatus.failed.length} missing: ${toolsStatus.failed.slice(0, 3).join(', ')}${toolsStatus.failed.length > 3 ? ', …' : ''})`,
      ok: false,
      tier: 'operational',
      fix: {
        hint: 'Re-run scanner-tool install — pinned versions live in TOOL_DEFS.',
        command: 'npx vyuh-dxkit tools install --yes',
        skill: 'dxkit-fix',
      },
    });
  } else if (toolsStatus.found) {
    checks.push({
      label: 'scanner toolchain healthy',
      ok: true,
      tier: 'operational',
    });
  }

  // 5. .npmrc peer-deps state. Only flag on Node projects where the
  // entry is missing — informational because we can't cheaply prove
  // it's NEEDED without a dry-run install.
  const isNodeProject = fs.existsSync(path.join(cwd, 'package.json'));
  if (isNodeProject) {
    const hasEntry = npmrcHasLegacyPeerDeps(cwd);
    // Only emit the check if the entry is missing — saves clutter on
    // the common case where the customer doesn't have peer-dep
    // conflicts. (Idempotent fix means a false-positive flag is
    // harmless if the customer follows it.)
    if (!hasEntry) {
      checks.push({
        label: '.npmrc legacy-peer-deps persistence',
        ok: false,
        tier: 'operational',
        fix: {
          hint: 'If create-dxkit fell back to --legacy-peer-deps, persist the choice to .npmrc so future installs work.',
          command: 'echo "legacy-peer-deps=true" >> .npmrc',
          skill: 'dxkit-fix',
        },
      });
    }
  }

  // 6. CI workflows wired. Only relevant for Agent DX customers who
  // ran init --with-ci. dxkit-guardrails.yml is the PR gate.
  if (hasManifest) {
    const guardrailWf = path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml');
    const ok = fs.existsSync(guardrailWf);
    checks.push({
      label: 'CI guardrails workflow (.github/workflows/dxkit-guardrails.yml)',
      ok,
      tier: 'operational',
      ...(ok
        ? {}
        : {
            fix: {
              hint: 'Scaffold the dxkit-guardrails GitHub Actions workflow so PRs run the guardrail check.',
              command: 'npx vyuh-dxkit init --with-ci --yes',
              skill: 'dxkit-init',
            },
          }),
    });
  }

  return checks;
}

// ────────────────────────────────────────────────────────────────────
// Renderers
// ────────────────────────────────────────────────────────────────────

function buildReport(cwd: string, checks: CheckResult[]): DoctorReport {
  const byTier = {
    reports: checks.filter((c) => c.tier === 'reports'),
    dx: checks.filter((c) => c.tier === 'dx'),
    operational: checks.filter((c) => c.tier === 'operational'),
  };
  const tally = (arr: CheckResult[]) => ({
    pass: arr.filter((c) => c.ok).length,
    fail: arr.filter((c) => !c.ok).length,
  });
  const reportsTally = tally(byTier.reports);
  const dxTally = tally(byTier.dx);
  const opTally = tally(byTier.operational);

  return {
    schema: 'doctor.v1',
    generatedAt: new Date().toISOString(),
    cwd,
    checks,
    summary: {
      reports: {
        ...reportsTally,
        status: reportsTally.fail === 0 ? 'ok' : 'fail',
      },
      dx: {
        ...dxTally,
        status: byTier.dx.length === 0 ? 'absent' : dxTally.fail === 0 ? 'ok' : 'partial',
      },
      operational: {
        ...opTally,
        status:
          byTier.operational.length === 0
            ? 'ok'
            : opTally.fail === 0
              ? 'ok'
              : opTally.fail === byTier.operational.length
                ? 'fail'
                : 'partial',
      },
      fixable: checks.filter((c) => !c.ok && c.fix),
    },
  };
}

function renderProse(report: DoctorReport, hasManifest: boolean): void {
  logger.header('vyuh-dxkit doctor');

  const byTier = {
    reports: report.checks.filter((c) => c.tier === 'reports'),
    dx: report.checks.filter((c) => c.tier === 'dx'),
    operational: report.checks.filter((c) => c.tier === 'operational'),
  };

  // Tier 1
  logger.info('Reports prerequisites (required to run any dxkit command):');
  for (const c of byTier.reports) {
    if (c.ok) logger.success(c.label);
    else logger.fail(c.label);
  }

  // Tier 2
  if (byTier.dx.length > 0) {
    console.log(''); // slop-ok
    logger.info('Agent DX prerequisites (only required for `init`-generated artifacts):');
    for (const c of byTier.dx) {
      if (c.ok) logger.success(c.label);
      else logger.warn(c.label);
    }
  }

  // Tier 3
  if (byTier.operational.length > 0) {
    console.log(''); // slop-ok
    logger.info('Operational health (runtime state of this install):');
    for (const c of byTier.operational) {
      if (c.ok) logger.success(c.label);
      else logger.warn(c.label);
    }
  }

  // Summary
  console.log(''); // slop-ok
  logger.header('Results');

  const r = report.summary.reports;
  if (r.status === 'ok') {
    logger.success(`Reports: ${r.pass}/${r.pass + r.fail} — ready to run dxkit`);
  } else {
    logger.fail(
      `Reports: ${r.pass}/${r.pass + r.fail} — fix the failures above before running other dxkit commands`,
    );
  }

  const dx = report.summary.dx;
  const dxTotal = dx.pass + dx.fail;
  if (dxTotal > 0) {
    if (dx.status === 'ok') {
      logger.success(`Agent DX: ${dx.pass}/${dxTotal} — fully scaffolded`);
    } else {
      logger.warn(`Agent DX: ${dx.pass}/${dxTotal} — partial scaffolding`);
    }
  }

  const op = report.summary.operational;
  const opTotal = op.pass + op.fail;
  if (opTotal > 0) {
    if (op.status === 'ok') {
      logger.success(`Operational health: ${op.pass}/${opTotal} — install is wired end-to-end`);
    } else {
      logger.warn(`Operational health: ${op.pass}/${opTotal} — ${op.fail} issue(s) to address`);
    }
  }

  // Fix hints — render when ANY tier has actionable failures.
  if (report.summary.fixable.length > 0) {
    console.log(''); // slop-ok
    logger.info('Suggested fixes:');
    for (const c of report.summary.fixable) {
      const cmd = c.fix?.command ? `  → ${c.fix.command}` : '';
      logger.dim(`• ${c.label}: ${c.fix?.hint ?? ''}`);
      if (cmd) logger.dim(cmd);
    }
    console.log(''); // slop-ok
    logger.dim('💡 Ask Claude Code "fix dxkit" to walk through these via the dxkit-fix skill.');
  } else if (dxTotal > 0 && dx.status !== 'ok') {
    // Legacy hint preserved for existing customers — only shows if no
    // structured fix-list is available.
    console.log(''); // slop-ok
    if (!hasManifest) {
      logger.dim(
        '💡 Run `vyuh-dxkit init` to enable Agent DX features (skills, agents, slash commands). Reports CLI works without it.',
      );
    } else {
      logger.dim(
        '💡 Run `vyuh-dxkit update` to refresh missing Agent DX files (the manifest already exists).',
      );
    }
  }

  console.log(''); // slop-ok
}

// ────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────

export async function runDoctor(cwd: string, opts: { json?: boolean } = {}): Promise<DoctorReport> {
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  const hasManifest = fs.existsSync(manifestPath);
  let manifest: Manifest | null = null;
  if (hasManifest) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = null;
    }
  }

  const checks: CheckResult[] = [
    ...runReportsChecks(),
    ...runDxChecks(cwd, manifest, hasManifest),
    ...runOperationalChecks(cwd, hasManifest),
  ];

  const report = buildReport(cwd, checks);

  if (opts.json) {
    // Logger is already in stderr mode (setJsonMode was called by cli.ts);
    // stdout stays pure JSON for downstream consumption.
    console.log(JSON.stringify(report, null, 2)); // slop-ok
  } else {
    renderProse(report, hasManifest);
  }

  if (report.summary.reports.status === 'fail') {
    process.exitCode = 1;
  }

  return report;
}
