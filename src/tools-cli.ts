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
import { dxkitCli } from './self-invocation';
import { stdin, stdout } from 'process';
import { detect } from './detect';
import { detectPackageManager, provisionCommand } from './package-manager';
import * as logger from './logger';
import {
  TOOL_DEFS,
  findTool,
  checkAllTools,
  exportToolPathsToGithubEnv,
  ToolStatus,
} from './analyzers/tools/tool-registry';
import {
  selectToolNames,
  resolveInstallCommand,
  execInstall,
  type ToolsInstallOptions,
} from './analyzers/tools/install-exec';

// The install-EXECUTION surface lives in `install-exec.ts` (split out to keep
// this file under the large-file budget); re-export it so existing importers
// (init-arc, tests) keep one entry point (Rule 2 — one install code path).
export {
  selectToolNames,
  recordToolDep,
  resolveInstallCommand,
  execInstall,
  installMissingTools,
} from './analyzers/tools/install-exec';
export type {
  ToolsInstallOptions,
  ResolvedInstall,
  OneToolResult,
  ToolInstallEvent,
  ToolInstallOutcome,
} from './analyzers/tools/install-exec';

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
  const name = s.name.padEnd(16);
  const layer = LAYER_LABEL[s.requirement.layer] || s.requirement.layer;
  const forStack = s.requirement.for.padEnd(7);
  if (s.available) {
    const src = s.source === 'path' ? '' : ` (${s.source})`;
    return `  \x1b[32m✓\x1b[0m ${name}  ${layer}  ${forStack}  ${logger.bold('found')}${src}`;
  }
  // N/A tools (applicability gate fired): show a distinct icon + the
  // reason so users see "not for this stack" rather than "missing".
  // These intentionally do NOT count toward the missing tally.
  if (s.source === 'n/a') {
    const reason = s.notApplicableReason ? ` \x1b[2m(${s.notApplicableReason})\x1b[0m` : '';
    return `  \x1b[2m−\x1b[0m ${name}  ${layer}  ${forStack}  \x1b[2mn/a${reason ? '' : ' for this stack'}\x1b[0m${reason}`;
  }
  // Project-local tools (F-UX-3): annotate so users don't confuse a
  // missing dev-dep with a missing system tool.
  const scopeNote =
    s.requirement.installScope === 'project-local' ? ' \x1b[2m(project-local dev-dep)\x1b[0m' : '';
  return `  \x1b[31m✗\x1b[0m ${name}  ${layer}  ${forStack}  \x1b[2mmissing\x1b[0m${scopeNote}`;
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

  // Split the unavailable set: truly missing (actionable) vs n/a
  // (informational — the applicability gate excluded the tool from
  // this stack). Missing-count math must not include n/a entries or
  // customers see false "1/14 missing" alarms on repos that
  // legitimately don't use the tool.
  const missing = statuses.filter((s) => !s.available && s.source !== 'n/a');
  const notApplicable = statuses.filter((s) => s.source === 'n/a');
  const total = statuses.length;
  const applicable = total - notApplicable.length;
  console.log('');
  if (missing.length === 0) {
    if (notApplicable.length === 0) {
      logger.success(`All ${total} required tools available.`);
    } else {
      logger.success(
        `All ${applicable} applicable tools available (${notApplicable.length} n/a for this stack).`,
      );
    }
  } else {
    const naSuffix = notApplicable.length > 0 ? `, ${notApplicable.length} n/a` : '';
    logger.warn(`${missing.length}/${applicable} applicable tools missing${naSuffix}.`);
    console.log('');

    // F-UX-3: partition missing by install scope so the hint matches
    // where each tool actually lives. Project-local tools (eslint,
    // @vitest/coverage-v8) are declared in the consumer's package.json
    // — dxkit shouldn't try to add them on the consumer's behalf;
    // `npm ci` already populates `node_modules/.bin/`. Globally-
    // installed tools (semgrep, gitleaks, cloc) are dxkit's
    // responsibility.
    const projectLocalMissing = missing.filter(
      (s) => s.requirement.installScope === 'project-local',
    );
    const globalMissing = missing.filter((s) => s.requirement.installScope !== 'project-local');

    if (projectLocalMissing.length > 0) {
      const provision = provisionCommand(detectPackageManager(targetPath));
      logger.dim(
        `${projectLocalMissing.length} project-local tool${projectLocalMissing.length === 1 ? '' : 's'} (${projectLocalMissing.map((s) => s.name).join(', ')}) — run \`${provision}\` in this repo to provision them from package.json devDependencies.`,
      );
    }
    if (globalMissing.length > 0) {
      logger.dim(
        `${globalMissing.length} global tool${globalMissing.length === 1 ? '' : 's'} — run \`${dxkitCli('tools install')}\` to install interactively.`,
      );
    }
  }
  return statuses;
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await rl.question(`  ${question} [Y/n]: `);
  if (!answer.trim()) return true;
  return answer.trim().toLowerCase().startsWith('y');
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
    logger.info(`Run \`${dxkitCli('tools list')}\` to see available tools.`);
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

  // Exclude n/a entries — applicability gate already determined the
  // tool doesn't apply to this stack, so attempting an install would
  // either no-op or pull in dead weight.
  const missing = statuses.filter((s) => !s.available && s.source !== 'n/a');
  const notApplicable = statuses.filter((s) => s.source === 'n/a');

  // Targeted single-tool install hitting an n/a tool: surface the
  // reason and exit cleanly rather than silently skipping. Users who
  // explicitly typed the name deserve a direct answer.
  if (options.toolName && notApplicable.length === 1 && missing.length === 0) {
    const reason = notApplicable[0].notApplicableReason ?? 'not applicable to this stack';
    logger.info(`${options.toolName} is not applicable here: ${reason}.`);
    return;
  }

  if (missing.length === 0) {
    if (options.toolName) {
      logger.success(`${options.toolName} is already installed.`);
    } else if (options.all) {
      const naSuffix =
        notApplicable.length > 0 ? ` (${notApplicable.length} n/a for this stack — skipped)` : '';
      logger.success(
        `All ${statuses.length - notApplicable.length} applicable tools already installed.${naSuffix}`,
      );
    } else if (notApplicable.length > 0) {
      logger.success(
        `All applicable tools available (${notApplicable.length} n/a for this stack — skipped).`,
      );
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
      const resolved = resolveInstallCommand(targetPath, s.name);
      if (resolved.kind === 'none') {
        results.push({ name: s.name, status: 'skipped', msg: 'no install command' });
        continue;
      }
      if (resolved.kind === 'builtin') {
        results.push({ name: s.name, status: 'skipped', msg: 'builtin' });
        continue;
      }

      console.log(''); // slop-ok: interactive installer's own stdout framing
      console.log(`  ${logger.bold(s.name)} — ${resolved.description}`); // slop-ok: interactive installer tool header
      logger.dim(`    ${resolved.command}`);

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
      logger.info(`Running: ${resolved.command}`);
      // The command construction + exec + verify + dep-recording all live in
      // execInstall (Rule 2) — the interactive path just renders its outcome.
      const r = execInstall(targetPath, resolved);
      if (r.status === 'installed') {
        results.push({ name: s.name, status: 'installed' });
        logger.success(`${s.name} installed (${r.detail})`);
      } else if (r.status === 'failed') {
        results.push({ name: s.name, status: 'failed', msg: r.detail });
        logger.fail(`${s.name}: ${r.detail}`);
      } else {
        results.push({ name: s.name, status: 'skipped', msg: r.detail });
        logger.dim(`${s.name} skipped — ${r.detail}`);
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
  const naSuffix = notApplicable.length > 0 ? `, ${notApplicable.length} n/a` : '';
  logger.info(`${installed} installed, ${skipped} skipped, ${failed} failed${naSuffix}`);

  if (failed > 0) {
    console.log('');
    logger.dim('Failed installs:');
    for (const r of results.filter((r) => r.status === 'failed')) {
      logger.dim(`  ${r.name}: ${r.msg}`);
    }
  }

  if (installed > 0) {
    console.log('');
    logger.dim(`Run \`${dxkitCli('health')}\` to use the newly installed tools.`);
  }

  // In CI, make every tool bin dir dxkit knows about discoverable by name in
  // later workflow steps, so the per-language dep audit finds its native scanner
  // instead of falling back to a wrong-artifact one. Registry-derived, so a new
  // language pack's scanner dir is covered with no workflow edit. No-op off CI.
  exportToolPathsToGithubEnv();
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
