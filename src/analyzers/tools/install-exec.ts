/**
 * Tool install EXECUTION — the ONE code path that resolves a tool's install
 * command, runs it, verifies the binary landed, and records a project-local
 * devDependency (Rule 2). Split out of `tools-cli.ts` so both the interactive
 * installer (which renders its own prompts + summary) and the init finishing
 * arc's quiet `installMissingTools()` core drive the same execution primitive
 * without duplicating command construction.
 *
 * Pure of any CLI chrome: nothing here prints via the logger. The interactive
 * surface in `tools-cli.ts` renders the outcomes; the quiet core emits progress
 * through an optional `onEvent` observer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { detect } from '../../detect';
import { DetectedStack, type Manifest } from '../../types';
import { serializePreservingJson } from '../../files';
import { detectPackageManager, pmAwareDevInstall } from '../../package-manager';
import { diagnoseStaleIndex } from './install-diagnosis';
import {
  TOOL_DEFS,
  findTool,
  getInstallCommand,
  getInstallEnv,
  buildRequiredTools,
  exportToolPathsToGithubEnv,
  ToolStatus,
} from './tool-registry';

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

/**
 * Append a dxkit-installed node devDependency to the install manifest so
 * `vyuh-dxkit uninstall` can remove it. No-op when the repo has no manifest
 * (dxkit wasn't init'd there) or the entry is already recorded. Best-effort:
 * a manifest write failure never fails the install.
 */
export function recordToolDep(cwd: string, pkg: string): void {
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as Manifest;
    // Normalize to the {package, ecosystem} shape, dropping any legacy `install`
    // string an older dxkit persisted here. Every executed/rendered install is
    // already PM-aware; the stored npm-flavored text (`npm install --save-dev …`)
    // was misleading canonical JSON on a non-npm repo and is derivable from
    // {package, ecosystem} anyway. Re-run of `tools install` cleans a legacy file.
    const normalized = (manifest.toolDeps ?? []).map((d) => ({
      package: d.package,
      ecosystem: 'node' as const,
    }));
    if (!normalized.some((d) => d.package === pkg)) {
      normalized.push({ package: pkg, ecosystem: 'node' });
    }
    manifest.toolDeps = normalized;
    fs.writeFileSync(manifestPath, serializePreservingJson(raw, manifest), 'utf-8');
  } catch {
    // no manifest / unreadable / unwritable → nothing to record, never fatal
  }
}

function runInstallCmd(
  cmd: string,
  envOverlay?: Record<string, string>,
  quiet = false,
): { success: boolean; message: string } {
  try {
    // Pick a shell that exists on the platform. On POSIX use bash so
    // multi-command scripts (`&&`, `||`, `;`) work; on Windows omit the
    // option so Node uses the default cmd.exe (the hardcoded `/bin/bash`
    // path doesn't exist there, which made every `tools install` fail
    // outright).
    const shell = process.platform === 'win32' ? undefined : '/bin/bash';
    // Quiet mode (the init finishing arc): capture the child's output instead
    // of inheriting it, so a package manager's install noise doesn't bleed
    // through the step UI. On failure the captured text becomes the message.
    execSync(cmd, {
      shell,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
      timeout: 600000, // 10 min for downloads
      env: envOverlay ? { ...process.env, ...envOverlay } : process.env,
    });
    return { success: true, message: 'installed' };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, message: e.message || 'unknown error' };
  }
}

/** The install command dxkit would run for a tool, resolved PM-aware. */
export interface ResolvedInstall {
  readonly name: string;
  readonly description: string;
  /** 'builtin' → nothing to install; 'none' → no install command; 'run' → execute `command`. */
  readonly kind: 'builtin' | 'none' | 'run';
  readonly command?: string;
}

/**
 * Resolve the install command for one tool WITHOUT running it. Shared by the
 * interactive installer (which prints it before prompting) and the quiet core
 * — the PM-aware command string is built in exactly one place (Rule 2).
 */
export function resolveInstallCommand(targetPath: string, toolName: string): ResolvedInstall {
  const def = TOOL_DEFS[toolName];
  if (!def) return { name: toolName, description: '', kind: 'none' };
  const rawCmd = getInstallCommand(def);
  if (rawCmd === 'builtin' || rawCmd === 'builtin (npm)' || rawCmd === 'builtin (dotnet SDK)') {
    return { name: toolName, description: def.description, kind: 'builtin' };
  }
  // A node devDep tool (e.g. @vitest/coverage-v8) installs INTO the user's repo,
  // so its `npm install --save-dev …` must match the repo's PM — else it fails
  // the way create-dxkit did on a pnpm project. Isolated tools keep their npm cmd.
  let command = def.nodePackage
    ? pmAwareDevInstall(rawCmd, detectPackageManager(targetPath))
    : rawCmd;
  // Version-aware SDK bootstrap: a tool whose install command carries a
  // `__DOTNET_CHANNEL__` / `__DOTNET_MAJOR__` placeholder is filled from the
  // repo's DETECTED runtime version (Rule 6 — the version is a language fact),
  // so the installed SDK major matches the repo instead of a hardcoded one.
  // Generic by placeholder, not a per-language branch: any future runtime
  // bootstrap can reuse the same substitution.
  command = substituteRuntimeVersion(command, targetPath);
  return { name: toolName, description: def.description, kind: 'run', command };
}

/**
 * Fill `__DOTNET_CHANNEL__` (e.g. `9.0`) / `__DOTNET_MAJOR__` (e.g. `9`) in an
 * install command from the repo's detected .NET version, falling back to `8.0`
 * when the repo declares none. Only runs `detect` when a placeholder is present
 * (the common non-.NET install pays nothing). Exported for unit coverage.
 */
export function substituteRuntimeVersion(command: string, targetPath: string): string {
  if (!command.includes('__DOTNET_')) return command;
  const version = detect(targetPath).versions.csharp ?? '8.0'; // e.g. '9.0'
  const major = version.split('.')[0]; // e.g. '9'
  return command.replace(/__DOTNET_CHANNEL__/g, version).replace(/__DOTNET_MAJOR__/g, major);
}

/** The outcome of running (or trying to run) one tool's install command. */
export interface OneToolResult {
  readonly status: 'installed' | 'skipped' | 'failed';
  readonly detail?: string;
}

/**
 * Execute one tool's resolved install command, verify the binary landed, and
 * record a project-local devDep so `uninstall` owns it. The ONE place install
 * execution + verification + dep-recording lives — both the interactive
 * installer and the quiet init-arc core call this (Rule 2).
 */
export function execInstall(
  targetPath: string,
  resolved: ResolvedInstall,
  opts: { quiet?: boolean } = {},
): OneToolResult {
  if (resolved.kind === 'none') return { status: 'skipped', detail: 'no install command' };
  if (resolved.kind === 'builtin') return { status: 'skipped', detail: 'builtin' };
  const def = TOOL_DEFS[resolved.name]!;
  const result = runInstallCmd(resolved.command!, getInstallEnv(targetPath), opts.quiet);
  if (!result.success) {
    // Problem C (Rule 20): a stale-mirror failure surfaces as pip's
    // unsatisfiable-requirement wall. Replace it with one legible sentence
    // naming the root cause + the remedy dxkit already takes (defer to CI).
    // Only when the signature matches — a genuine failure keeps its raw text.
    const stale = diagnoseStaleIndex(result.message);
    return { status: 'failed', detail: stale ? stale.message : result.message };
  }
  // An install command can legitimately exit 0 without producing the binary —
  // e.g. the vitest-coverage guard no-ops when vitest isn't a target dep. Treat
  // "exit 0 + tool still missing" as a skip, not a failure.
  const recheck = findTool(def, targetPath);
  if (!recheck.available) {
    return {
      status: 'skipped',
      detail: 'install command exited 0 without producing the binary (likely a guarded no-op)',
    };
  }
  // A project-local node devDep landed in the user's package.json on dxkit's
  // behalf — record it so uninstall OWNS it (the "exact pre-dxkit state" promise).
  if (def.nodePackage) recordToolDep(targetPath, def.nodePackage);
  return { status: 'installed', detail: recheck.source };
}

/** A tool-install progress event for the quiet core's optional observer. */
export interface ToolInstallEvent {
  readonly name: string;
  readonly phase: 'installing' | 'installed' | 'skipped' | 'failed';
  readonly detail?: string;
}

/** The structured result of a non-interactive install-missing pass. */
export interface ToolInstallOutcome {
  readonly installed: readonly string[];
  readonly skipped: ReadonlyArray<{ name: string; reason: string }>;
  readonly failed: ReadonlyArray<{ name: string; reason: string }>;
  /** Applicable tools already available (nothing to do). */
  readonly alreadyPresent: readonly string[];
  /** Tools n/a for this stack (skipped by the applicability gate). */
  readonly notApplicable: readonly string[];
}

/**
 * Install every MISSING applicable tool non-interactively and return a
 * structured outcome — the quiet core the init finishing-arc drives so it can
 * render its own progress UI. No logger chrome; emits progress via `onEvent`.
 * Reuses the ONE selection + exec path the interactive installer uses (Rule 2).
 */
export async function installMissingTools(
  targetPath: string,
  options: ToolsInstallOptions & { onEvent?: (e: ToolInstallEvent) => void } = {},
): Promise<ToolInstallOutcome> {
  const stack = detect(targetPath);
  const names = selectToolNames(stack.languages, options);
  const statuses = names
    .map((n) => (TOOL_DEFS[n] ? findTool(TOOL_DEFS[n]!, targetPath) : null))
    .filter((s): s is ToolStatus => s !== null);
  const missing = statuses.filter((s) => !s.available && s.source !== 'n/a');
  const alreadyPresent = statuses.filter((s) => s.available).map((s) => s.name);
  const notApplicable = statuses.filter((s) => s.source === 'n/a').map((s) => s.name);

  const installed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const s of missing) {
    options.onEvent?.({ name: s.name, phase: 'installing' });
    const resolved = resolveInstallCommand(targetPath, s.name);
    const r = execInstall(targetPath, resolved, { quiet: true });
    options.onEvent?.({ name: s.name, phase: r.status, detail: r.detail });
    if (r.status === 'installed') installed.push(s.name);
    else if (r.status === 'failed') failed.push({ name: s.name, reason: r.detail ?? 'error' });
    else skipped.push({ name: s.name, reason: r.detail ?? 'skipped' });
  }

  // Make every tool bin dir discoverable by name in later CI steps. No-op off CI.
  exportToolPathsToGithubEnv();
  return { installed, skipped, failed, alreadyPresent, notApplicable };
}
