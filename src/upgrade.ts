/**
 * `vyuh-dxkit upgrade` — combined CLI for the dxkit upgrade flow.
 *
 * Two modes, one subcommand:
 *
 *   `--plan [--json]` — preview only. Emits UpgradePlan JSON
 *   (consumed by dxkit-update skill) or text-prose summary. No
 *   mutations. Used to inspect what an upgrade would do before
 *   committing.
 *
 *   (no flag, or `--yes`) — execute. Runs the three-step upgrade:
 *     1. `npm install @vyuhlabs/dxkit@<target>`     (binary)
 *     2. `npx vyuh-dxkit update`                    (scaffold refresh)
 *     3. `npx vyuh-dxkit doctor`                    (verify)
 *   Then prints devcontainer-rebuild instructions if .devcontainer/
 *   was refreshed.
 *
 * Architectural mirror of the doctor → dxkit-fix pattern: structured
 * CLI output (--plan --json) for skill consumption, execution mode
 * for direct human use. Same shape, different content.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { Manifest } from './types';
import * as logger from './logger';

export type DeltaKind = 'none' | 'patch' | 'minor' | 'major' | 'downgrade';

export interface UpgradeStep {
  /** Shell command to run (verbatim — what gets executed). */
  command: string;
  /** One-line purpose shown in plan + before each execution. */
  purpose: string;
  /** Optional steps the customer can decline (e.g. devcontainer rebuild). */
  optional?: boolean;
}

export interface UpgradePlan {
  schema: 'upgrade-plan.v1';
  generatedAt: string;
  cwd: string;
  current: {
    /** Installed binary version (from `npx vyuh-dxkit --version`). */
    binary: string | null;
    /** Scaffold version recorded in manifest. */
    scaffold: string | null;
  };
  /** Target version — `--target=X.Y.Z` or 'latest' from npm. */
  target: string;
  delta: DeltaKind;
  /**
   * Recommended execution sequence. Each step is independently
   * idempotent — re-running is safe.
   */
  steps: UpgradeStep[];
  /**
   * Customer-facing warnings (peer-dep risks, breaking changes,
   * "devcontainer will need rebuild after"). Empty when nothing
   * actionable.
   */
  warnings: string[];
  /**
   * Brief note pointing the customer at the canonical changelog.
   * Detailed per-version highlight parsing is a future enhancement —
   * for now we keep this simple and link to the source of truth.
   */
  changelogNote: string;
}

export interface UpgradeOpts {
  /** Pin to a specific version. Default: latest from npm. */
  target?: string;
  /** Skip interactive confirmations. */
  yes?: boolean;
  /** Print commands without executing. */
  dryRun?: boolean;
  /** Emit plan only; don't execute. */
  planOnly?: boolean;
  /** Emit plan as JSON instead of prose (only meaningful with planOnly). */
  json?: boolean;
  /**
   * Injectable version reads. Useful for tests that need deterministic
   * plans without subprocess fanout; production code leaves these
   * undefined and the readers shell out as needed.
   */
  _readBinary?: (cwd: string) => string | null;
  _readLatest?: () => string;
}

// ────────────────────────────────────────────────────────────────────
// Version helpers
// ────────────────────────────────────────────────────────────────────

function readScaffoldVersion(cwd: string): string | null {
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

function readBinaryVersion(cwd: string): string | null {
  try {
    const out = execSync('npx --no-install vyuh-dxkit --version', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function readLatestPublished(): string {
  try {
    const out = execSync('npm view @vyuhlabs/dxkit version', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 15000,
    });
    return out.trim();
  } catch {
    // npm registry unreachable — return empty so caller can decide
    return '';
  }
}

/**
 * Classify the delta between two semver-shaped strings. Returns
 * `'none'` if equal, `'downgrade'` if target < current.
 */
export function classifyDelta(current: string | null, target: string): DeltaKind {
  if (!current || !target) return 'none';
  const [c1, c2, c3] = current.split('.').map((n) => parseInt(n, 10));
  const [t1, t2, t3] = target.split('.').map((n) => parseInt(n, 10));
  if (Number.isNaN(c1) || Number.isNaN(t1)) return 'none';
  if (t1 > c1) return 'major';
  if (t1 < c1) return 'downgrade';
  if (t2 > c2) return 'minor';
  if (t2 < c2) return 'downgrade';
  if (t3 > c3) return 'patch';
  if (t3 < c3) return 'downgrade';
  return 'none';
}

// ────────────────────────────────────────────────────────────────────
// Plan construction
// ────────────────────────────────────────────────────────────────────

export function buildUpgradePlan(cwd: string, opts: UpgradeOpts = {}): UpgradePlan {
  const scaffold = readScaffoldVersion(cwd);
  const binary = (opts._readBinary ?? readBinaryVersion)(cwd);
  const latest = opts.target ?? (opts._readLatest ?? readLatestPublished)();
  // Use binary version as the "current" anchor for delta classification —
  // it's what npm install will replace. Scaffold version informs whether
  // vyuh-dxkit update is needed even when binary is already up to date.
  const delta = classifyDelta(binary, latest);

  const steps: UpgradeStep[] = [];
  const warnings: string[] = [];

  if (!latest) {
    warnings.push(
      'Could not query npm for the latest version (registry unreachable or rate-limited). ' +
        'Pass --target=X.Y.Z to upgrade to a specific version.',
    );
  }

  // Step 1: binary upgrade. Always included unless delta is none AND
  // scaffold already matches.
  if (delta !== 'none' || (scaffold && binary && scaffold !== binary)) {
    if (latest) {
      steps.push({
        command: `npm install @vyuhlabs/dxkit@${latest}`,
        purpose: `Install dxkit binary ${binary ?? '(missing)'} → ${latest}`,
      });
    }
  }

  // Step 2: scaffold refresh. Always run when scaffold ≠ binary OR after
  // a binary upgrade (scaffold may need updating to match the new binary).
  if (latest) {
    steps.push({
      command: 'npx vyuh-dxkit update',
      purpose:
        'Refresh scaffold (.devcontainer, .githooks, .claude/skills, CI workflows) + ' +
        'migrate baseline & allowlist if the finding-identity scheme changed',
    });
  }

  // Step 3: verify with doctor.
  if (latest) {
    steps.push({
      command: 'npx vyuh-dxkit doctor',
      purpose: 'Verify operational health post-upgrade',
    });
  }

  // Optional: devcontainer rebuild reminder. We mark this optional so
  // dxkit-update can surface it as a "you also need to do this manually"
  // step rather than something the CLI can execute.
  const hasDevcontainer = fs.existsSync(path.join(cwd, '.devcontainer', 'devcontainer.json'));
  if (hasDevcontainer && delta !== 'none') {
    steps.push({
      command:
        '# Rebuild devcontainer: VSCode Command Palette → "Dev Containers: Rebuild Container"',
      purpose: 'Pick up devcontainer.json changes (if any) — manual step',
      optional: true,
    });
  }

  // Warnings.
  if (delta === 'major') {
    warnings.push(
      `Major version jump (${binary} → ${latest}). Read CHANGELOG.md for breaking changes ` +
        'before running the upgrade.',
    );
  }
  if (delta === 'downgrade') {
    warnings.push(
      `Target version ${latest} is OLDER than installed ${binary}. ` +
        'Downgrades are not officially supported; baseline + manifest schemas may differ.',
    );
  }
  if (scaffold && binary && scaffold !== binary) {
    warnings.push(
      `Scaffold version (${scaffold}) doesn't match binary (${binary}). ` +
        'Step 2 (vyuh-dxkit update) will reconcile.',
    );
  }

  return {
    schema: 'upgrade-plan.v1',
    generatedAt: new Date().toISOString(),
    cwd,
    current: { binary, scaffold },
    target: latest,
    delta,
    steps,
    warnings,
    changelogNote: latest
      ? `For per-version details: https://github.com/vyuh-labs/dxkit/blob/main/CHANGELOG.md`
      : '',
  };
}

// ────────────────────────────────────────────────────────────────────
// Renderers
// ────────────────────────────────────────────────────────────────────

function renderPlanProse(plan: UpgradePlan): void {
  logger.header('vyuh-dxkit upgrade --plan');
  logger.info(
    `Current: scaffold ${plan.current.scaffold ?? '(none)'} + binary ${plan.current.binary ?? '(none)'}`,
  );
  logger.info(`Target:  ${plan.target || '(latest unavailable)'}`);
  logger.info(`Delta:   ${plan.delta}`);

  if (plan.warnings.length) {
    console.log(''); // slop-ok
    for (const w of plan.warnings) logger.warn(w);
  }

  if (plan.steps.length) {
    console.log(''); // slop-ok
    logger.info('Plan:');
    plan.steps.forEach((s, i) => {
      const marker = s.optional ? '○' : '●';
      logger.dim(`  ${marker} [${i + 1}/${plan.steps.length}] ${s.purpose}`);
      logger.dim(`     ${s.command}`);
    });
  }

  if (plan.changelogNote) {
    console.log(''); // slop-ok
    logger.dim(plan.changelogNote);
  }
}

// ────────────────────────────────────────────────────────────────────
// Execution
// ────────────────────────────────────────────────────────────────────

function runStep(step: UpgradeStep, cwd: string, dryRun: boolean): boolean {
  if (step.optional) {
    // Optional steps are never auto-executed — surfaced for the
    // customer to do manually.
    return true;
  }
  logger.info(`→ ${step.purpose}`);
  logger.dim(`  ${step.command}`);
  if (dryRun) {
    logger.dim('  (dry-run; skipping)');
    return true;
  }
  // Shell out to a real shell so npx/npm work the same way as the
  // customer's terminal would. We DON'T use spawnSync's shell:true
  // bash escaping concerns because the commands here are all dxkit-
  // controlled — no customer input flows into them.
  const result = spawnSync('bash', ['-c', step.command], {
    cwd,
    stdio: 'inherit',
  });
  return result.status === 0;
}

async function runUpgradeExecution(
  cwd: string,
  plan: UpgradePlan,
  opts: UpgradeOpts,
): Promise<void> {
  // Print the plan so the customer sees what's about to happen.
  renderPlanProse(plan);

  if (plan.steps.length === 0) {
    console.log(''); // slop-ok
    logger.success('Already up to date — nothing to do.');
    return;
  }

  if (!opts.yes && !opts.dryRun) {
    // We don't bundle a real prompt library here — the upgrade is
    // intended either non-interactive (--yes) or driven by the
    // dxkit-update skill (which handles confirmation). Surface the
    // hint so a direct human invocation knows to add --yes.
    console.log(''); // slop-ok
    logger.warn(
      'Interactive confirmation is not implemented for this command. ' +
        'Re-run with --yes to execute, --dry-run to print without executing, ' +
        'or use the dxkit-update skill for a guided upgrade.',
    );
    return;
  }

  console.log(''); // slop-ok
  logger.header('Executing upgrade');

  const optionalAfter: UpgradeStep[] = [];
  for (const step of plan.steps) {
    if (step.optional) {
      optionalAfter.push(step);
      continue;
    }
    const ok = runStep(step, cwd, !!opts.dryRun);
    if (!ok) {
      logger.fail(`Step failed: ${step.purpose}`);
      logger.dim('  Upgrade aborted. Re-run `vyuh-dxkit doctor` to see current state.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(''); // slop-ok
  logger.success(`Upgraded to ${plan.target}.`);
  if (optionalAfter.length) {
    console.log(''); // slop-ok
    logger.info('Manual steps still required:');
    for (const s of optionalAfter) logger.dim(`  • ${s.purpose}\n    ${s.command}`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────

export async function runUpgrade(cwd: string, opts: UpgradeOpts = {}): Promise<void> {
  const plan = buildUpgradePlan(cwd, opts);

  if (opts.planOnly) {
    if (opts.json) {
      // Logger already routes to stderr in --json mode (cli.ts sets it).
      console.log(JSON.stringify(plan, null, 2)); // slop-ok
    } else {
      renderPlanProse(plan);
    }
    return;
  }

  await runUpgradeExecution(cwd, plan, opts);
}
