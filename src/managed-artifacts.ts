/**
 * The managed ship-artifact registry — ONE source of truth for the optional
 * "ship surfaces" dxkit installs alongside the generator templates: CI
 * workflows, git hooks, the devcontainer, the loop pack, the dxkit
 * devDependency, and the ignore files.
 *
 * WHY THIS EXISTS (the recurring-bug fix, CLAUDE.md Rule 2 "one concept, one
 * code path"). These surfaces are NOT recorded in `manifest.files` (the
 * generator's per-file provenance covers only its own templates), so their
 * lifecycle was historically wired INDEPENDENTLY in four places — the init
 * flag-stamp, `detectInstallFlags` (update's legacy fallback), update's
 * refresh loop, and uninstall's `gatedArtifacts`. Nothing kept the four in
 * sync, and they drifted: the deep-SAST refresh workflow was installed and
 * uninstalled but never REFRESHED by update (it had no flag and no entry in
 * update's loop), and the uninstall test's artifact list fell out of step with
 * the real one. A new surface could silently skip update or uninstall.
 *
 * Now every surface is ONE `ManagedShipSurface` entry, and all three lifecycle
 * paths DERIVE from this list:
 *   - uninstall  → `managedGatedArtifacts()` (which files to remove)
 *   - update     → the `refreshOnUpdate` surfaces (which installers to re-run)
 *   - update's legacy fallback → `detectInstallFlags()` (which flags to infer
 *     from the workspace when a pre-2.5.2 manifest lacks `installFlags`)
 *
 * Adding a surface is a single registry entry; it cannot forget uninstall or
 * update. `test/managed-artifacts-playbook.test.ts` injects a synthetic
 * surface and asserts all three paths pick it up (mirror of
 * `recipe-playbook.test.ts` for language packs), and
 * `scripts/check-architecture.sh` bans raw workflow/hook/devcontainer writes
 * outside the registered installers.
 *
 * NOT in scope here: files dxkit MERGES into a pre-existing user file
 * (`.gitignore`, `package.json`, `.claude/settings.json`, `CLAUDE.md`). Those
 * are reverted (not deleted) by `src/uninstall/reversals.ts`, a separate and
 * already-centralized mechanism. A surface whose only footprint is such a merge
 * (the loop pack, the devDependency) carries an EMPTY `artifacts` list — it
 * still lives here so update refreshes it, but uninstall reverts it via the
 * reversal path, not a delete.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ManifestInstallFlags } from './types';
import {
  installCiBaselineRefresh,
  installCiDeepSastRefresh,
  installCiGraphRefresh,
  graphRefreshEnabled,
  installCiReportsRefresh,
  reportsRefreshEnabled,
  installCiFlowRefresh,
  installCiExtensionsRefresh,
  extensionsRefreshEnabled,
  flowRefreshEnabled,
  installCiGuardrails,
  installDevcontainer,
  installDxkitDevDependency,
  installHooks,
  installHooksPostinstall,
  installIgnoreFiles,
  installPrReview,
  type ShipInstallResult,
} from './ship-installers';
import { installClaudeLoop, isClaudeLoopInstalled } from './loop/scaffold';
import { requiresResolvableCli } from './self-invocation';

/** The `ManifestInstallFlags` keys that map 1:1 to a gated ship surface. */
type PrimaryFlag =
  | 'withHooks'
  | 'withDevcontainer'
  | 'withCiGuardrails'
  | 'withBaselineRefresh'
  | 'withPrReview'
  | 'withDeepSastRefresh'
  | 'withGraphRefresh'
  | 'withReportsRefresh'
  | 'withFlowRefresh'
  | 'withExtensionsRefresh'
  | 'withClaudeLoop';

/**
 * How a surface's install is gated:
 *   - `flag`    — a single `ManifestInstallFlags` key (the common case).
 *   - `always`  — installed on every repo, no flag (the ignore files).
 *   - `derived` — a computed predicate over the flags (the devDependency,
 *                 gated by `requiresResolvableCli` over several flags).
 */
type SurfaceGate =
  | { readonly kind: 'flag'; readonly flag: PrimaryFlag }
  | { readonly kind: 'always' }
  | { readonly kind: 'derived'; readonly enabled: (flags: ManifestInstallFlags) => boolean };

/**
 * How uninstall decides to remove a surface's artifacts:
 *   - `flag`     — remove when the gate is enabled (the default; a user file
 *                  that merely shares a dxkit path name is never touched).
 *   - `presence` — remove whenever the artifact exists on disk, regardless of
 *                  flag. Reserved for the deep-SAST workflow, whose flag
 *                  postdates its ship: legacy installs recorded no flag for it,
 *                  and its `dxkit-`-prefixed filename makes a user-owned
 *                  collision implausible (same rationale as the `dxkit-*`
 *                  skills sweep in uninstall).
 */
type UninstallDetection = 'flag' | 'presence';

export interface SurfaceInstallContext {
  readonly force: boolean;
  readonly flags: ManifestInstallFlags;
}

export interface ManagedShipSurface {
  /** Stable id (diagnostics + the playbook test). */
  readonly id: string;
  readonly gate: SurfaceGate;
  /**
   * Repo-relative paths uninstall DELETES when this surface is active. Empty
   * for merge-only surfaces (the loop pack, the devDependency), whose removal
   * is a reversal handled elsewhere.
   */
  readonly artifacts: (flags: ManifestInstallFlags) => readonly string[];
  readonly uninstallDetection: UninstallDetection;
  /** Whether `update` re-runs the installer to pick up template changes. */
  readonly refreshOnUpdate: boolean;
  /** Re-run the installer (used by update). Returns a merged ship result. */
  readonly install: (cwd: string, ctx: SurfaceInstallContext) => ShipInstallResult;
  /**
   * Workspace-presence probe for the legacy fallback (`detectInstallFlags`) —
   * present only for `flag`-gated surfaces (there is nothing to infer for
   * `always` / `derived` surfaces). Sets `flags[gate.flag] = present(cwd)`.
   */
  readonly detectPresent?: (cwd: string) => boolean;
}

function existsRel(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

/** Combine two ship results (installed/skipped/sidecars/notes) into one. */
function mergeResults(a: ShipInstallResult, b: ShipInstallResult): ShipInstallResult {
  return {
    installed: [...a.installed, ...b.installed],
    skipped: [...a.skipped, ...b.skipped],
    sidecars: [...a.sidecars, ...b.sidecars],
    notes: [...a.notes, ...b.notes],
  };
}

/**
 * THE registry. Order is the update-refresh order (kept close to the historical
 * order so the update summary reads the same). Every consumer iterates this.
 */
export const MANAGED_SHIP_SURFACES: readonly ManagedShipSurface[] = [
  {
    id: 'devcontainer',
    gate: { kind: 'flag', flag: 'withDevcontainer' },
    artifacts: () => [
      '.devcontainer/devcontainer.json',
      '.devcontainer/post-create.sh',
      '.devcontainer/install-agent-clis.sh',
    ],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installDevcontainer(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.devcontainer/devcontainer.json'),
  },
  {
    id: 'hooks',
    gate: { kind: 'flag', flag: 'withHooks' },
    // pre-commit is a sub-flag (`withPrecommit`) of the hooks surface — it ships
    // only when the user opted into it. The postinstall chain lands in
    // package.json (a merge, reverted elsewhere) and core.hooksPath is a git
    // config (unset elsewhere), so neither appears here.
    artifacts: (flags) => [
      '.githooks/pre-push',
      ...(flags.withPrecommit ? ['.githooks/pre-commit'] : []),
    ],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force, flags }) =>
      mergeResults(
        installHooks(cwd, { force, withPrecommit: flags.withPrecommit }),
        installHooksPostinstall(cwd, { force }),
      ),
    detectPresent: (cwd) => existsRel(cwd, '.githooks/pre-push'),
  },
  {
    id: 'ci-guardrails',
    gate: { kind: 'flag', flag: 'withCiGuardrails' },
    artifacts: () => ['.github/workflows/dxkit-guardrails.yml'],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force, flags }) =>
      installCiGuardrails(cwd, { force, pushTrigger: !!flags.withCiPushTrigger }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-guardrails.yml'),
  },
  {
    // Self-heal a missing project-local devDependency on upgrade: the set of
    // self-invocation surfaces that IMPLY a resolvable CLI is derived from the
    // one registry in self-invocation.ts (never a hand-maintained flag chain).
    // Merge-only footprint (package.json devDep + postinstall) → no delete
    // artifacts; uninstall strips it under --remove-devdep via the reversal.
    id: 'dxkit-dev-dependency',
    gate: {
      kind: 'derived',
      enabled: (flags) =>
        requiresResolvableCli({
          claudeSettings: flags.withDxkitAgents,
          claudeLoop: flags.withClaudeLoop,
          gitHooks: flags.withHooks,
          ciGuardrails: flags.withCiGuardrails,
        }),
    },
    artifacts: () => [],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installDxkitDevDependency(cwd, { force }),
  },
  {
    id: 'ci-baseline-refresh',
    gate: { kind: 'flag', flag: 'withBaselineRefresh' },
    artifacts: () => ['.github/workflows/dxkit-baseline-refresh.yml'],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiBaselineRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-baseline-refresh.yml'),
  },
  {
    id: 'pr-review',
    gate: { kind: 'flag', flag: 'withPrReview' },
    artifacts: () => ['.github/workflows/pr-review.yml'],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installPrReview(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/pr-review.yml'),
  },
  {
    // Deep-SAST refresh (Snyk/CodeQL ingest). It shipped WITHOUT a flag, so
    // update never refreshed it and uninstall removed it by presence — the
    // exact drift this registry closes. It now carries `withDeepSastRefresh`
    // (so update refreshes it) while keeping `presence` uninstall detection so
    // installs made before the flag existed are still cleaned up.
    id: 'ci-deep-sast-refresh',
    gate: { kind: 'flag', flag: 'withDeepSastRefresh' },
    artifacts: () => ['.github/workflows/dxkit-deep-sast-refresh.yml'],
    uninstallDetection: 'presence',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiDeepSastRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-deep-sast-refresh.yml'),
  },
  {
    // Graph-refresh (#119): rebuild + cache graph.json on merge to the default
    // branch (Actions-cache transport — never git, so no repo bloat). Opt-in via
    // `.dxkit/policy.json:graph.refresh: "cache"`; the flag is stamped from that
    // policy at init. Presence uninstall detection (the `dxkit-graph-refresh.yml`
    // filename) cleans up installs made before the flag was stamped.
    id: 'ci-graph-refresh',
    gate: { kind: 'flag', flag: 'withGraphRefresh' },
    artifacts: () => ['.github/workflows/dxkit-graph-refresh.yml'],
    uninstallDetection: 'presence',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiGraphRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-graph-refresh.yml'),
  },
  {
    // On-merge report snapshots (opt-in via policy.json:reports.onMerge).
    // Presence uninstall detection cleans up installs made before the flag was
    // stamped, same as graph-refresh.
    id: 'ci-reports-refresh',
    gate: { kind: 'flag', flag: 'withReportsRefresh' },
    artifacts: () => ['.github/workflows/dxkit-reports-refresh.yml'],
    uninstallDetection: 'presence',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiReportsRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-reports-refresh.yml'),
  },
  {
    // On-merge extension-snapshot refresh (keep committed extension
    // snapshots current). Opt-in via --with-extensions-refresh, or
    // automatically when a committed manifest declares refresh: on-merge;
    // presence uninstall detection mirrors flow-refresh.
    id: 'ci-extensions-refresh',
    gate: { kind: 'flag', flag: 'withExtensionsRefresh' },
    artifacts: () => ['.github/workflows/dxkit-extensions-refresh.yml'],
    uninstallDetection: 'presence',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiExtensionsRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-extensions-refresh.yml'),
  },
  {
    // On-merge flow-contract refresh (task: keep committed served/consumed
    // snapshots current). Opt-in via policy flow.onMergeRefresh; presence
    // uninstall detection mirrors reports-refresh.
    id: 'ci-flow-refresh',
    gate: { kind: 'flag', flag: 'withFlowRefresh' },
    artifacts: () => ['.github/workflows/dxkit-flow-refresh.yml'],
    uninstallDetection: 'presence',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installCiFlowRefresh(cwd, { force }),
    detectPresent: (cwd) => existsRel(cwd, '.github/workflows/dxkit-flow-refresh.yml'),
  },
  {
    // Loop pack: Stop-gate hook in .claude/settings.json + a CLAUDE.md loop
    // block + a policy.json preset — all merges into user files, reverted
    // elsewhere, so no delete artifacts. Present here so update refreshes the
    // loop-norm prose.
    id: 'claude-loop',
    gate: { kind: 'flag', flag: 'withClaudeLoop' },
    artifacts: () => [],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd) => installClaudeLoop(cwd),
    detectPresent: (cwd) => isClaudeLoopInstalled(cwd),
  },
  {
    // Ignore files: always installed. `.dxkit-ignore` is a dxkit-owned file
    // (deleted on uninstall); `.gitignore` is a merge (reverted elsewhere), so
    // only `.dxkit-ignore` appears as a delete artifact.
    id: 'ignore-files',
    gate: { kind: 'always' },
    artifacts: () => ['.dxkit-ignore'],
    uninstallDetection: 'flag',
    refreshOnUpdate: true,
    install: (cwd, { force }) => installIgnoreFiles(cwd, { force }),
  },
];

/** Whether an already-installed guardrails workflow carries the opt-in `push:`
 *  trigger, so update's workspace-fallback path preserves it. */
function guardrailsHasPushTrigger(cwd: string): boolean {
  try {
    const wf = fs.readFileSync(
      path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml'),
      'utf8',
    );
    return /^\s*push:/m.test(wf);
  } catch {
    return false;
  }
}

/**
 * Workspace-derived flag detection — the fallback when a manifest doesn't carry
 * `installFlags` (pre-2.5.2 manifests) or is partial. The gated ship surfaces
 * are inferred from the registry (`detectPresent`); the non-surface flags
 * (`withDxkitAgents` is generator-driven, `withPrecommit` / `withCiPushTrigger`
 * are modifiers) are probed directly.
 *
 * False-positive risk is bounded — the installers are idempotent and emit
 * sidecars on conflict, so spurious detection can't clobber user state.
 */
export function detectInstallFlags(cwd: string): ManifestInstallFlags {
  const flags: ManifestInstallFlags = {
    withDxkitAgents: existsRel(cwd, path.join('.claude', 'skills', 'dxkit-learn')),
    withHooks: false,
    withPrecommit: existsRel(cwd, path.join('.githooks', 'pre-commit')),
    withDevcontainer: false,
    withCiGuardrails: false,
    withBaselineRefresh: false,
    withPrReview: false,
    withClaudeLoop: false,
    withCiPushTrigger: guardrailsHasPushTrigger(cwd),
    withDeepSastRefresh: false,
    withGraphRefresh: false,
    withReportsRefresh: false,
    withFlowRefresh: false,
    withExtensionsRefresh: false,
  };
  for (const surface of MANAGED_SHIP_SURFACES) {
    if (surface.gate.kind === 'flag' && surface.detectPresent) {
      flags[surface.gate.flag] = surface.detectPresent(cwd);
    }
  }
  // Graph-refresh is opt-in via policy, so a repo that set `graph.refresh:
  // "cache"` but hasn't installed the workflow yet must still be treated as
  // enabled — otherwise `update` would never lay it down. Presence OR policy.
  flags.withGraphRefresh = flags.withGraphRefresh || graphRefreshEnabled(cwd);
  flags.withReportsRefresh = flags.withReportsRefresh || reportsRefreshEnabled(cwd);
  flags.withFlowRefresh = flags.withFlowRefresh || flowRefreshEnabled(cwd);
  flags.withExtensionsRefresh = flags.withExtensionsRefresh || extensionsRefreshEnabled(cwd);
  return flags;
}

/** Whether a surface is active for the given flags. */
export function surfaceEnabled(surface: ManagedShipSurface, flags: ManifestInstallFlags): boolean {
  switch (surface.gate.kind) {
    case 'flag':
      return flags[surface.gate.flag] === true;
    case 'always':
      return true;
    case 'derived':
      return surface.gate.enabled(flags);
  }
}

/**
 * Every ship-installer artifact uninstall should DELETE, given the resolved
 * install flags. Merge-only surfaces contribute nothing (reverted elsewhere);
 * `presence`-detected surfaces contribute unconditionally (the caller guards
 * each path with an existence check before removing). Replaces the hand-kept
 * `gatedArtifacts` list in uninstall.
 */
export function managedGatedArtifacts(
  flags: ManifestInstallFlags,
  surfaces: readonly ManagedShipSurface[] = MANAGED_SHIP_SURFACES,
): string[] {
  const out: string[] = [];
  for (const surface of surfaces) {
    const active = surface.uninstallDetection === 'presence' || surfaceEnabled(surface, flags);
    if (active) out.push(...surface.artifacts(flags));
  }
  return out;
}

/**
 * Re-run every `refreshOnUpdate` surface active for these flags, in registry
 * order, merging each result via `onResult`. Replaces the hand-maintained
 * if-chain in `runUpdate`.
 */
export function refreshManagedSurfaces(
  cwd: string,
  ctx: SurfaceInstallContext,
  onResult: (result: ShipInstallResult) => void,
  surfaces: readonly ManagedShipSurface[] = MANAGED_SHIP_SURFACES,
): void {
  for (const surface of surfaces) {
    if (surface.refreshOnUpdate && surfaceEnabled(surface, ctx.flags)) {
      onResult(surface.install(cwd, ctx));
    }
  }
}
