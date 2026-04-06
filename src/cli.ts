import { parseArgs } from 'node:util';
import { detect } from './detect';
import { generate } from './generator';
import { promptForConfig } from './prompts';
import { runUpdate } from './update';
import { runDoctor } from './doctor';
import { VERSION } from './constants';
import * as logger from './logger';
import { GenerationMode } from './types';

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
    --name <n>   Override project name
    --no-scan    Skip codebase analysis

  ${logger.bold('Update options:')}
    --force      Overwrite modified files (except evolved)
    --rescan     Re-run codebase analysis

  ${logger.bold('Examples:')}
    npx vyuh-dxkit init                  # Interactive
    npx vyuh-dxkit init --detect         # Auto-detect, just DX
    npx vyuh-dxkit init --full --yes     # Everything, no prompts
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

      // Detect stack
      logger.info('Detecting stack...');
      const detected = detect(cwd);
      const langs = Object.entries(detected.languages).filter(([, v]) => v).map(([k]) => k);
      const tools = Object.entries(detected.tools).filter(([, v]) => v).map(([k]) => k);

      if (langs.length === 0) {
        logger.warn('No languages detected. Generating with minimal config.');
      } else {
        logger.success(`Languages: ${langs.join(', ')}`);
      }
      if (tools.length) logger.success(`Tools: ${tools.join(', ')}`);
      if (detected.framework) logger.success(`Framework: ${detected.framework}`);
      if (detected.testRunner) logger.success(`Tests: ${detected.testRunner.framework} (${detected.testRunner.command})`);
      console.log('');

      // Resolve config
      const mode: GenerationMode = values.full ? 'full' : 'dx-only';
      let config;

      if (values.yes || values.detect) {
        const result = await promptForConfig(detected, {
          yes: true,
          detect: !!values.detect,
          name: values.name as string | undefined,
        });
        config = result.config;
      } else {
        const result = await promptForConfig(detected, {
          yes: false,
          detect: false,
          name: values.name as string | undefined,
        });
        config = result.config;
      }

      // Generate
      const finalMode = values.full ? 'full' : (values['dx-only'] ? 'dx-only' : mode);
      const result = await generate(cwd, config, finalMode, !!values.force, !!values['no-scan']);

      // Summary
      console.log('');
      logger.header('Summary');
      if (result.created.length) logger.success(`Created: ${result.created.length} files`);
      if (result.skipped.length) logger.warn(`Skipped: ${result.skipped.length} files (already exist)`);
      if (result.overwritten.length) logger.info(`Overwritten: ${result.overwritten.length} files`);
      console.log('');
      logger.info('Manifest written to .vyuh-dxkit.json');
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
