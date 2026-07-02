import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { DetectedStack, ResolvedConfig, GenerationMode } from './types';
import { DEFAULT_COVERAGE } from './constants';
import * as logger from './logger';
import type { FlowDetection, FlowSetupDecision } from './analyzers/flow/setup';
import type { FlowGateMode } from './analyzers/flow/config';

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

/**
 * The interactive flow-setup step folded into `init` (there is no standalone
 * `flow init`). Called only when `detectFlowTopology` found a UI→API surface;
 * a repo with none never reaches here, so init stays silent on non-flow repos.
 *
 * Non-interactive (`--yes` / `--detect`, or `forceOn` from `--flow`) takes the
 * gentle default: `warn` posture plus the dominant host-helper strip-prefix.
 * Interactive lets the user pick the posture (with a one-line description of
 * each) and confirm the auto-detected strip-prefix + services.
 */
export async function promptFlowSetup(
  detection: FlowDetection,
  options: { yes: boolean; forceOn: boolean },
): Promise<FlowSetupDecision> {
  const defaultPrefixes = detection.suggestedStripPrefixes.slice(0, 1);

  // Non-interactive default: warn + the dominant strip-prefix, no participants
  // (recording multiple services is an explicit interactive confirm).
  if (options.yes || options.forceOn) {
    return { mode: 'warn', stripUrlPrefixes: defaultPrefixes };
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    logger.header('UI→API integration gate');
    logger.info(
      `Detected ${detection.callCount} client call(s) → ${detection.routeCount} route(s) ` +
        `(${detection.resolvedCount} already resolved).`,
    );
    if (detection.topology !== 'monorepo') {
      logger.info(
        `This repo has only the ${detection.topology === 'consumer-only' ? 'client' : 'server'} ` +
          `side; the gate resolves calls against a counterpart contract (set up later with ` +
          `cross-repo publish) and stays inert until one is present.`,
      );
    }
    console.log(''); // slop-ok
    console.log('  How should a PR that breaks an integration be treated?'); // slop-ok
    console.log('    warn   surface broken integrations as warnings (recommended)'); // slop-ok
    console.log('    block  fail the check on an exact broken integration (confidence-gated)'); // slop-ok
    console.log('    off    scaffold config only, do not gate yet'); // slop-ok
    const mode = await selectMode(rl, 'Posture?', 'warn');

    let stripUrlPrefixes: string[] = [];
    if (detection.suggestedStripPrefixes.length > 0) {
      const top = detection.suggestedStripPrefixes[0];
      const ok = await confirm(
        rl,
        `Strip base-URL prefix "${top}" so calls match served routes?`,
        true,
      );
      if (ok) stripUrlPrefixes = [top];
    }

    let participants: FlowSetupDecision['participants'];
    if (detection.detectedServices.length >= 2) {
      const list = detection.detectedServices.join(', ');
      const ok = await confirm(
        rl,
        `Detected ${detection.detectedServices.length} services (${list}). Record them as participants?`,
        true,
      );
      if (ok) participants = detection.detectedServices.map((name) => ({ name, path: name }));
    }

    return { mode, stripUrlPrefixes, ...(participants ? { participants } : {}) };
  } finally {
    rl.close();
  }
}

/** Ask for a flow posture, re-prompting until a valid value (or the default on
 *  an empty answer). Kept local — the only three-way select dxkit prompts for. */
async function selectMode(
  rl: readline.Interface,
  question: string,
  defaultValue: FlowGateMode,
): Promise<FlowGateMode> {
  for (;;) {
    const answer = (await rl.question(`  ${question} [${defaultValue}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'warn' || answer === 'block' || answer === 'off') return answer;
    logger.warn('Enter one of: warn, block, off.');
  }
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
    const infra = Object.entries(detected.infrastructure)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (langs.length) logger.info(`Languages: ${langs.join(', ')}`);
    if (infra.length) logger.info(`Infrastructure: ${infra.join(', ')}`);
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
    if (includeFull) {
      coverageThreshold = await ask(rl, 'Coverage threshold?', DEFAULT_COVERAGE);
    }

    return {
      config: {
        ...detected,
        projectName,
        coverageThreshold,
        claudeCode: true,
      },
      mode,
    };
  } finally {
    rl.close();
  }
}
