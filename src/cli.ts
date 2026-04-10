import { parseArgs } from 'node:util';
import { detect } from './detect';
import { generate } from './generator';
import { promptForConfig } from './prompts';
import { hasProjectYaml, readProjectYaml } from './project-yaml';
import { runUpdate } from './update';
import { runDoctor } from './doctor';
import { VERSION } from './constants';
import * as logger from './logger';
import { GenerationMode } from './types';
import * as fs from 'fs';
import * as path from 'path';

function printUsage(): void {
  console.log(`
  ${logger.bold('vyuh-dxkit')} v${VERSION} — AI-native developer experience toolkit

  ${logger.bold('Usage:')}
    vyuh-dxkit init [options]    Initialize Claude Code DX in this repo
    vyuh-dxkit update [options]  Re-generate (preserves evolved files)
    vyuh-dxkit doctor            Verify setup

  ${logger.bold('Init options:')}
    --dx-only    Just .claude/ + CLAUDE.md (default)
    --full       Everything: DX + quality + hooks + CI
    --detect     Auto-detect stack, minimal prompts
    --yes        Accept all defaults, no prompts
    --force      Overwrite existing files (except evolved)
    --stealth    Gitignore generated files (local-only, not committed)
    --name <n>   Override project name
    --no-scan    Skip codebase analysis

  ${logger.bold('Update options:')}
    --force      Overwrite modified files (except evolved)
    --rescan     Re-run codebase analysis

  ${logger.bold('Examples:')}
    npx vyuh-dxkit init                  # Interactive
    npx vyuh-dxkit init --detect         # Auto-detect, just DX
    npx vyuh-dxkit init --full --yes     # Everything, no prompts
    npx vyuh-dxkit init --detect --stealth  # Local-only, not committed
    npx vyuh-dxkit update                # Re-generate from manifest
`);
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      'dx-only': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      detect: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      stealth: { type: 'boolean', default: false },
      name: { type: 'string' },
      'no-scan': { type: 'boolean', default: false },
      rescan: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  if (values.version) {
    console.log(VERSION);
    return;
  }

  const command = positionals[0] || 'init';
  const cwd = process.cwd();

  switch (command) {
    case 'init': {
      logger.header('vyuh-dxkit init');

      let config;
      let finalMode: GenerationMode = values.full ? 'full' : 'dx-only';

      // If .project.yaml exists (written by create-devstack), try using it as config source
      if (hasProjectYaml(cwd)) {
        const yamlConfig = readProjectYaml(cwd);

        if (yamlConfig) {
          logger.info('Found .project.yaml — using as config source.');
          config = yamlConfig;

          const langs = Object.entries(config.languages)
            .filter(([, v]) => v)
            .map(([k]) => k);
          const tools = Object.entries(config.tools)
            .filter(([, v]) => v)
            .map(([k]) => k);

          if (langs.length) logger.success(`Languages: ${langs.join(', ')}`);
          if (tools.length) logger.success(`Tools: ${tools.join(', ')}`);
          console.log('');

          // .project.yaml implies full mode (create-devstack handles the wizard)
          finalMode = values['dx-only'] ? 'dx-only' : 'full';
        } else {
          logger.warn('Found .project.yaml but it is malformed — falling back to detection.');
        }
      }

      if (!config) {
        // No .project.yaml — detect stack and prompt as before
        logger.info('Detecting stack...');
        const detected = detect(cwd);
        const langs = Object.entries(detected.languages)
          .filter(([, v]) => v)
          .map(([k]) => k);
        const tools = Object.entries(detected.tools)
          .filter(([, v]) => v)
          .map(([k]) => k);

        if (langs.length === 0) {
          logger.warn('No languages detected. Generating with minimal config.');
        } else {
          logger.success(`Languages: ${langs.join(', ')}`);
        }
        if (tools.length) logger.success(`Tools: ${tools.join(', ')}`);
        if (detected.framework) logger.success(`Framework: ${detected.framework}`);
        if (detected.testRunner)
          logger.success(
            `Tests: ${detected.testRunner.framework} (${detected.testRunner.command})`,
          );
        console.log('');

        // Resolve config via prompts
        const promptOpts = {
          yes: !!(values.yes || values.detect),
          detect: !!values.detect,
          name: values.name as string | undefined,
        };
        const result = await promptForConfig(detected, promptOpts);
        config = result.config;

        finalMode = values.full ? 'full' : values['dx-only'] ? 'dx-only' : result.mode;
      }
      const result = await generate(cwd, config, finalMode, !!values.force, !!values['no-scan']);

      // Summary
      console.log('');
      logger.header('Summary');
      if (result.created.length) logger.success(`Created: ${result.created.length} files`);
      if (result.skipped.length)
        logger.warn(`Skipped: ${result.skipped.length} files (already exist)`);
      if (result.overwritten.length) logger.info(`Overwritten: ${result.overwritten.length} files`);
      console.log('');
      logger.info('Manifest written to .vyuh-dxkit.json');

      // Stealth mode: gitignore only files we just created
      if (values.stealth) {
        enableStealthMode(cwd, result.created);
      }

      console.log('');
      logger.success('Done! Claude Code now has full project context.');
      console.log('');
      logger.dim('  Run `vyuh-dxkit doctor` to verify setup');
      logger.dim('  Run `vyuh-dxkit update` to re-generate after changes');
      break;
    }

    case 'update': {
      await runUpdate(cwd, !!values.force, !!values.rescan);
      break;
    }

    case 'doctor': {
      await runDoctor(cwd);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

const STEALTH_HEADER = '# dxkit (stealth mode — local only, not committed)';

/**
 * Add only files created in this run to .gitignore.
 * Collapses directory files into directory entries.
 */
function enableStealthMode(cwd: string, createdFiles: string[]): void {
  const gitignorePath = path.join(cwd, '.gitignore');

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (existing.includes(STEALTH_HEADER)) {
      logger.warn('.gitignore already has dxkit stealth entries');
      return;
    }
  }

  // Collapse into top-level directories where possible
  const dirs = new Set<string>();
  const files: string[] = [];

  for (const f of createdFiles) {
    const topDir = f.split('/')[0];
    if (f.includes('/') && topDir.startsWith('.')) {
      dirs.add(topDir + '/');
    } else {
      files.push(f);
    }
  }
  // Always include the manifest
  files.push('.vyuh-dxkit.json');

  // Dedupe against existing .gitignore
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const newEntries: string[] = [];

  for (const d of dirs) {
    if (!existingLines.has(d)) newEntries.push(d);
  }
  for (const f of files) {
    if (!existingLines.has(f)) newEntries.push(f);
  }

  if (newEntries.length === 0) {
    logger.warn('.gitignore already covers generated files');
    return;
  }

  const block = '\n' + STEALTH_HEADER + '\n' + newEntries.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, block, 'utf-8');
  logger.success(
    `.gitignore updated — ${newEntries.length} generated path${newEntries.length !== 1 ? 's' : ''} added (stealth mode)`,
  );
}
