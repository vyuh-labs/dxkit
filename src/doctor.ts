import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Manifest } from './types';
import { activeLanguagesFromStack } from './languages';
import * as logger from './logger';

/**
 * Two-tier doctor (F-UX-1, closes the 2026-05-07 "Fail: 10" credibility
 * issue from the real-user UX session).
 *
 * Tier 1 — Reports prerequisites: the small set of things that must
 * be present for ANY dxkit CLI command to work. Node 18+ and git.
 * Failure here = dxkit can't function = exit 1.
 *
 * Tier 2 — Agent DX prerequisites: the `.vyuh-dxkit.json`
 * manifest + the `.claude/*` scaffolding that `vyuh-dxkit init`
 * generates. These only matter if you want Agent DX features.
 * Failure here = informational warn + a hint to run `init`; exit
 * code is unaffected.
 *
 * Pre-F-UX-1, both tiers were lumped together. A fresh repo without
 * `.claude/` reported "Fail: 10" — making users think dxkit was
 * broken when actually the reports CLI worked fine. The new framing
 * keeps the diagnostic value of the DX checks while making clear
 * what's required vs. nice-to-have.
 */

interface DoctorResult {
  /** Reports-tier checks (mandatory). */
  reports: { pass: number; fail: number };
  /** Agent DX-tier checks (informational). */
  dx: { pass: number; fail: number };
}

function check(label: string, condition: boolean): boolean {
  if (condition) {
    logger.success(label);
  } else {
    logger.fail(label);
  }
  return condition;
}

/** Informational variant of `check` — failures render as warn, not fail. */
function checkInfo(label: string, condition: boolean): boolean {
  if (condition) {
    logger.success(label);
  } else {
    logger.warn(label);
  }
  return condition;
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

export async function runDoctor(cwd: string): Promise<void> {
  logger.header('vyuh-dxkit doctor');

  const result: DoctorResult = {
    reports: { pass: 0, fail: 0 },
    dx: { pass: 0, fail: 0 },
  };
  function trackReports(ok: boolean) {
    if (ok) result.reports.pass++;
    else result.reports.fail++;
  }
  function trackDx(ok: boolean) {
    if (ok) result.dx.pass++;
    else result.dx.fail++;
  }

  // ─── Tier 1: Reports prerequisites (mandatory) ─────────────────────────
  logger.info('Reports prerequisites (required to run any dxkit command):');
  const nodeMajor = nodeMajorVersion();
  trackReports(check(`Node ≥ 18 (running ${process.versions.node})`, nodeMajor >= 18));
  trackReports(check('git', commandAvailable('git')));

  // ─── Tier 2: Agent DX prerequisites (informational) ──────────────
  console.log(''); // slop-ok
  logger.info('Agent DX prerequisites (only required for `init`-generated artifacts):');

  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  const hasManifest = fs.existsSync(manifestPath);
  trackDx(checkInfo('.vyuh-dxkit.json exists', hasManifest));

  let manifest: Manifest | null = null;
  if (hasManifest) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      trackDx(checkInfo('.vyuh-dxkit.json is valid JSON', true));
    } catch {
      trackDx(checkInfo('.vyuh-dxkit.json is valid JSON', false));
    }
  }

  // Agent context — present when `init` was run with --with-dxkit-agents
  // (default-on under --full). Absent on bare `init` runs by design, so
  // these are informational rather than required.
  trackDx(checkInfo('AGENTS.md', fs.existsSync(path.join(cwd, 'AGENTS.md'))));
  trackDx(checkInfo('CLAUDE.md', fs.existsSync(path.join(cwd, 'CLAUDE.md'))));
  trackDx(
    checkInfo('.claude/settings.json', fs.existsSync(path.join(cwd, '.claude', 'settings.json'))),
  );

  // The six dxkit-* skills are the marquee 2.5.1 agent surface. Each
  // landing as its own dir under .claude/skills/dxkit-<name>/ — count
  // present-vs-expected so customers see at a glance whether the
  // agent scaffold landed.
  const DXKIT_SKILL_NAMES = [
    'dxkit-learn',
    'dxkit-init',
    'dxkit-config',
    'dxkit-hooks',
    'dxkit-reports',
    'dxkit-action',
  ];
  const presentSkills = DXKIT_SKILL_NAMES.filter((name) =>
    fs.existsSync(path.join(cwd, '.claude', 'skills', name, 'SKILL.md')),
  );
  trackDx(
    checkInfo(
      `.claude/skills/dxkit-* (${presentSkills.length}/${DXKIT_SKILL_NAMES.length})`,
      presentSkills.length === DXKIT_SKILL_NAMES.length,
    ),
  );

  // .claude/rules/ is created only when an active language pack declares
  // a ruleFile. Pure-typescript projects skip this dir (typescript pack
  // has no ruleFile) — don't flag its absence as a scaffolding gap.
  const expectsRules =
    manifest?.config?.languages &&
    activeLanguagesFromStack(manifest.config).some((l) => l.ruleFile);
  if (expectsRules) {
    trackDx(checkInfo('.claude/rules/', fs.existsSync(path.join(cwd, '.claude', 'rules'))));
  }

  // Settings.json validity (only when the file exists; absence already
  // counted above).
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      trackDx(checkInfo('settings.json is valid JSON', true));
    } catch {
      trackDx(checkInfo('settings.json is valid JSON', false));
    }
  }

  // Toolchain CLIs — pack-driven via `LanguageSupport.cliBinaries`.
  // These are informational (a missing toolchain just disables that
  // language's analyzers — the rest of dxkit keeps working).
  if (manifest?.config?.languages) {
    console.log(''); // slop-ok
    logger.info('Agent DX — toolchains:');
    for (const lang of activeLanguagesFromStack(manifest.config)) {
      for (const bin of lang.cliBinaries ?? []) {
        trackDx(checkInfo(bin, commandAvailable(bin)));
      }
    }
    if (manifest.config.tools?.gcloud) {
      trackDx(checkInfo('gcloud', commandAvailable('gcloud')));
    }
    if (manifest.config.tools?.infisical) {
      trackDx(checkInfo('infisical', commandAvailable('infisical')));
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(''); // slop-ok
  logger.header('Results');
  if (result.reports.fail === 0) {
    logger.success(
      `Reports: ${result.reports.pass}/${result.reports.pass + result.reports.fail} — ready to run dxkit`,
    );
  } else {
    logger.fail(
      `Reports: ${result.reports.pass}/${result.reports.pass + result.reports.fail} — fix the failures above before running other dxkit commands`,
    );
  }

  const dxTotal = result.dx.pass + result.dx.fail;
  if (dxTotal > 0) {
    if (result.dx.fail === 0) {
      logger.success(`Agent DX: ${result.dx.pass}/${dxTotal} — fully scaffolded`);
    } else {
      logger.warn(`Agent DX: ${result.dx.pass}/${dxTotal} — partial scaffolding`);
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
  }

  console.log(''); // slop-ok

  // Exit non-zero only when the reports tier failed — DX-tier failures
  // are informational and shouldn't break CI scripts that gate on
  // `dxkit doctor`.
  if (result.reports.fail > 0) {
    process.exitCode = 1;
  }
}
