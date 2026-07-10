import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { commandExists } from './analyzers/tools/runner';
import { Manifest } from './types';
import { activeLanguagesFromStack } from './languages';
import { dxkitCli } from './self-invocation';
import * as logger from './logger';
import { resolveBaselineMode } from './baseline/modes';
import { anchorBranchStatus } from './baseline/anchor';
import { loadPolicyFromCwd } from './baseline/policy';
import { detectEnforcement } from './enforcement';
import { detectInstalledRefreshTransport, detectDefaultBranch } from './ship-installers';
import { detectPackageManager, addDevCommand } from './package-manager';
import { loadAllowlist, auditAllowlist } from './allowlist/file';
import { diagnoseFlow, type FlowDiagnosis } from './analyzers/flow/diagnose';
import { gatherRecommendations, type CommandRecommendation } from './discovery/commands';

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
  /** The flow-contract diagnosis (unresolved calls + reasons, unconsumed
   *  routes, connection-resolution rung) — present only when the repo has a
   *  UI→API surface. This is the "diagnose" surface folded into doctor; there
   *  is no standalone `flow doctor`. Agent-legible so the dxkit-flow skill reads
   *  it directly from `doctor --json`. */
  flow?: FlowDiagnosis;
  /** Advisor mode: capabilities this repo would benefit from but isn't using,
   *  each grounded in a repo signal via the capability registry's
   *  `whenToRecommend` probes. Agent-legible so an agent can act on them. */
  recommendations?: CommandRecommendation[];
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
  // Cross-platform PATH resolution (honors %PATHEXT% on Windows). The
  // prior `which <cmd> 2>/dev/null` shell probe false-negatived every
  // command on Windows — cmd.exe has no `which`, so git/node/npm/dotnet
  // all read as "missing" even when installed.
  return commandExists(cmd);
}

function nodeMajorVersion(): number {
  const raw = process.versions.node;
  const m = raw.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Wrap `loadPolicyFromCwd` with a swallowing try/catch — doctor
 * checks must never throw on a malformed policy file (the customer
 * would be unable to run doctor to discover that very fact). The
 * "policy unreadable" condition surfaces separately via the
 * existing scanner-toolchain / hooks checks.
 */
function safeLoadPolicy(cwd: string): ReturnType<typeof loadPolicyFromCwd> | null {
  try {
    return loadPolicyFromCwd(cwd);
  } catch {
    return null;
  }
}

/**
 * Wrap `loadAllowlist` with a swallowing try/catch — a malformed
 * allowlist file must not break doctor. Returns null on absence or
 * parse failure; the expiry check simply doesn't emit in that case.
 */
function safeLoadAllowlist(cwd: string): ReturnType<typeof loadAllowlist> {
  try {
    return loadAllowlist(cwd);
  } catch {
    return null;
  }
}

/**
 * Detect mode/visibility misalignment when the customer has pinned
 * `committed-full` on a public repo. Returns null when the pin is
 * fine. Only fires when the pin came from policy or CLI — auto-
 * picked modes are always aligned by definition.
 */
function detectModeMisalignment(
  mode: ReturnType<typeof resolveBaselineMode>,
): { label: string; hint: string; command: string } | null {
  // We can't read visibility directly here without triggering a
  // duplicate `gh` probe. Instead we rely on the resolver's audit
  // trail: when the customer pins `committed-full` AND the
  // visibility-derived default would have been ref-based, that's
  // the misalignment we want to flag. The resolver doesn't tell us
  // what the auto-picker WOULD have chosen, so we re-probe here —
  // the second probe is cache-warm and free.
  if (mode.mode !== 'committed-full') return null;
  // Lazy import so non-baseline doctor runs don't pay the gh probe.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectRepoVisibility } = require('./baseline/visibility') as {
    detectRepoVisibility: (cwd: string) => 'public' | 'private' | 'internal' | 'unknown';
  };
  const visibility = detectRepoVisibility(process.cwd());
  if (visibility !== 'public') return null;
  return {
    label: 'baseline mode pinned committed-full on a public repo',
    hint: 'Public repos auto-pick ref-based for a reason: committed-full leaks file paths + package names + advisory IDs to anyone reading the repo. Switch to ref-based or committed-sanitized in .dxkit/policy.json.',
    command: 'edit .dxkit/policy.json: set baseline.mode to ref-based or committed-sanitized',
  };
}

/**
 * A long-lived non-default branch on the remote (`develop` / `dev` /
 * `release/*`) — evidence the repo runs a gitflow-style model where PRs
 * commonly target something other than the default branch. Returns the branch
 * name, or null when none is found (the common single-trunk case). Best-effort:
 * any git failure returns null. Used to decide whether the committed-baseline
 * anchoring note is relevant (#118) — a committed baseline is anchored to the
 * default branch, so on a gitflow repo a ref-based posture keeps every surface
 * agreeing on what a PR is diffed against.
 */
function detectGitflowBranch(cwd: string, defaultBranch: string): string | null {
  try {
    const out = execSync("git branch -r --format='%(refname:short)'", {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const remoteBranches = out
      .split('\n')
      .map((l) => l.trim().replace(/^origin\//, ''))
      .filter(Boolean);
    for (const b of remoteBranches) {
      if (b === defaultBranch || b === 'HEAD') continue;
      if (b === 'develop' || b === 'dev' || b.startsWith('release/')) return b;
    }
    return null;
  } catch {
    return null;
  }
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
 * Whether a hook file carries the executable bit. Git silently ignores
 * a non-executable hook, so this is a hard prerequisite for the hook to
 * fire. On Windows the bit isn't a meaningful filesystem attribute (git
 * tracks executability in the index), so we treat it as satisfied there
 * rather than false-flag every Windows checkout.
 */
function hookIsExecutable(hookFile: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    return (fs.statSync(hookFile).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Whether `@vyuhlabs/dxkit` is declared in the consumer's package.json
 * (either dependency bucket). The hooks + CI guardrail resolve a
 * project-local `./node_modules/.bin/vyuh-dxkit` first; without the dep
 * declared they silently fall back to a global (possibly stale) install
 * or fail on a fresh CI runner. Returns null when there's no
 * package.json (non-Node repo — the global/npx path is expected).
 */
function dxkitDeclaredAsDep(cwd: string): boolean | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.['@vyuhlabs/dxkit'] || pkg.devDependencies?.['@vyuhlabs/dxkit'],
    );
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
            hint: `Run \`${dxkitCli('init')}\` to scaffold the manifest + Agent DX surface.`,
            command: dxkitCli('init --full --yes'),
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
              command: dxkitCli('update --force'),
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
              hint: `Re-run \`${dxkitCli('init --with-dxkit-agents --yes')}\` to land the missing Agent DX files.`,
              command: dxkitCli('init --with-dxkit-agents --yes'),
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
    'dxkit-feature',
    'dxkit-docs',
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
            command: dxkitCli('update'),
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
              command: dxkitCli('update'),
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
              command: dxkitCli('update --force'),
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

  // 0. Anchor branch health (branch transport only). The `branch` transport
  // reads the committed baseline from a side branch (`dxkit-baselines`). If
  // that branch is deleted, the guardrail silently loses its baseline
  // (fail-open). Surface a deleted anchor as a warning with a repair path.
  // Only emitted when the transport IS branch AND the remote is reachable, so
  // an offline run or a non-branch repo never produces a false alarm (#101).
  const anchorStatus = anchorBranchStatus(cwd, safeLoadPolicy(cwd)?.baseline);
  if (anchorStatus.configured && anchorStatus.remoteReachable) {
    checks.push({
      label: `baseline anchor branch present (${anchorStatus.anchorRef})`,
      ok: anchorStatus.branchExists,
      tier: 'operational',
      ...(anchorStatus.branchExists
        ? {}
        : {
            fix: {
              hint:
                `The '${anchorStatus.anchorRef}' anchor branch is missing (deleted?). The ` +
                `branch-transport guardrail reads the committed baseline from it — without it ` +
                `the gate silently loses its baseline. Recapture (\`${dxkitCli('baseline create --force')}\`) ` +
                `then run \`${dxkitCli('baseline publish')}\` to recreate the branch (self-heal; ` +
                `the refresh workflow also does this on its next run). Then run ` +
                `\`${dxkitCli('protect --apply')}\` — it adds a deletion-protection ruleset for ` +
                `the anchor branches so this cannot recur.`,
              command: dxkitCli('baseline publish'),
            },
          }),
    });
  }

  // 1. Hooks active. Two independent conditions must BOTH hold for the
  // pre-push guardrail to actually fire: `core.hooksPath` set to
  // `.githooks` AND the hook file carrying the executable bit. Git
  // SILENTLY IGNORES a non-executable hook (advice hint only), so a
  // hook committed as mode 100644 — or checked out on a filesystem
  // that drops the bit — produces a hooksPath that's "set" but a
  // guardrail that never runs. Checking only hooksPath would report a
  // false green on exactly that broken state.
  const hooksPath = readHooksPath(cwd);
  const hookFile = path.join(cwd, '.githooks', 'pre-push');
  const hookFileExists = fs.existsSync(hookFile);
  if (hookFileExists) {
    const hooksPathSet = hooksPath === '.githooks';
    const executable = hookIsExecutable(hookFile);
    const active = hooksPathSet && executable;
    checks.push({
      label: 'git hooks active (core.hooksPath = .githooks)',
      ok: active,
      tier: 'operational',
      ...(active
        ? {}
        : {
            fix: {
              // Tailor the hint to which condition failed; both are
              // repaired by re-running activate (it sets hooksPath AND
              // restores the executable bit).
              hint: !hooksPathSet
                ? 'Activate the pre-push hook so dxkit guards regressions before push.'
                : 'The pre-push hook is wired but not executable, so git silently ignores it — no guardrail runs. Re-activate to restore the executable bit.',
              command: dxkitCli('hooks activate'),
              skill: 'dxkit-hooks',
            },
          }),
    });
  }

  // 1b. dxkit declared as a project dependency. The hooks + CI guardrail
  // resolve `./node_modules/.bin/vyuh-dxkit` before any global, so a repo
  // that wires those surfaces but doesn't declare the dep runs whatever
  // stale global is on PATH (or fails on a fresh CI runner). Only flag
  // when a guardrail surface is actually present — a bare Node repo with
  // no hook/CI has nothing to resolve.
  const guardrailSurfacePresent =
    hookFileExists || fs.existsSync(path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml'));
  const declared = dxkitDeclaredAsDep(cwd);
  if (guardrailSurfacePresent && declared === false) {
    checks.push({
      label: 'dxkit in package.json devDependencies',
      ok: false,
      tier: 'operational',
      fix: {
        hint: 'Declare dxkit as a project-local devDependency so the hooks + CI guardrail run a pinned version instead of a global (or missing) one.',
        command: addDevCommand(detectPackageManager(cwd), '@vyuhlabs/dxkit'),
        skill: 'dxkit-fix',
      },
    });
  } else if (guardrailSurfacePresent && declared === true) {
    checks.push({
      label: 'dxkit in package.json devDependencies',
      ok: true,
      tier: 'operational',
    });
  }

  // 2. Baseline captured. Without a baseline, `guardrail check`
  // fails-fast on every push. In `ref-based` mode the file is NOT
  // expected on disk — the prior side is recomputed from a git ref
  // — so the check passes when mode is ref-based AND the resolver
  // can identify the ref.
  if (hasManifest) {
    const policy = safeLoadPolicy(cwd);
    const mode = resolveBaselineMode({
      cwd,
      policyMode: policy?.baseline?.mode,
      policyRef: policy?.baseline?.ref,
    });
    if (mode.mode === 'ref-based') {
      checks.push({
        label: `baseline mode: ref-based (ref: ${mode.ref ?? 'origin/main'})`,
        ok: true,
        tier: 'operational',
      });
    } else {
      const baselinePath = path.join(cwd, '.dxkit', 'baselines', 'main.json');
      const exists = fs.existsSync(baselinePath);
      checks.push({
        label: `baseline captured (.dxkit/baselines/main.json, mode: ${mode.mode})`,
        ok: exists,
        tier: 'operational',
        ...(exists
          ? {}
          : {
              fix: {
                hint: "Capture today's state as the brownfield baseline. Existing findings get locked in; only net-new ones block thereafter.",
                command: dxkitCli('baseline create'),
                skill: 'dxkit-init',
              },
            }),
      });

      // 2a. Gitflow anchoring note. A committed baseline is anchored to the
      // default branch (its refresh runs only on push to it). The CI guardrail
      // auto-gates a PR into a NON-default base against its own base via
      // ref-based (#118), so correctness is covered — but on a gitflow repo
      // where most PRs target a long-lived branch, pinning ref-based keeps the
      // LOCAL guardrail (which reads the committed file) agreeing with CI.
      const gitflowBranch = detectGitflowBranch(cwd, detectDefaultBranch(cwd));
      if (gitflowBranch) {
        checks.push({
          label:
            `committed baseline is default-branch-anchored; PRs into '${gitflowBranch}' are ` +
            `auto-gated ref-based by CI — pin baseline.mode: ref-based to match the local guardrail`,
          ok: true,
          tier: 'operational',
        });
      }
    }

    // 2b. Baseline mode aligned with repo visibility. Warns when an
    // explicit `committed-full` pin is in use on a public repo (the
    // posture leaks file paths / package names / advisory IDs to
    // anyone with read access). The auto-picker would have chosen
    // ref-based; an explicit pin says the customer overrode that on
    // purpose, so this is informational not failure.
    if (mode.source === 'policy' || mode.source === 'cli') {
      const alignmentWarning = detectModeMisalignment(mode);
      if (alignmentWarning) {
        checks.push({
          label: alignmentWarning.label,
          ok: false,
          tier: 'operational',
          fix: {
            hint: alignmentWarning.hint,
            command: alignmentWarning.command,
          },
        });
      } else {
        checks.push({
          label: `baseline mode aligned with repo visibility`,
          ok: true,
          tier: 'operational',
        });
      }
    }
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
        command: dxkitCli('tools install --yes'),
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
              command: dxkitCli('init --with-ci --yes'),
              skill: 'dxkit-init',
            },
          }),
    });
  }

  // 6b. Enforcement PATH — not just the wiring. The guardrails workflow can be
  // present + green while REAL enforcement is zero: if the default branch takes
  // direct pushes, or nothing REQUIRES the dxkit-guardrails check, a PR (or a
  // commit) can land without the guardrail ever blocking. Only meaningful once
  // the workflow exists; stays silent when gh can't answer (probed === false),
  // so it never fails a check on "we couldn't tell".
  if (
    hasManifest &&
    fs.existsSync(path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml'))
  ) {
    const enf = detectEnforcement(cwd);
    if (!enf.probed) {
      // Print an explicit line so "couldn't verify" is never indistinguishable
      // from "verified enforced" (the silent-skip bug). Fail-open: an unknown
      // answer never fails the check — dxkit can't read protection when gh is
      // absent/unauthenticated or the token lacks repo read scope.
      checks.push({
        label: `guardrail enforcement on '${enf.branch}' — not verified (gh unavailable or lacks repo read access)`,
        ok: true,
        tier: 'operational',
      });
    } else {
      const enforced = enf.directPushBlocked && enf.guardrailRequired;
      // A repository ruleset (not classic protection) governs the branch: the
      // guardrail belongs IN the ruleset, so `dxkit protect` (which writes a
      // classic rule) is the wrong repair — point the user at the ruleset.
      const rulesetHint = enf.rulesetGoverned && enf.directPushBlocked && !enf.guardrailRequired;
      const hint = !enf.directPushBlocked
        ? `'${enf.branch}' takes direct pushes, so commits (and PRs) can land without the guardrail. Protect the branch and require the dxkit-guardrails check.`
        : rulesetHint
          ? `'${enf.branch}' is protected by a repository ruleset that does not require the dxkit-guardrails check, so a PR can merge with the guardrail red. Add 'dxkit-guardrails' to that ruleset's required status checks (Settings → Rules → Rulesets).`
          : `'${enf.branch}' is protected but does not require the dxkit-guardrails check, so a PR can merge with the guardrail red. Add it as a required status check.`;
      checks.push({
        label: enforced
          ? `guardrail enforced on '${enf.branch}' (protected + required check)`
          : `guardrail is BYPASSABLE on '${enf.branch}' — it runs but does not block merges`,
        ok: enforced,
        tier: 'operational',
        ...(enforced
          ? {}
          : {
              fix: {
                hint,
                // A ruleset repair is manual (dxkit won't write a conflicting
                // classic rule), so no auto-command in that case.
                ...(rulesetHint ? {} : { command: dxkitCli('protect') }),
                skill: 'dxkit-init',
              },
            }),
      });

      // 6b-2. Stale required-check NAME. The protection requires the legacy
      // `guardrail` context, but the current workflow emits `dxkit-guardrails`
      // (the job got an explicit name). GitHub will then block every PR on a
      // required check that never appears. Distinct from BYPASSABLE — here the
      // guardrail IS required, just under a name the workflow no longer produces.
      if (enf.guardrailContextLegacyOnly) {
        checks.push({
          label: `'${enf.branch}' protection requires the legacy 'guardrail' check — the workflow now emits 'dxkit-guardrails'`,
          ok: false,
          tier: 'operational',
          fix: {
            hint: `Your branch protection / ruleset requires a status check named 'guardrail', but dxkit's guardrails workflow now reports 'dxkit-guardrails'. Update the required status check to 'dxkit-guardrails' (Settings → Rules, or Branch protection) — otherwise PRs block on a check that never runs.`,
            skill: 'dxkit-init',
          },
        });
      }

      // 6c. Deadlocking refresh workflow: a legacy 'tree' baseline-refresh
      // direct-pushes the anchor to the protected branch. That push is rejected,
      // and its [skip ci] commit can never earn the required checks — so the
      // refresh fails on every merge and the anchor can never update. Fires only
      // when the branch is actually protected AND the installed variant is 'tree'.
      if (enf.directPushBlocked && detectInstalledRefreshTransport(cwd) === 'tree') {
        checks.push({
          label: `baseline-refresh workflow will DEADLOCK on protected '${enf.branch}' (direct-push variant)`,
          ok: false,
          tier: 'operational',
          fix: {
            hint: `The installed refresh workflow pushes the anchor straight to '${enf.branch}', which branch protection rejects — so it fails every run and the anchor can never update. Run update to migrate it to a protection-safe anchor transport (or delete it if you use ref-based mode).`,
            command: dxkitCli('update'),
            skill: 'dxkit-init',
          },
        });
      }
    }
  }

  // 7. Allowlist suppression hygiene. An expired entry no longer
  // suppresses — its finding re-blocks the guardrail — and an entry
  // nearing expiry needs a decision before it lapses. Surface both so
  // a reviewed-and-accepted finding doesn't silently turn back into a
  // blocker mid-sprint. Only emits when an allowlist actually exists.
  const allowlistFile = safeLoadAllowlist(cwd);
  if (allowlistFile && allowlistFile.entries.length > 0) {
    const audit = auditAllowlist(allowlistFile);
    if (audit.expired.length > 0) {
      checks.push({
        label: `allowlist suppressions (${audit.expired.length} expired — findings now re-block)`,
        ok: false,
        tier: 'operational',
        fix: {
          hint: 'Expired allowlist entries no longer suppress, so their findings block again. Prune the ones you no longer need, or re-add with a fresh expiry the ones still being worked.',
          command: dxkitCli('allowlist prune'),
          skill: 'dxkit-fix',
        },
      });
    } else if (audit.soonToExpire.length > 0) {
      const soonest = Math.min(...audit.soonToExpire.map((s) => s.daysRemaining));
      checks.push({
        label: `allowlist suppressions (${audit.soonToExpire.length} expiring soon, next in ${soonest}d)`,
        ok: false,
        tier: 'operational',
        fix: {
          hint: 'Allowlist entries are nearing expiry. Fix the underlying finding, extend the window, or let it lapse so the finding re-blocks.',
          command: dxkitCli('allowlist audit'),
          skill: 'dxkit-fix',
        },
      });
    } else {
      checks.push({
        label: 'allowlist suppressions current',
        ok: true,
        tier: 'operational',
      });
    }
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

  // Flow contract diagnosis (only when the repo has a UI→API surface).
  if (report.flow) renderFlowSection(report.flow);

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
    // (advisor recommendations render below, independent of the fix list)
    // Legacy hint preserved for existing customers — only shows if no
    // structured fix-list is available.
    console.log(''); // slop-ok
    if (!hasManifest) {
      logger.dim(
        `💡 Run \`${dxkitCli('init')}\` to enable Agent DX features (skills, agents, slash commands). Reports CLI works without it.`,
      );
    } else {
      logger.dim(
        `💡 Run \`${dxkitCli('update')}\` to refresh missing Agent DX files (the manifest already exists).`,
      );
    }
  }

  // Advisor mode — capabilities this repo would benefit from but isn't using.
  if (report.recommendations && report.recommendations.length > 0) {
    console.log(''); // slop-ok
    logger.info('Recommended for this repo:');
    for (const { recommendation } of report.recommendations) {
      logger.dim(`• ${recommendation.reason}`);
      logger.dim(`  → ${recommendation.command}`);
    }
  }

  console.log(''); // slop-ok
}

/** Render the flow-contract diagnosis section of `doctor`. A cap keeps the
 *  console readable; `--json` always carries the full lists for an agent. */
function renderFlowSection(flow: FlowDiagnosis): void {
  const CAP = 10;
  console.log(''); // slop-ok
  logger.info('Flow contract (UI→API integration):');
  logger.success(
    `${flow.topology} — ${flow.calls} call(s) → ${flow.routes} route(s), ${flow.resolved} resolved`,
  );
  logger.dim(`  ${flow.connection.note}`);

  if (flow.unresolved.length > 0) {
    logger.warn(`${flow.unresolved.length} unresolved call(s):`);
    for (const u of flow.unresolved.slice(0, CAP)) {
      logger.dim(
        `  • ${u.method} ${u.path ?? u.rawUrl} (${u.reason} → ${u.suggestion})  ${u.file}:${u.line}`,
      );
    }
    if (flow.unresolved.length > CAP) logger.dim(`  … and ${flow.unresolved.length - CAP} more`);
  }
  if (flow.servedUnconsumed.length > 0) {
    logger.warn(`${flow.servedUnconsumed.length} served route(s) no in-repo call consumes:`);
    for (const r of flow.servedUnconsumed.slice(0, CAP)) {
      logger.dim(`  • ${r.method} ${r.path}  ${r.file}:${r.line}`);
    }
    if (flow.servedUnconsumed.length > CAP) {
      logger.dim(`  … and ${flow.servedUnconsumed.length - CAP} more`);
    }
  }
  if (flow.unresolved.length === 0 && flow.servedUnconsumed.length === 0) {
    logger.success('  Every call resolves and every route has a consumer.');
  }

  // Freshness of the committed contract — stale-but-declared beats
  // stale-and-silent. `moved` is a per-participant tri-state (true/false/null
  // = unknown, e.g. offline), so the prose never overclaims.
  if (flow.contract) {
    const c = flow.contract;
    const age = c.generatedAt.slice(0, 10);
    if (c.stale) {
      const movedNames = c.participants.filter((p) => p.moved === true).map((p) => p.name);
      logger.warn(
        `Committed served.json (published ${age}) is BEHIND: ${movedNames.join(', ')} ` +
          `moved since publish. Re-run \`flow publish\` and commit the refresh.`,
      );
    } else {
      logger.dim(`  Committed served.json published ${age}.`);
    }
    for (const p of c.participants) {
      const at = p.sha ? ` @ ${p.sha.slice(0, 12)}` : '';
      const state =
        p.moved === true
          ? `tip moved → ${p.tip?.slice(0, 12)}`
          : p.moved === false
            ? 'current'
            : 'tip unknown (offline / no provenance)';
      logger.dim(`    • ${p.name}: ${p.routes} route(s), ${p.source}${at} — ${state}`);
    }
  }
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

  const base = buildReport(cwd, checks);
  // Fold the flow-contract diagnosis into the report (absent on non-flow repos).
  // Never fails doctor — diagnoseFlow is fail-open (returns null on any error).
  const flow = await diagnoseFlow(cwd);
  // Advisor mode: capabilities the repo would benefit from but isn't using,
  // grounded in repo signals via the registry's whenToRecommend probes.
  const recommendations = gatherRecommendations(cwd);
  const report: DoctorReport = {
    ...base,
    ...(flow ? { flow } : {}),
    ...(recommendations.length > 0 ? { recommendations } : {}),
  };

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
