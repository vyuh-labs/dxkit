import * as fs from 'fs';
import * as path from 'path';
import { Manifest, ManifestInstallFlags } from './types';
import { detect } from './detect';
import { generate } from './generator';
import {
  installCiBaselineRefresh,
  installCiGuardrails,
  installDevcontainer,
  installDxkitDevDependency,
  installHooks,
  installHooksPostinstall,
  installIgnoreFiles,
  installPrReview,
  ShipInstallResult,
} from './ship-installers';
import * as logger from './logger';
import { detectStaleScheme, migrateIdentity } from './baseline/migrate';
import { installClaudeLoop, isClaudeLoopInstalled } from './loop/scaffold';
import { requiresResolvableCli } from './self-invocation';

/**
 * Re-exports the shared type so callers within the update module can
 * import either name. The canonical declaration lives in `./types` so
 * the manifest schema is one place.
 */
export type InstallFlags = ManifestInstallFlags;

/**
 * Workspace-derived flag detection. Used in two cases:
 *   1. The manifest doesn't carry `installFlags` (pre-2.5.2 manifests
 *      written by dxkit 2.5.0 / 2.5.1).
 *   2. Defensive fallback if manifest is corrupt / partial.
 *
 * False-positive risk is bounded — the installers themselves are
 * idempotent and emit sidecars when they detect competing files, so
 * even spurious detection can't clobber customer state.
 */
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
    withClaudeLoop: isClaudeLoopInstalled(cwd),
  };
}

/**
 * Resolves the install flags for an update. Manifest-stored values
 * take precedence (canonical source of truth, set at init time);
 * workspace detection is the fallback for legacy manifests.
 *
 * Returns the flags plus a `source` field so the caller can decide
 * whether to self-migrate (write detected flags back to the manifest
 * so the NEXT update reads them from the canonical source).
 */
export function resolveInstallFlags(
  manifest: Manifest,
  cwd: string,
): { flags: InstallFlags; source: 'manifest' | 'workspace-derived' } {
  if (manifest.installFlags) {
    return { flags: manifest.installFlags, source: 'manifest' };
  }
  return { flags: detectInstallFlags(cwd), source: 'workspace-derived' };
}

/**
 * Patch `installFlags` into the on-disk manifest. Used by init (after
 * ship-installers complete to record what actually landed) AND by
 * update's self-migration path on legacy manifests.
 *
 * Idempotent: writing the same flags twice is a no-op. Defensive
 * against a manifest file being deleted mid-flight (returns false in
 * that case rather than throwing).
 */
export function writeInstallFlags(cwd: string, flags: InstallFlags): boolean {
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
    manifest.installFlags = flags;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
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

  const { flags, source } = resolveInstallFlags(manifest, cwd);
  const flagSummary = Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  if (flagSummary) {
    const sourceTag = source === 'manifest' ? 'manifest' : 'detected from workspace';
    logger.info(`Install surfaces (${sourceTag}): ${flagSummary}`);
  }

  // Self-migrate: if the manifest didn't carry installFlags (legacy
  // pre-2.5.2 manifest), stamp the detected flags back so the NEXT
  // update reads from the canonical source instead of re-detecting.
  if (source === 'workspace-derived') {
    if (writeInstallFlags(cwd, flags)) {
      logger.dim('  → Stamped install flags into manifest for future updates.');
    }
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
  // Self-heal a missing project-local devDependency on upgrade. Pre-fix
  // installs wired self-invocation surfaces without declaring the package, so
  // they fall back to a stale (or missing) global. The set of surfaces that
  // imply the dep is derived from the one registry in src/self-invocation.ts
  // (same source the init flow uses), so update can't drift from init. Adds
  // it when absent (idempotent — skips when already declared, so a customer's
  // pin is never repinned here; the version bump is `npm install`, npm's job).
  if (
    requiresResolvableCli({
      claudeSettings: flags.withDxkitAgents,
      claudeLoop: flags.withClaudeLoop,
      gitHooks: flags.withHooks,
      ciGuardrails: flags.withCiGuardrails,
    })
  ) {
    mergeShipResult(aggregate, installDxkitDevDependency(cwd, { force }));
  }
  if (flags.withBaselineRefresh) {
    mergeShipResult(aggregate, installCiBaselineRefresh(cwd, { force }));
  }
  if (flags.withPrReview) {
    mergeShipResult(aggregate, installPrReview(cwd, { force }));
  }
  // Loop pack: refresh the Stop hook + CLAUDE.md loop block on repos that
  // opted in. Additive + idempotent — re-running picks up loop-norm prose
  // changes without disturbing the user's other hooks. Preset is read from
  // the existing .dxkit/policy.json (preserved), so this never resets it.
  if (flags.withClaudeLoop) {
    mergeShipResult(aggregate, installClaudeLoop(cwd));
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

  // Identity-scheme migration: if this repo's committed baseline / allowlist
  // were written under an older finding-identity scheme (a dxkit version
  // bump changed it), carry them onto the current scheme automatically —
  // remap the allowlist's fingerprints (preserving reviewed suppressions)
  // and regenerate the baseline — so the guardrail keeps working without a
  // manual re-baseline. Fail-soft: a migration error is reported, not fatal
  // to the rest of the update.
  await migrateIdentityIfStale(cwd);

  console.log(''); // slop-ok
  logger.success('Update complete. Evolved files (gotchas, conventions) preserved.');
}

/**
 * Detect a stale finding-identity scheme on the repo's artifacts and, if
 * found, migrate them to the current scheme. Reports a summary; never
 * throws (a migration failure is surfaced as a warning so the rest of the
 * update still succeeds).
 */
async function migrateIdentityIfStale(cwd: string): Promise<void> {
  let from;
  try {
    from = detectStaleScheme(cwd);
  } catch {
    return; // probe failed (unreadable artifacts) — nothing to do here
  }
  if (!from) return;

  logger.info(`Finding-identity scheme changed since last init — migrating baseline + allowlist…`);
  try {
    const result = await migrateIdentity({ cwd, from });
    if (result.baselinePath) {
      logger.success(`Re-baselined onto identity scheme ${result.toScheme}.`);
    }
    if (result.allowlistTotal > 0) {
      logger.success(
        `Allowlist migrated: ${result.allowlistRemapped} re-anchored, ` +
          `${result.allowlistUnchanged} unchanged.`,
      );
    }
    if (result.allowlistUnmapped.length > 0) {
      logger.warn(
        `${result.allowlistUnmapped.length} allowlist entr${
          result.allowlistUnmapped.length === 1 ? 'y' : 'ies'
        } matched no current finding (the suppressed finding is gone) — review + prune:`,
      );
      for (const e of result.allowlistUnmapped) {
        logger.dim(`  ${e.fingerprint}  ${e.kind}/${e.category}`);
      }
    }
    logger.dim('  → Commit .dxkit/baselines + .dxkit/allowlist.json to finish the migration.');
  } catch (err) {
    logger.warn(
      `Identity migration could not complete: ${(err as Error).message}. ` +
        `Run \`vyuh-dxkit baseline create --force\` and re-add fingerprint-based allowlist ` +
        `entries manually.`,
    );
  }
}
