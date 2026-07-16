import * as fs from 'fs';
import * as path from 'path';
import { Manifest, ManifestInstallFlags } from './types';
import { detect } from './detect';
import { generate } from './generator';
import { ShipInstallResult } from './ship-installers';
import { detectInstallFlags, refreshManagedSurfaces } from './managed-artifacts';
import * as logger from './logger';
import { detectStaleRecall, detectStaleScheme, migrateIdentity } from './baseline/migrate';
import { createBaseline, gatherScanCoverage } from './baseline/create';
import { missingScanners } from './baseline/coverage';
import { dxkitCli } from './self-invocation';

/**
 * Re-exports the shared type so callers within the update module can
 * import either name. The canonical declaration lives in `./types` so
 * the manifest schema is one place.
 */
export type InstallFlags = ManifestInstallFlags;

/**
 * Workspace-derived flag detection (the fallback for legacy manifests without
 * `installFlags`) lives in the managed-artifact registry now, so init, update,
 * and uninstall infer the same flags from the same surface list. Re-exported
 * here for callers that import it from `./update`.
 */
export { detectInstallFlags };

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
    logger.fail(`.vyuh-dxkit.json not found. Run \`${dxkitCli('init')}\` first.`);
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

  // ─── Optional ship surfaces (devcontainer / hooks / CI / loop / ignore) ──
  // Re-run every registered ship surface the customer installed so template
  // changes land (per-stack devcontainer extensions, a refreshed workflow, the
  // self-healed devDependency, loop-norm prose, grown ignore entries). The set
  // of surfaces, their order, their install opts, and whether each refreshes on
  // update all live in ONE place — the managed-artifact registry — so update
  // can't silently skip a surface the way the deep-SAST refresh once was. Each
  // installer is idempotent and emits sidecars on conflict unless --force.
  refreshManagedSurfaces(cwd, { force, flags }, (r) => mergeShipResult(aggregate, r));

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
      force
        ? `Skipped: ${aggregate.skipped.length} file(s) (preserved — these are yours; --force re-applies dxkit-owned templates but never overwrites user-authored files)`
        : `Skipped: ${aggregate.skipped.length} file(s) (preserved — pass --force to re-apply dxkit-owned templates you've edited)`,
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

  // Recall-attribution refresh (CLAUDE.md Rule 19). Runs AFTER the identity
  // migration on purpose: that path already re-baselines, which stamps recall
  // as a side effect, so this is a no-op when both were stale.
  await refreshRecallIfStale(cwd);

  console.log(''); // slop-ok
  logger.success('Update complete. dxkit-owned files refreshed; your files preserved.');
}

/**
 * Bring a repo's baseline onto the current recall contract (Rule 19), or say
 * plainly why it could not be done here.
 *
 * Unlike an identity-scheme bump, a recall bump cannot be migrated offline:
 * nothing stored can tell you what a scanner you never ran would have found,
 * so the only honest refresh is a rescan.
 *
 * And a rescan is only honest if this machine can see as much as the baseline's
 * did. Re-baselining where gitleaks is not installed would write a baseline
 * with no secrets in it, and every real pre-existing secret would then read as
 * NET-NEW on the next CI check that does have gitleaks — turning a "your gate
 * is degraded" warning into a wave of false blocks. So a missing scanner means
 * we refuse to rescan and hand the user the remedy instead. The gate keeps
 * working meanwhile: the affected kinds warn instead of blocking, and every
 * renderer says which kinds and why.
 */
async function refreshRecallIfStale(cwd: string): Promise<void> {
  let stale;
  try {
    stale = detectStaleRecall(cwd);
  } catch {
    return; // probe failed (unreadable artifacts) — nothing to do here
  }
  if (!stale) return;

  const why =
    stale === 'absent'
      ? 'This baseline predates recall attribution'
      : 'dxkit changed what it can observe for a finding kind in this baseline';

  const missing = missingScanners(gatherScanCoverage(cwd));
  if (missing.length > 0) {
    logger.warn(`${why}, so its findings cannot be attributed to a diff until it is re-captured.`);
    logger.dim(
      `  Not re-baselining here: ${missing.map((s) => s.tool).join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} missing on this machine, and a scan without ` +
        `${missing.length === 1 ? 'it' : 'them'} would drop findings the baseline should hold.`,
    );
    logger.dim(
      '  → Run `vyuh-dxkit tools install`, then `vyuh-dxkit baseline create --force` ' +
        '(or let CI refresh it). Until then the affected kinds warn instead of blocking.',
    );
    return;
  }

  logger.info(`${why} — re-capturing the baseline so its findings stay attributable…`);
  try {
    const result = await createBaseline({ cwd, force: true });
    if (result.path) {
      logger.success('Baseline re-captured on the current recall contract.');
      logger.dim('  → Commit .dxkit/baselines to finish the refresh.');
    }
  } catch (err) {
    logger.warn(
      `Could not re-capture the baseline: ${(err as Error)?.message ?? String(err)}. ` +
        'Run `vyuh-dxkit baseline create --force` when convenient; until then the ' +
        'affected kinds warn instead of blocking.',
    );
  }
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
        `Run \`${dxkitCli('baseline create --force')}\` and re-add fingerprint-based allowlist ` +
        `entries manually.`,
    );
  }
}
