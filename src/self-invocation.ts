/**
 * Self-invocation — the ONE place that knows how dxkit's own generated
 * artifacts call the dxkit CLI, and which of those artifacts auto-execute
 * it at runtime.
 *
 * Several things dxkit installs shell out to the dxkit CLI after install:
 * the loop Stop hook, the `.claude` PreToolUse `context-hook`, the git
 * pre-push guardrail hook, and the CI guardrail workflow. Every one of
 * them only works if `vyuh-dxkit` actually resolves in the user's
 * environment (a project-local devDependency or a global install). When it
 * does not, the invocation `npx vyuh-dxkit …` 404s — `vyuh-dxkit` is a
 * binary name, not a package — and the surface fails on every fire.
 *
 * Two facts used to live as scattered string literals and hand-maintained
 * `wantHooks || wantCi` conditionals, so a new surface (the loop Stop
 * hook) was added without being taught to either — it shipped 404-ing on
 * pure-npx installs. This module makes both facts derive from ONE list:
 *
 *   1. The canonical invocation string (`DXKIT_CLI` / `dxkitCli`).
 *   2. The registry of self-invoking surfaces (`SELF_INVOCATION_SURFACES`),
 *      from which `requiresResolvableCli` (the install/update devDependency
 *      decision) and the doctor resolvability checks are derived.
 *
 * Adding a surface is a one-line registry entry; it cannot silently forget
 * the devDependency wire-up or the doctor check. Enforced by
 * `scripts/check-architecture.sh` (no raw `npx vyuh-dxkit` literal in
 * `src/` outside this file) and `test/self-invocation-playbook.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * The canonical way a generated artifact invokes the dxkit CLI. Resolves
 * to a project-local `./node_modules/.bin/vyuh-dxkit` (when dxkit is a
 * devDependency) or a global install; both are what `requiresResolvableCli`
 * + the install flow guarantee for any active self-invocation surface.
 */
export const DXKIT_CLI = 'npx vyuh-dxkit'; // self-invocation-ok

/** Build a CLI invocation string. `dxkitCli('hook stop-gate')` →
 *  `'npx vyuh-dxkit hook stop-gate'`; `dxkitCli()` → `'npx vyuh-dxkit'`. */
export function dxkitCli(subcommand = ''): string {
  return subcommand ? `${DXKIT_CLI} ${subcommand}` : DXKIT_CLI;
}

/**
 * The cwd-anchored form for a `.claude/settings.json` hook command
 * (`context-hook`, the loop Stop-gate). A Claude Code hook runs with the
 * AGENT'S current working directory, which can be any subdirectory the
 * agent's shell has `cd`-ed into — not necessarily the repo root. A bare
 * `npx vyuh-dxkit …` then analyzes whatever subtree the shell happens to
 * sit in (wrong graph, wrong diff), and any relative script path in a hook
 * fails outright with MODULE_NOT_FOUND. Claude Code exports
 * `$CLAUDE_PROJECT_DIR` (the project root) into every hook's environment,
 * so anchor there before invoking; `${...:-.}` keeps a stray non-Claude
 * invocation a harmless no-op cd (stay put), preserving old behavior.
 *
 * This is the ONLY self-invocation surface that needs the anchor — the git
 * pre-push hook already runs from the worktree root and the CI workflow
 * from the checkout root, so those keep the plain `dxkitCli` form.
 */
export function claudeHookCommand(subcommand: string): string {
  return `cd "\${CLAUDE_PROJECT_DIR:-.}" && ${dxkitCli(subcommand)}`;
}

/**
 * The install-time decisions that determine which self-invocation surfaces
 * a given `init`/`update` run actually writes. Each surface maps itself to
 * one of these via `installedWhen`.
 */
export interface SurfaceFlags {
  /** `.claude/settings.json` is written (carries the PreToolUse
   *  `context-hook`) — true on every `init` that scaffolds `.claude`. */
  readonly claudeSettings?: boolean;
  /** The loop pack (Stop hook) is installed (`init --claude-loop`). */
  readonly claudeLoop?: boolean;
  /** The git pre-push guardrail hook is installed (`--with-hooks`). */
  readonly gitHooks?: boolean;
  /** The CI guardrail workflow is installed (`--with-ci`). */
  readonly ciGuardrails?: boolean;
}

/** One artifact that auto-executes the dxkit CLI after install. */
export interface SelfInvocationSurface {
  /** Stable id (used in tests + audit output). */
  readonly id: string;
  /** Human-readable description of the artifact. */
  readonly description: string;
  /** The CLI subcommand it invokes (for audit; the body itself is built
   *  with `dxkitCli` at the surface's own site). */
  readonly invokes: string;
  /** True when this surface is installed for the given flags. */
  installedWhen(flags: SurfaceFlags): boolean;
}

/**
 * Every dxkit-installed artifact that shells out to the dxkit CLI at
 * runtime. The single source of truth for the devDependency decision and
 * the doctor resolvability checks. Add new auto-running surfaces here.
 */
export const SELF_INVOCATION_SURFACES: readonly SelfInvocationSurface[] = [
  {
    id: 'context-hook',
    description: '.claude/settings.json PreToolUse hook (passive graph context)',
    invokes: 'context-hook',
    installedWhen: (f) => !!f.claudeSettings,
  },
  {
    id: 'loop-stop-gate-hook',
    description: '.claude/settings.json Stop hook (loop pack guardrail gate)',
    invokes: 'hook stop-gate',
    installedWhen: (f) => !!f.claudeLoop,
  },
  {
    id: 'pre-push-guardrail-hook',
    description: '.githooks/pre-push guardrail check',
    invokes: 'guardrail check',
    installedWhen: (f) => !!f.gitHooks,
  },
  {
    id: 'ci-guardrail-workflow',
    description: '.github/workflows/dxkit-guardrails.yml guardrail check',
    invokes: 'guardrail check',
    installedWhen: (f) => !!f.ciGuardrails,
  },
];

/**
 * The surfaces active for a given install decision. `registry` is injectable
 * (defaults to the canonical list) so the playbook test can prove a newly
 * registered surface flows through `requiresResolvableCli` without the
 * function having to hardcode the set — the same registry-as-argument seam
 * `runProducers` uses.
 */
export function activeSelfInvocationSurfaces(
  flags: SurfaceFlags,
  registry: readonly SelfInvocationSurface[] = SELF_INVOCATION_SURFACES,
): SelfInvocationSurface[] {
  return registry.filter((s) => s.installedWhen(flags));
}

/**
 * Does this install need a project-local (or global) dxkit so its
 * generated artifacts can run? True when ANY self-invocation surface is
 * active. Replaces the hand-maintained `wantHooks || wantCi` conditional in
 * both `cli.ts` (init) and `update.ts`.
 */
export function requiresResolvableCli(
  flags: SurfaceFlags,
  registry: readonly SelfInvocationSurface[] = SELF_INVOCATION_SURFACES,
): boolean {
  return activeSelfInvocationSurfaces(flags, registry).length > 0;
}

/** Where a runtime `vyuh-dxkit` invocation resolves from, if anywhere. */
export type CliResolution =
  | { readonly ok: true; readonly how: 'local' | 'global' }
  | { readonly ok: false; readonly how: 'none' };

/**
 * Does `vyuh-dxkit` actually resolve in `cwd` right now? Mirrors how the
 * generated artifacts resolve it: a project-local `./node_modules/.bin`
 * binary first, then a global one on PATH. This is the runtime truth the
 * doctor checks — a surface can be registered (settings.json written) yet
 * still 404 at fire time if the devDependency was declared but never
 * `npm install`-ed, or the repo is non-Node with no global install.
 */
export function resolveDxkitCli(cwd: string): CliResolution {
  const isWin = process.platform === 'win32';
  const localBin = path.join(cwd, 'node_modules', '.bin', isWin ? 'vyuh-dxkit.cmd' : 'vyuh-dxkit');
  if (fs.existsSync(localBin)) return { ok: true, how: 'local' };
  try {
    execFileSync(isWin ? 'where' : 'which', ['vyuh-dxkit'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, how: 'global' };
  } catch {
    return { ok: false, how: 'none' };
  }
}
