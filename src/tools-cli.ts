/**
 * CLI handler for `vyuh-dxkit tools` subcommand.
 *
 * Modes:
 * - `vyuh-dxkit tools`             → list status for required tools
 * - `vyuh-dxkit tools install`     → interactive install of missing tools
 *                                    for the current-project stack
 * - `vyuh-dxkit tools install <name>` → install one named tool (any
 *                                    stack); useful for cross-stack dev
 *                                    work where you need a tool that
 *                                    your current project doesn't
 *                                    declare (e.g. installing
 *                                    `spotbugs` on a Node-only repo)
 * - `vyuh-dxkit tools install --all` → enumerate every known tool in
 *                                    TOOL_DEFS and install missing
 *                                    ones; useful for setting up a
 *                                    cross-stack dev environment
 * - `vyuh-dxkit tools install --yes` → install all missing, no prompts
 */
import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import { detect } from './detect';
import { DetectedStack } from './types';
import * as logger from './logger';
import {
  TOOL_DEFS,
  findTool,
  getInstallCommand,
  checkAllTools,
  buildRequiredTools,
  ToolStatus,
} from './analyzers/tools/tool-registry';

export interface ToolsInstallOptions {
  toolName?: string;
  all?: boolean;
}

/**
 * Decide which tool names to consider for install given the options.
 * Pure function — does not touch the filesystem; testable in isolation.
 *
 * - toolName set: just that one (returns [] if name is unknown — caller
 *   surfaces an error)
 * - all: every key in TOOL_DEFS, sorted for stable output
 * - default: tools required for the current-project stack
 */
export function selectToolNames(
  languages: DetectedStack['languages'],
  options: ToolsInstallOptions = {},
): string[] {
  if (options.toolName) {
    return TOOL_DEFS[options.toolName] ? [options.toolName] : [];
  }
  if (options.all) {
    return Object.keys(TOOL_DEFS).sort();
  }
  return buildRequiredTools(languages).map((r) => r.name);
}

const LAYER_ORDER: Record<string, number> = {
  universal: 1,
  language: 2,
  optional: 3,
};

const LAYER_LABEL: Record<string, string> = {
  universal: 'universal',
  language: 'language ',
  optional: 'optional ',
};

function sortByLayer(statuses: ToolStatus[]): ToolStatus[] {
  return [...statuses].sort((a, b) => {
    const la = LAYER_ORDER[a.requirement.layer] || 99;
    const lb = LAYER_ORDER[b.requirement.layer] || 99;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });
}

function formatStatusLine(s: ToolStatus): string {
  const icon = s.available ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const name = s.name.padEnd(16);
  const layer = LAYER_LABEL[s.requirement.layer] || s.requirement.layer;
  const forStack = s.requirement.for.padEnd(7);
  if (s.available) {
    const src = s.source === 'path' ? '' : ` (${s.source})`;
    return `  ${icon} ${name}  ${layer}  ${forStack}  ${logger.bold('found')}${src}`;
  }
  return `  ${icon} ${name}  ${layer}  ${forStack}  \x1b[2mmissing\x1b[0m`;
}

/** Show tool status for the repo's detected stack. */
function showStatus(targetPath: string): ToolStatus[] {
  const stack = detect(targetPath);
  const langs = Object.entries(stack.languages)
    .filter(([, v]) => v)
    .map(([k]) => k);

  logger.header('vyuh-dxkit tools');
  logger.info(`Stack: ${langs.join(', ') || 'unknown'}`);
  console.log('');

  const statuses = sortByLayer(checkAllTools(stack.languages, targetPath));

  console.log(
    `  ${logger.bold('Tool'.padEnd(16))}  ${logger.bold('layer'.padEnd(10))}  ${logger.bold('for'.padEnd(7))}  ${logger.bold('status')}`,
  );
  console.log(`  ${'─'.repeat(16)}  ${'─'.repeat(10)}  ${'─'.repeat(7)}  ${'─'.repeat(20)}`);

  for (const s of statuses) {
    console.log(formatStatusLine(s));
    if (s.available && s.version) {
      logger.dim(`    version: ${s.version}`);
    }
    if (s.available && s.path && s.source !== 'path') {
      logger.dim(`    path: ${s.path}`);
    }
  }

  const missing = statuses.filter((s) => !s.available);
  const total = statuses.length;
  console.log('');
  if (missing.length === 0) {
    logger.success(`All ${total} required tools available.`);
  } else {
    logger.warn(`${missing.length}/${total} tools missing.`);
    console.log('');
    logger.dim(`Run \`vyuh-dxkit tools install\` to install missing tools interactively.`);
  }
  return statuses;
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await rl.question(`  ${question} [Y/n]: `);
  if (!answer.trim()) return true;
  return answer.trim().toLowerCase().startsWith('y');
}

function runInstallCmd(cmd: string): { success: boolean; message: string } {
  try {
    // Use bash -c so multi-command scripts (with &&, ||, ;) work
    execSync(cmd, {
      shell: '/bin/bash',
      stdio: ['inherit', 'inherit', 'inherit'],
      timeout: 600000, // 10 min for downloads
    });
    return { success: true, message: 'installed' };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, message: e.message || 'unknown error' };
  }
}

/** Interactive install of missing tools. */
async function runInstall(
  targetPath: string,
  autoYes: boolean,
  options: ToolsInstallOptions = {},
): Promise<void> {
  // Validate single-tool name early so we fail fast with a useful message.
  if (options.toolName && !TOOL_DEFS[options.toolName]) {
    logger.fail(`Unknown tool: ${options.toolName}`);
    logger.info('Run `vyuh-dxkit tools list` to see available tools.');
    process.exit(1);
  }

  // Default mode shows the full status table. Targeted modes skip it
  // because the table would be either redundant (single tool) or huge
  // (--all enumerates every TOOL_DEFS entry).
  let statuses: ToolStatus[];
  let modeLabel: string;
  if (options.toolName || options.all) {
    const stack = detect(targetPath);
    const names = selectToolNames(stack.languages, options);
    statuses = names
      .map((n) => {
        const def = TOOL_DEFS[n];
        return def ? findTool(def, targetPath) : null;
      })
      .filter((s): s is ToolStatus => s !== null);
    modeLabel = options.toolName
      ? `Install ${options.toolName}`
      : `Install all known tools (${statuses.length} candidates, missing only)`;
  } else {
    statuses = showStatus(targetPath);
    modeLabel = 'Install missing tools';
  }

  const missing = statuses.filter((s) => !s.available);

  if (missing.length === 0) {
    if (options.toolName) {
      logger.success(`${options.toolName} is already installed.`);
    } else if (options.all) {
      logger.success(`All ${statuses.length} known tools already installed.`);
    }
    return;
  }

  console.log('');
  logger.header(modeLabel);

  const rl = autoYes ? null : readline.createInterface({ input: stdin, output: stdout });
  const results: Array<{ name: string; status: 'installed' | 'skipped' | 'failed'; msg?: string }> =
    [];

  try {
    for (const s of missing) {
      const def = TOOL_DEFS[s.name];
      if (!def) {
        results.push({ name: s.name, status: 'skipped', msg: 'no install command' });
        continue;
      }
      const cmd = getInstallCommand(def);
      if (cmd === 'builtin' || cmd === 'builtin (npm)' || cmd === 'builtin (dotnet SDK)') {
        results.push({ name: s.name, status: 'skipped', msg: 'builtin' });
        continue;
      }

      console.log('');
      console.log(`  ${logger.bold(s.name)} — ${def.description}`);
      logger.dim(`    ${cmd}`);

      let shouldInstall = autoYes;
      if (!autoYes && rl) {
        shouldInstall = await confirm(rl, `  Install ${s.name}?`);
      }

      if (!shouldInstall) {
        results.push({ name: s.name, status: 'skipped', msg: 'user declined' });
        logger.dim('  Skipped.');
        continue;
      }

      console.log('');
      logger.info(`Running: ${cmd}`);
      const result = runInstallCmd(cmd);
      if (result.success) {
        // Verify install worked. An install command can legitimately
        // exit 0 without producing the binary — e.g. the vitest-coverage
        // guard no-ops when vitest isn't a target-repo dep. Treat
        // "exit 0 + tool still missing" as a skip, not a failure: the
        // script ran cleanly, we just didn't get the binary we wanted.
        // Real install failures surface through the `result.success ===
        // false` branch below (non-zero exit).
        const recheck = findTool(def, targetPath);
        if (recheck.available) {
          results.push({ name: s.name, status: 'installed' });
          logger.success(`${s.name} installed (${recheck.source})`);
        } else {
          results.push({
            name: s.name,
            status: 'skipped',
            msg: 'install command exited 0 without producing the binary (likely a guarded no-op)',
          });
          logger.dim(`${s.name} skipped — install command exited cleanly without installing`);
        }
      } else {
        results.push({ name: s.name, status: 'failed', msg: result.message });
        logger.fail(`${s.name}: ${result.message}`);
      }
    }
  } finally {
    rl?.close();
  }

  // Summary
  console.log('');
  logger.header('Summary');
  const installed = results.filter((r) => r.status === 'installed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  logger.info(`${installed} installed, ${skipped} skipped, ${failed} failed`);

  if (failed > 0) {
    console.log('');
    logger.dim('Failed installs:');
    for (const r of results.filter((r) => r.status === 'failed')) {
      logger.dim(`  ${r.name}: ${r.msg}`);
    }
  }

  if (installed > 0) {
    console.log('');
    logger.dim('Run `vyuh-dxkit health` to use the newly installed tools.');
  }
}

export async function runToolsCommand(
  targetPath: string,
  subCommand: string | undefined,
  autoYes: boolean,
  options: ToolsInstallOptions = {},
): Promise<void> {
  if (!subCommand || subCommand === 'list' || subCommand === 'status') {
    showStatus(targetPath);
    return;
  }
  if (subCommand === 'install') {
    await runInstall(targetPath, autoYes, options);
    return;
  }
  logger.fail(`Unknown tools subcommand: ${subCommand}`);
  logger.info('Usage: vyuh-dxkit tools [list|install] [<tool-name>] [path] [--all] [--yes]');
  process.exit(1);
}
