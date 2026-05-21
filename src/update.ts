import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './types';
import { detect } from './detect';
import { generate } from './generator';
import {
  installCiBaselineRefresh,
  installCiGuardrails,
  installDevcontainer,
  installHooks,
  installHooksPostinstall,
  installIgnoreFiles,
  installPrReview,
  ShipInstallResult,
} from './ship-installers';
import * as logger from './logger';

/**
 * Snapshot of which optional install surfaces are currently present in
 * the customer's workspace. Drives `update` so we refresh exactly the
 * artifacts the customer installed at init time and DON'T regenerate
 * surfaces they intentionally skipped.
 *
 * Workspace-derived rather than manifest-stored, so legacy installs
 * predating any manifest-based persistence still upgrade correctly.
 * The cost of false-positive detection (e.g. a customer-authored
 * .githooks/ that doesn't follow dxkit's shape) is bounded because
 * the installers themselves are idempotent + content-aware via
 * sidecar emission when conflicts exist.
 */
export interface InstallFlags {
  withDxkitAgents: boolean;
  withHooks: boolean;
  withPrecommit: boolean;
  withDevcontainer: boolean;
  withCiGuardrails: boolean;
  withBaselineRefresh: boolean;
  withPrReview: boolean;
}

export function detectInstallFlags(cwd: string): InstallFlags {
  return {
    withDxkitAgents: fs.existsSync(path.join(cwd, '.claude', 'skills', 'dxkit-learn')),
    withHooks: fs.existsSync(path.join(cwd, '.githooks', 'pre-push')),
    withPrecommit: fs.existsSync(path.join(cwd, '.githooks', 'pre-commit')),
    withDevcontainer: fs.existsSync(path.join(cwd, '.devcontainer', 'devcontainer.json')),
    withCiGuardrails: fs.existsSync(path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml')),
    withBaselineRefresh: fs.existsSync(
      path.join(cwd, '.github', 'workflows', 'dxkit-baseline-refresh.yml'),
    ),
    withPrReview: fs.existsSync(path.join(cwd, '.github', 'workflows', 'pr-review.yml')),
  };
}

interface AggregateUpdateResult {
  created: string[];
  skipped: string[];
  overwritten: string[];
  notes: string[];
}

function mergeShipResult(agg: AggregateUpdateResult, result: ShipInstallResult): void {
  agg.created.push(...result.installed);
  agg.skipped.push(...result.skipped);
  // Sidecars are conflict-reference files written into a `.dxkit-reference/`
  // subdir when the customer already had a competing file at the target
  // path. Surface them as notes so the customer knows where to look for
  // the reference content without conflating them with regular installs.
  for (const sidecar of result.sidecars) {
    agg.notes.push(`Sidecar reference: ${sidecar} (your file at the canonical path was preserved)`);
  }
  if (result.notes) agg.notes.push(...result.notes);
}

export async function runUpdate(cwd: string, force: boolean, rescan = false): Promise<void> {
  logger.header('vyuh-dxkit update');

  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (!fs.existsSync(manifestPath)) {
    logger.fail('.vyuh-dxkit.json not found. Run `vyuh-dxkit init` first.');
    process.exit(1);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    logger.fail('Failed to parse .vyuh-dxkit.json');
    process.exit(1);
  }

  logger.info(`Previous init: ${manifest.generatedAt} (mode: ${manifest.mode})`);

  const flags = detectInstallFlags(cwd);
  const flagSummary = Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  if (flagSummary) {
    logger.info(`Detected install surfaces: ${flagSummary}`);
  }

  logger.info('Re-detecting stack...');
  const detected = detect(cwd);

  const config = {
    ...detected,
    coverageThreshold: manifest.config.coverageThreshold,
    claudeCode: manifest.config.claudeCode,
  };

  // Merge languages: keep enabled if previously enabled OR newly detected.
  // Preserves customer-pinned active packs even if detection no longer
  // sees the source files (e.g. mid-refactor).
  for (const lang of Object.keys(config.languages) as (keyof typeof config.languages)[]) {
    config.languages[lang] = config.languages[lang] || manifest.config.languages[lang];
  }

  // --rescan: clear the codebase skill so it gets regenerated fresh.
  if (rescan) {
    const codebasePath = path.join(cwd, '.claude', 'skills', 'codebase');
    if (fs.existsSync(codebasePath)) {
      fs.rmSync(codebasePath, { recursive: true });
      logger.info('Cleared codebase skill for rescan');
    }
  }

  const aggregate: AggregateUpdateResult = {
    created: [],
    skipped: [],
    overwritten: [],
    notes: [],
  };

  // ─── Core generation (templates + per-language rules + dxkit skills) ────
  // Re-run the template-driven generator with the same withDxkitAgents
  // choice the customer's original init landed on. Pre-this-change the
  // update CLI always passed `withDxkitAgents=false` so the six dxkit-*
  // skills never got refreshed — a new dxkit-* skill prose change in a
  // later dxkit version couldn't reach customers who'd already initialized.
  const generated = await generate(cwd, config, manifest.mode, force, false, flags.withDxkitAgents);
  aggregate.created.push(...generated.created);
  aggregate.skipped.push(...generated.skipped);
  aggregate.overwritten.push(...generated.overwritten);

  // ─── Optional ship surfaces (devcontainer / hooks / CI / PR review) ─────
  // Each installer is idempotent and renders sidecars when the customer
  // has a conflicting file unless --force is passed. So re-running them
  // here picks up template changes (e.g. the per-stack devcontainer
  // extensions from 2.5.1 / Sprint 1.5) without clobbering customer edits.
  if (flags.withDevcontainer) {
    mergeShipResult(aggregate, installDevcontainer(cwd, { force }));
  }
  if (flags.withHooks) {
    mergeShipResult(aggregate, installHooks(cwd, { force, withPrecommit: flags.withPrecommit }));
    // The postinstall hook chain — reinstall in case the customer's
    // package.json grew its own postinstall after init landed.
    mergeShipResult(aggregate, installHooksPostinstall(cwd, { force }));
  }
  if (flags.withCiGuardrails) {
    mergeShipResult(aggregate, installCiGuardrails(cwd, { force }));
  }
  if (flags.withBaselineRefresh) {
    mergeShipResult(aggregate, installCiBaselineRefresh(cwd, { force }));
  }
  if (flags.withPrReview) {
    mergeShipResult(aggregate, installPrReview(cwd, { force }));
  }

  // Ignore files (.gitignore + .dxkit-ignore) — always refresh because
  // their content can grow with new dxkit features (e.g. graphify-out/
  // entry added in 2.5.1).
  mergeShipResult(aggregate, installIgnoreFiles(cwd, { force }));

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(''); // slop-ok
  logger.header('Update Summary');
  if (aggregate.created.length) {
    logger.success(`Created: ${aggregate.created.length} new file(s)`);
  }
  if (aggregate.overwritten.length) {
    logger.info(`Updated: ${aggregate.overwritten.length} file(s)`);
  }
  if (aggregate.skipped.length) {
    logger.warn(
      `Skipped: ${aggregate.skipped.length} file(s) (preserved — pass --force to overwrite)`,
    );
  }
  for (const note of aggregate.notes) logger.dim(note);

  console.log(''); // slop-ok
  logger.success('Update complete. Evolved files (gotchas, conventions) preserved.');
}
