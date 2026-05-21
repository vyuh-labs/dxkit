import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, GenerationMode, Manifest } from './types';
import { buildVariables, buildConditions, VERSION } from './constants';
import { processTemplate } from './template-engine';
import { writeFile, copyFile, sha256 } from './files';
import { activeLanguagesFromStack } from './languages';
import * as logger from './logger';

function getTemplatesDir(): string {
  return path.join(__dirname, '..', 'templates');
}

function readTemplate(templatePath: string): string {
  const fullPath = path.join(getTemplatesDir(), templatePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * Narrowed permission list for the dxkit-specific agent surface.
 * Carries only the binaries the six dxkit-* skills actually run:
 * git status/diff/log/branch (read-only inspection), the dxkit binary
 * itself (every analyzer / hook / baseline command), and the active
 * language packs' contributed commands (so the dxkit-action skill
 * can run `npm test` / `pytest` / etc. to verify a fix without
 * prompting on every step).
 *
 * Pre-2.5.1 the file carried Stop-hook noise about a `/learn` slash
 * command that no longer ships, plus conditional gcloud / pulumi /
 * docker entries tied to generic skills that also no longer ship.
 * Dropped here.
 */
function buildSettingsJson(config: ResolvedConfig): string {
  const perms: string[] = [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git branch:*)',
    'Bash(npx vyuh-dxkit:*)',
    'Bash(./node_modules/.bin/vyuh-dxkit:*)',
    'Bash(vyuh-dxkit:*)',
  ];
  for (const lang of activeLanguagesFromStack(config)) {
    if (lang.permissions) perms.push(...lang.permissions);
  }

  return (
    JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: {
          allow: perms,
          deny: [],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * The six dxkit-specific skills shipped under `--with-dxkit-agents`.
 * Each lives at `.claude/skills/<name>/SKILL.md` in the template dir;
 * generator copies them verbatim (no template substitution — the
 * skill content references the canonical `vyuh-dxkit` CLI surface
 * and doesn't need per-project variables).
 */
const DXKIT_SKILLS = [
  'dxkit-learn',
  'dxkit-init',
  'dxkit-config',
  'dxkit-hooks',
  'dxkit-reports',
  'dxkit-action',
  // dxkit-fix (2.5.2): reactive repair surface. Consumes
  // `vyuh-dxkit doctor --json` output and walks the customer through
  // each fixable check. Lands after the doctor pivot adds structured
  // output + fix metadata in 2.5.2.
  'dxkit-fix',
  // dxkit-update (2.5.2): existing-install upgrade orchestrator.
  // Consumes `vyuh-dxkit upgrade --plan --json` output and drives
  // conversational upgrade with version-delta analysis, warnings,
  // and per-step confirmation.
  'dxkit-update',
] as const;

interface GenerateResult {
  created: string[];
  skipped: string[];
  overwritten: string[];
  manifest: Manifest;
}

export async function generate(
  targetDir: string,
  config: ResolvedConfig,
  mode: GenerationMode,
  force: boolean,
  _noScan = false,
  withDxkitAgents = false,
): Promise<GenerateResult> {
  const variables = buildVariables(config);
  const conditions = buildConditions(config);
  const templatesDir = getTemplatesDir();

  const result: GenerateResult = {
    created: [],
    skipped: [],
    overwritten: [],
    manifest: {
      version: VERSION,
      mode,
      generatedAt: new Date().toISOString(),
      config,
      files: {},
    },
  };

  const opts = (evolving: boolean) => ({ force, evolving, skipIfExists: !force });

  function track(
    outputPath: string,
    content: string | null,
    writeResult: string,
    evolving: boolean,
  ) {
    const rel = path.relative(targetDir, outputPath);
    if (writeResult === 'created') result.created.push(rel);
    else if (writeResult === 'skipped') result.skipped.push(rel);
    else if (writeResult === 'overwritten') result.overwritten.push(rel);

    result.manifest.files[rel] = {
      hash: evolving ? null : content ? sha256(content) : null,
      evolving,
    };
  }

  async function writeTemplate(templatePath: string, outputRel: string, evolving = false) {
    const raw = readTemplate(templatePath);
    const processed = processTemplate(raw, variables, conditions);
    const outputPath = path.join(targetDir, outputRel);
    const res = await writeFile(outputPath, processed, opts(evolving));
    track(outputPath, processed, res, evolving);
  }

  function copyStatic(templatePath: string, outputRel: string, evolving = false) {
    const srcPath = path.join(templatesDir, templatePath);
    if (!fs.existsSync(srcPath)) return;
    const outputPath = path.join(targetDir, outputRel);
    const res = copyFile(srcPath, outputPath, opts(evolving));
    const content = evolving ? null : fs.readFileSync(srcPath, 'utf-8');
    track(outputPath, content, res, evolving);
  }

  if (withDxkitAgents) {
    logger.header('Generating dxkit agent context');

    // Open-standard project prose — read by every coding agent
    // (Claude / Codex / Cursor / Aider). Pre-2.5.1 this content lived
    // in CLAUDE.md; AGENTS.md is the cross-platform replacement.
    await writeTemplate('AGENTS.md.template', 'AGENTS.md');
    logger.success('AGENTS.md');

    // CLAUDE.md becomes a small shim that points at AGENTS.md. Claude
    // Code reads both at session start; the shim carries Claude-
    // specific config (skill list, rules pointer) and defers shared
    // context to AGENTS.md.
    await writeTemplate('CLAUDE.md.template', 'CLAUDE.md');
    logger.success('CLAUDE.md');

    // Narrowed settings.json — drops the Stop-hook noise + conditional
    // gcloud/pulumi/docker entries that referenced generic skills that
    // no longer ship.
    const settingsContent = buildSettingsJson(config);
    const settingsPath = path.join(targetDir, '.claude', 'settings.json');
    const settingsRes = await writeFile(settingsPath, settingsContent, opts(false));
    track(settingsPath, settingsContent, settingsRes, false);
    logger.success('.claude/settings.json');

    // The six dxkit-specific skills. Each ships as a single SKILL.md
    // under `.claude/skills/dxkit-<name>/`. Auto-discovered by Claude
    // Code via skill frontmatter (`name` + `description`).
    for (const skill of DXKIT_SKILLS) {
      copyStatic(`.claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`);
    }
    logger.success('.claude/skills/dxkit-*');

    // Per-language rules from each active pack — still useful as
    // contextual hints to any agent (coding conventions, lint rule
    // exceptions, etc.).
    for (const lang of activeLanguagesFromStack(config)) {
      if (lang.ruleFile) {
        copyStatic(`.claude/rules/${lang.ruleFile}`, `.claude/rules/${lang.ruleFile}`);
      }
    }
    // Framework-specific rules — NOT pack-owned. Frameworks
    // (nextjs/loopback/express) live under the top-level `framework`
    // signal, not in `languages`. Stay hardcoded here until a
    // framework-pack abstraction exists.
    if (conditions.IF_NEXTJS) copyStatic('.claude/rules/nextjs.md', '.claude/rules/nextjs.md');
    if (config.framework === 'loopback')
      copyStatic('.claude/rules/loopback.md', '.claude/rules/loopback.md');
    if (config.framework === 'express')
      copyStatic('.claude/rules/express.md', '.claude/rules/express.md');
    logger.success('.claude/rules/');
  }

  // Always write the manifest — `vyuh-dxkit update` / `doctor` / etc.
  // read it to know what was configured even when no agent scaffold
  // is present.
  const manifestContent = JSON.stringify(result.manifest, null, 2) + '\n';
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, '.vyuh-dxkit.json'), manifestContent, 'utf-8');

  return result;
}
