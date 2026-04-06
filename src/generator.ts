import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, GenerationMode, Manifest, FileEntry } from './types';
import { buildVariables, buildConditions, EVOLVING_FILES, VERSION } from './constants';
import { processTemplate } from './template-engine';
import { writeFile, copyFile, sha256, makeExecutable, copyDirectory } from './files';
import { scanCodebase, renderCodebaseSkill, renderArchitectureRef } from './codebase-scanner';
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
    'Bash(make test:*)', 'Bash(make test-unit:*)', 'Bash(make test-coverage:*)',
    'Bash(make quality:*)', 'Bash(make quality-fix:*)', 'Bash(make lint:*)',
    'Bash(make format:*)', 'Bash(make check:*)', 'Bash(make fix:*)',
    'Bash(make doctor:*)', 'Bash(make info:*)', 'Bash(make validate:*)',
    'Bash(make generate:*)', 'Bash(make build:*)', 'Bash(make clean:*)',
    'Bash(make docs:*)', 'Bash(make sync:*)', 'Bash(make sync-preview:*)',
    'Bash(make lang-list:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git branch:*)',
  ];

  if (conditions.IF_PYTHON) perms.push('Bash(python3:*)', 'Bash(pytest:*)', 'Bash(ruff:*)');
  if (conditions.IF_GO) perms.push('Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)', 'Bash(golangci-lint:*)');
  if (conditions.IF_NODE || conditions.IF_NEXTJS) perms.push('Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx:*)');
  if (conditions.IF_RUST) perms.push('Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)');
  if (conditions.IF_CSHARP) perms.push('Bash(dotnet test:*)', 'Bash(dotnet build:*)', 'Bash(dotnet format:*)', 'Bash(dotnet run:*)');
  if (conditions.IF_INFISICAL) perms.push('Bash(make secrets-pull:*)', 'Bash(make secrets-show:*)');
  if (conditions.IF_DOCKER) perms.push('Bash(docker ps:*)', 'Bash(docker-compose ps:*)', 'Bash(docker-compose logs:*)');
  if (conditions.IF_GCLOUD) perms.push('Bash(gcloud config:*)', 'Bash(gcloud projects list:*)', 'Bash(gcloud services list:*)', 'Bash(gcloud run services list:*)');
  if (conditions.IF_PULUMI) perms.push('Bash(pulumi preview:*)', 'Bash(pulumi stack:*)', 'Bash(pulumi config:*)');

  return JSON.stringify({
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
              command: 'echo "If this conversation involved debugging, fixing issues, or discovering patterns — consider running /learn to capture it for future sessions."',
            },
          ],
        },
      ],
    },
  }, null, 2) + '\n';
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

  function track(outputPath: string, content: string | null, writeResult: string, evolving: boolean) {
    const rel = path.relative(targetDir, outputPath);
    if (writeResult === 'created') result.created.push(rel);
    else if (writeResult === 'skipped') result.skipped.push(rel);
    else if (writeResult === 'overwritten') result.overwritten.push(rel);

    result.manifest.files[rel] = {
      hash: evolving ? null : (content ? sha256(content) : null),
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

  logger.header('Generating Claude Code DX');

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
    await writeTemplate(`.claude/skills/${skill}/SKILL.md.template`, `.claude/skills/${skill}/SKILL.md`);
  }

  // Skills — static (always)
  for (const skill of ['doctor', 'session', 'learned']) {
    copyStatic(`.claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`);
  }

  // Deploy skill (template + references)
  await writeTemplate('.claude/skills/deploy/SKILL.md.template', '.claude/skills/deploy/SKILL.md');
  copyStatic('.claude/skills/deploy/references/gotchas.md', '.claude/skills/deploy/references/gotchas.md', true);

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
    copyStatic('.claude/skills/gcloud/references/gotchas.md', '.claude/skills/gcloud/references/gotchas.md', true);
  }
  if (conditions.IF_PULUMI) {
    copyStatic('.claude/skills/pulumi/SKILL.md', '.claude/skills/pulumi/SKILL.md');
  }
  logger.success('.claude/skills/');

  // 4. Rules (conditional on language)
  if (conditions.IF_PYTHON) copyStatic('.claude/rules/python.md', '.claude/rules/python.md');
  if (conditions.IF_GO) copyStatic('.claude/rules/go.md', '.claude/rules/go.md');
  if (conditions.IF_NEXTJS) copyStatic('.claude/rules/nextjs.md', '.claude/rules/nextjs.md');
  if (conditions.IF_RUST) copyStatic('.claude/rules/rust.md', '.claude/rules/rust.md');
  if (conditions.IF_CSHARP) copyStatic('.claude/rules/csharp.md', '.claude/rules/csharp.md');
  // Framework-specific rules
  if (config.framework === 'loopback') copyStatic('.claude/rules/loopback.md', '.claude/rules/loopback.md');
  if (config.framework === 'express') copyStatic('.claude/rules/express.md', '.claude/rules/express.md');
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

  // 6b. PR review workflow (dx-only mode — always copy if GitHub Actions dir doesn't conflict)
  const prReviewSrc = path.join(templatesDir, '.github', 'workflows', 'pr-review.yml');
  if (fs.existsSync(prReviewSrc)) {
    copyStatic('.github/workflows/pr-review.yml', '.github/workflows/pr-review.yml');
    logger.success('.github/workflows/pr-review.yml');
  }

  // 7. Codebase scan
  if (!noScan) {
    logger.info('Scanning codebase...');
    const analysis = scanCodebase(targetDir);
    const skillContent = renderCodebaseSkill(analysis);
    const skillPath = path.join(targetDir, '.claude', 'skills', 'codebase', 'SKILL.md');
    const skillRes = await writeFile(skillPath, skillContent, opts(true));
    track(skillPath, null, skillRes, true);

    const refContent = renderArchitectureRef(analysis);
    const refPath = path.join(targetDir, '.claude', 'skills', 'codebase', 'references', 'architecture.md');
    const refRes = await writeFile(refPath, refContent, opts(true));
    track(refPath, null, refRes, true);

    logger.success(`.claude/skills/codebase/ (${analysis.fileCount} files, ${analysis.entryPoints.length} entry points, ${analysis.apiEndpoints.length} API routes)`);
    if (analysis.testFileCount < 5 && analysis.sourceFileCount > 20) {
      logger.warn(`Minimal tests: ${analysis.testFileCount} test files for ${analysis.sourceFileCount} source files`);
    }
  }

  // === FULL TIER ===

  if (mode === 'full') {
    logger.header('Generating Quality & Infrastructure');

    // .project/ scripts
    const projectSrcDir = path.join(templatesDir, '.project');
    if (fs.existsSync(projectSrcDir)) {
      const count = copyDirectory(projectSrcDir, path.join(targetDir, '.project'), { force });
      // Make scripts executable
      const scriptsDir = path.join(targetDir, '.project', 'scripts');
      if (fs.existsSync(scriptsDir)) {
        for (const file of findFiles(scriptsDir, '.sh')) {
          makeExecutable(file);
        }
        for (const file of findFiles(scriptsDir, '.py')) {
          makeExecutable(file);
        }
      }
      logger.success(`.project/ (${count} files)`);
    }

    // Makefile
    copyStatic('Makefile', 'Makefile');
    logger.success('Makefile');

    // .ai/ directory
    const aiSrcDir = path.join(templatesDir, '.ai');
    if (fs.existsSync(aiSrcDir)) {
      copyDirectory(aiSrcDir, path.join(targetDir, '.ai'), { force });
      fs.mkdirSync(path.join(targetDir, '.ai', 'sessions'), { recursive: true });
      logger.success('.ai/');
    }

    // Language configs (only if not already present)
    if (conditions.IF_PYTHON) {
      await writeTemplateIfMissing('configs/python/pyproject.toml.template', 'pyproject.toml');
      await writeTemplateIfMissing('configs/python/ruff.toml.template', 'ruff.toml');
      await writeTemplateIfMissing('configs/python/pytest.ini.template', 'pytest.ini');
    }
    if (conditions.IF_GO) {
      await writeTemplateIfMissing('configs/go/.golangci.yml.template', '.golangci.yml');
    }
    if (conditions.IF_NEXTJS || conditions.IF_NODE) {
      await writeTemplateIfMissing('configs/node/tsconfig.json.template', 'tsconfig.json');
    }
    logger.success('Language configs (skipped existing)');

    // Pre-commit config
    const precommitTemplate = path.join(templatesDir, '.pre-commit-config.yaml.template');
    if (fs.existsSync(precommitTemplate) && conditions.IF_PRECOMMIT) {
      await writeTemplate('.pre-commit-config.yaml.template', '.pre-commit-config.yaml');
      logger.success('.pre-commit-config.yaml');
    }

    // GitHub workflows
    const ciTemplate = path.join(templatesDir, '.github', 'workflows', 'ci.yml.template');
    if (fs.existsSync(ciTemplate)) {
      await writeTemplate('.github/workflows/ci.yml.template', '.github/workflows/ci.yml');
      await writeTemplate('.github/workflows/quality.yml.template', '.github/workflows/quality.yml');
      logger.success('.github/workflows/');
    }

    // .editorconfig
    copyStatic('configs/shared/.editorconfig', '.editorconfig');
    logger.success('.editorconfig');

    // .project.yaml
    const projectYaml = generateProjectYaml(config);
    const yamlPath = path.join(targetDir, '.project.yaml');
    const yamlRes = await writeFile(yamlPath, projectYaml, opts(false));
    track(yamlPath, projectYaml, yamlRes, false);
    logger.success('.project.yaml');
  }

  // Write manifest
  const manifestContent = JSON.stringify(result.manifest, null, 2) + '\n';
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, '.vyuh-dxkit.json'), manifestContent, 'utf-8');

  return result;

  // --- helper for full mode: only write config if file doesn't exist ---
  async function writeTemplateIfMissing(templatePath: string, outputRel: string) {
    const outputPath = path.join(targetDir, outputRel);
    if (fs.existsSync(outputPath)) {
      result.skipped.push(outputRel);
      return;
    }
    try {
      await writeTemplate(templatePath, outputRel);
    } catch {
      // Template may not exist — skip silently
    }
  }
}

function generateProjectYaml(config: ResolvedConfig): string {
  const lines = [
    `project:`,
    `  name: "${config.projectName}"`,
    `  description: "${config.projectDescription}"`,
    ``,
    `languages:`,
    `  python:`,
    `    enabled: ${config.languages.python}`,
    `    version: "${config.versions.python}"`,
    `    quality:`,
    `      coverage: ${config.coverageThreshold}`,
    `      lint: true`,
    `      typecheck: true`,
    `      format: true`,
    `  go:`,
    `    enabled: ${config.languages.go}`,
    `    version: "${config.versions.go}"`,
    `    quality:`,
    `      coverage: ${Math.max(0, parseInt(config.coverageThreshold) - 10)}`,
    `      lint: true`,
    `      format: true`,
    `  node:`,
    `    enabled: ${config.languages.node || config.languages.nextjs}`,
    `    version: "${config.versions.node}"`,
    `  rust:`,
    `    enabled: ${config.languages.rust}`,
    `    version: "${config.versions.rust}"`,
    `  csharp:`,
    `    enabled: ${config.languages.csharp}`,
    `    version: "${config.versions.csharp}"`,
    `    quality:`,
    `      lint: true`,
    `      format: true`,
    `  nextjs:`,
    `    enabled: ${config.languages.nextjs}`,
    ``,
    `infrastructure:`,
    `  postgres:`,
    `    enabled: ${config.infrastructure.postgres}`,
    `  redis:`,
    `    enabled: ${config.infrastructure.redis}`,
    ``,
    `precommit: ${config.precommit}`,
    ``,
    `tools:`,
    `  claude_code: true`,
    `  github_cli: ${config.tools.ghCli}`,
    `  docker: ${config.infrastructure.docker}`,
    `  gcloud: ${config.tools.gcloud}`,
    `  pulumi: ${config.tools.pulumi}`,
    `  infisical: ${config.tools.infisical}`,
  ];
  return lines.join('\n') + '\n';
}

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, ext));
    else if (entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}
