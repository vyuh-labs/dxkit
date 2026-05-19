import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, GenerationMode, Manifest } from './types';
import { buildVariables, buildConditions, VERSION } from './constants';
import { processTemplate } from './template-engine';
import { writeFile, copyFile, sha256 } from './files';
import { scanCodebase, renderCodebaseSkill, renderArchitectureRef } from './codebase-scanner';
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

function buildSettingsJson(config: ResolvedConfig, conditions: Record<string, boolean>): string {
  const perms: string[] = [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git branch:*)',
    'Bash(npx vyuh-dxkit:*)',
  ];

  // Per-language permissions — declared on each pack via
  // `LanguageSupport.permissions`, iterated here.
  for (const lang of activeLanguagesFromStack(config)) {
    if (lang.permissions) perms.push(...lang.permissions);
  }
  if (conditions.IF_DOCKER)
    perms.push('Bash(docker ps:*)', 'Bash(docker-compose ps:*)', 'Bash(docker-compose logs:*)');
  if (conditions.IF_GCLOUD)
    perms.push(
      'Bash(gcloud config:*)',
      'Bash(gcloud projects list:*)',
      'Bash(gcloud services list:*)',
      'Bash(gcloud run services list:*)',
    );
  if (conditions.IF_PULUMI)
    perms.push('Bash(pulumi preview:*)', 'Bash(pulumi stack:*)', 'Bash(pulumi config:*)');

  return (
    JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: {
          allow: perms,
          deny: [],
        },
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    'echo "If this conversation involved debugging, fixing issues, or discovering patterns — consider running /learn to capture it for future sessions."',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

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
  noScan = false,
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

  // Helper: process and write a template file
  async function writeTemplate(templatePath: string, outputRel: string, evolving = false) {
    const raw = readTemplate(templatePath);
    const processed = processTemplate(raw, variables, conditions);
    const outputPath = path.join(targetDir, outputRel);
    const res = await writeFile(outputPath, processed, opts(evolving));
    track(outputPath, processed, res, evolving);
  }

  // Helper: copy a static file
  function copyStatic(templatePath: string, outputRel: string, evolving = false) {
    const srcPath = path.join(templatesDir, templatePath);
    if (!fs.existsSync(srcPath)) return;
    const outputPath = path.join(targetDir, outputRel);
    const res = copyFile(srcPath, outputPath, opts(evolving));
    const content = evolving ? null : fs.readFileSync(srcPath, 'utf-8');
    track(outputPath, content, res, evolving);
  }

  // === DX-ONLY TIER ===

  logger.header('Generating Agent DX');

  // 1. CLAUDE.md
  await writeTemplate('CLAUDE.md.template', 'CLAUDE.md');
  logger.success('CLAUDE.md');

  // 2. settings.json
  const settingsContent = buildSettingsJson(config, conditions);
  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  const settingsRes = await writeFile(settingsPath, settingsContent, opts(false));
  track(settingsPath, settingsContent, settingsRes, false);
  logger.success('.claude/settings.json');

  // 3. Skills — template-processed
  for (const skill of ['quality', 'test', 'build', 'review', 'scaffold']) {
    await writeTemplate(
      `.claude/skills/${skill}/SKILL.md.template`,
      `.claude/skills/${skill}/SKILL.md`,
    );
  }

  // Skills — static (always)
  for (const skill of ['doctor', 'session', 'learned']) {
    copyStatic(`.claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`);
  }

  // Deploy skill (template + references)
  await writeTemplate('.claude/skills/deploy/SKILL.md.template', '.claude/skills/deploy/SKILL.md');
  copyStatic(
    '.claude/skills/deploy/references/gotchas.md',
    '.claude/skills/deploy/references/gotchas.md',
    true,
  );

  // Evolving reference files
  for (const skill of ['quality', 'test', 'learned']) {
    const refDir = `.claude/skills/${skill}/references`;
    const srcRefDir = path.join(templatesDir, refDir);
    if (fs.existsSync(srcRefDir)) {
      for (const file of fs.readdirSync(srcRefDir)) {
        copyStatic(`${refDir}/${file}`, `${refDir}/${file}`, true);
      }
    }
  }

  // Conditional skills
  if (conditions.IF_INFISICAL) {
    copyStatic('.claude/skills/secrets/SKILL.md', '.claude/skills/secrets/SKILL.md');
  }
  if (conditions.IF_GCLOUD) {
    copyStatic('.claude/skills/gcloud/SKILL.md', '.claude/skills/gcloud/SKILL.md');
    copyStatic(
      '.claude/skills/gcloud/references/gotchas.md',
      '.claude/skills/gcloud/references/gotchas.md',
      true,
    );
  }
  if (conditions.IF_PULUMI) {
    copyStatic('.claude/skills/pulumi/SKILL.md', '.claude/skills/pulumi/SKILL.md');
  }
  logger.success('.claude/skills/');

  // 4. Rules (conditional on language)
  // Per-language rule files declared via `LanguageSupport.ruleFile`.
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

  // 5. Commands (static .md copied as-is, .md.template processed through engine)
  const commandsDir = path.join(templatesDir, '.claude', 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const file of fs.readdirSync(commandsDir)) {
      if (file.endsWith('.md.template')) {
        const outputName = file.replace('.template', '');
        await writeTemplate(`.claude/commands/${file}`, `.claude/commands/${outputName}`);
      } else {
        copyStatic(`.claude/commands/${file}`, `.claude/commands/${file}`);
      }
    }
  }
  logger.success('.claude/commands/');

  // Ensure .ai/sessions/ exists for session commands (works in dx-only mode)
  fs.mkdirSync(path.join(targetDir, '.ai', 'sessions'), { recursive: true });

  // 6. Agents-available (dormant) and agents (active by default)
  const agentsAvailDir = path.join(templatesDir, '.claude', 'agents-available');
  if (fs.existsSync(agentsAvailDir)) {
    fs.mkdirSync(path.join(targetDir, '.claude', 'agents'), { recursive: true });
    for (const file of fs.readdirSync(agentsAvailDir)) {
      copyStatic(`.claude/agents-available/${file}`, `.claude/agents-available/${file}`);
    }
  }
  const activeAgentsDir = path.join(templatesDir, '.claude', 'agents');
  if (fs.existsSync(activeAgentsDir)) {
    fs.mkdirSync(path.join(targetDir, '.claude', 'agents'), { recursive: true });
    for (const file of fs.readdirSync(activeAgentsDir)) {
      copyStatic(`.claude/agents/${file}`, `.claude/agents/${file}`);
    }
  }
  logger.success('.claude/agents/');

  // 7. Codebase scan
  if (!noScan) {
    logger.info('Scanning codebase...');
    const analysis = scanCodebase(targetDir);
    const skillContent = renderCodebaseSkill(analysis);
    const skillPath = path.join(targetDir, '.claude', 'skills', 'codebase', 'SKILL.md');
    const skillRes = await writeFile(skillPath, skillContent, opts(true));
    track(skillPath, null, skillRes, true);

    const refContent = renderArchitectureRef(analysis);
    const refPath = path.join(
      targetDir,
      '.claude',
      'skills',
      'codebase',
      'references',
      'architecture.md',
    );
    const refRes = await writeFile(refPath, refContent, opts(true));
    track(refPath, null, refRes, true);

    logger.success(
      `.claude/skills/codebase/ (${analysis.fileCount} files, ${analysis.entryPoints.length} entry points, ${analysis.apiEndpoints.length} API routes)`,
    );
    if (analysis.testFileCount < 5 && analysis.sourceFileCount > 20) {
      logger.warn(
        `Minimal tests: ${analysis.testFileCount} test files for ${analysis.sourceFileCount} source files`,
      );
    }
  }

  // Write manifest
  const manifestContent = JSON.stringify(result.manifest, null, 2) + '\n';
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, '.vyuh-dxkit.json'), manifestContent, 'utf-8');

  return result;
}
