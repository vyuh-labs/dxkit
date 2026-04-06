import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { DetectedStack, ResolvedConfig, GenerationMode } from './types';
import { DEFAULT_COVERAGE } from './constants';
import * as logger from './logger';

async function ask(
  rl: readline.Interface,
  question: string,
  defaultValue: string,
): Promise<string> {
  const answer = await rl.question(`  ${question} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
}

async function confirm(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await rl.question(`  ${question} [${hint}]: `);
  if (!answer.trim()) return defaultYes;
  return answer.trim().toLowerCase().startsWith('y');
}

export async function promptForConfig(
  detected: DetectedStack,
  options: { yes: boolean; detect: boolean; name?: string },
): Promise<{ config: ResolvedConfig; mode: GenerationMode }> {
  // Non-interactive: accept all defaults
  if (options.yes || options.detect) {
    return {
      config: {
        ...detected,
        projectName: options.name || detected.projectName,
        coverageThreshold: DEFAULT_COVERAGE,
        precommit: true,
        qualityChecks: true,
        aiSessions: true,
        aiPrompts: true,
        claudeCode: true,
      },
      mode: options.detect ? 'dx-only' : 'full',
    };
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    // Show detected stack
    logger.header('Detected Stack');
    const langs = Object.entries(detected.languages)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const tools = Object.entries(detected.tools)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const infra = Object.entries(detected.infrastructure)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (langs.length) logger.info(`Languages: ${langs.join(', ')}`);
    if (infra.length) logger.info(`Infrastructure: ${infra.join(', ')}`);
    if (tools.length) logger.info(`Tools: ${tools.join(', ')}`);
    console.log('');

    const includeAll = await confirm(rl, 'Include all detected?', true);
    if (!includeAll) {
      // Allow deselecting — for simplicity, just ask per language
      for (const lang of Object.keys(detected.languages) as (keyof DetectedStack['languages'])[]) {
        if (detected.languages[lang]) {
          detected.languages[lang] = await confirm(rl, `Include ${lang}?`, true);
        }
      }
    }

    const projectName = options.name || (await ask(rl, 'Project name?', detected.projectName));
    const includeFull = await confirm(
      rl,
      'Include quality infrastructure (CI, hooks, linters)?',
      true,
    );
    const mode: GenerationMode = includeFull ? 'full' : 'dx-only';

    let coverageThreshold = DEFAULT_COVERAGE;
    let precommit = true;
    if (includeFull) {
      coverageThreshold = await ask(rl, 'Coverage threshold?', DEFAULT_COVERAGE);
      precommit = await confirm(rl, 'Enable pre-commit hooks?', true);
    }

    return {
      config: {
        ...detected,
        projectName,
        coverageThreshold,
        precommit,
        qualityChecks: includeFull,
        aiSessions: true,
        aiPrompts: true,
        claudeCode: true,
      },
      mode,
    };
  } finally {
    rl.close();
  }
}
