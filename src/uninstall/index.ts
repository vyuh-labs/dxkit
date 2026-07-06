/**
 * The uninstall engine — plan (pure, read-only) then execute. Its one job is to
 * restore the repo's PRE-DXKIT state: remove every file dxkit created, and
 * surgically reverse every additive merge dxkit made into a pre-existing user
 * file, without touching a byte the user owns.
 *
 * `planUninstall` reads the manifest (`.vyuh-dxkit.json`) + the install flags and
 * builds an ordered action list, marking any dxkit-created file the user has
 * since edited as `skip-modified` (surfaced, never clobbered). `executeUninstall`
 * applies a plan. The CLI wraps them with dry-run-by-default + confirmation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { sha256, serializePreservingJson } from '../files';
import { detectInstallFlags, type InstallFlags } from '../update';
import { managedGatedArtifacts } from '../managed-artifacts';
import { ALLOWLIST_FILENAME, ALLOWLIST_REASONS_FILENAME } from '../allowlist/file';
import type { Manifest } from '../types';
import {
  stripAllGitignoreBlocks,
  stripClaudeLoopBlock,
  stripSettingsDxkit,
  stripPackageJsonDxkit,
} from './reversals';

export type ActionKind =
  | 'delete-file'
  | 'delete-dir'
  | 'revert-gitignore'
  | 'revert-claude'
  | 'revert-settings'
  | 'revert-package'
  | 'git-config-unset';

export type ActionStatus = 'pending' | 'absent' | 'skip-modified';

export interface UninstallAction {
  readonly kind: ActionKind;
  /** Repo-relative path, or a symbolic target (`core.hooksPath`). */
  readonly target: string;
  readonly detail: string;
  readonly status: ActionStatus;
}

export interface UninstallPlan {
  readonly actions: readonly UninstallAction[];
  /** dxkit-created files the user edited — reported, skipped by default. */
  readonly warnings: readonly string[];
  readonly flags: InstallFlags;
  /** True when nothing dxkit-related was found at all. */
  readonly empty: boolean;
}

export interface UninstallOptions {
  /** Keep the curated, git-tracked artifacts (baselines/, allowlist, external/). */
  readonly keepBaselines?: boolean;
  /** Remove the @vyuhlabs/dxkit devDependency + postinstall from package.json. */
  readonly removeDevDependency?: boolean;
  /** Force-remove dxkit-created files the user edited (default: skip + warn). */
  readonly force?: boolean;
}

/** Files dxkit MERGES into (reverted, not deleted) — never delete-file these. */
const MERGE_TARGETS = new Set(['.gitignore', 'CLAUDE.md', '.claude/settings.json', 'package.json']);

/** Curated, intentionally git-tracked `.dxkit/` paths kept under --keep-baselines. */
const CURATED_DXKIT = ['baselines', ALLOWLIST_FILENAME, ALLOWLIST_REASONS_FILENAME, 'external'];

function readManifest(cwd: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.vyuh-dxkit.json'), 'utf-8')) as Manifest;
  } catch {
    return null;
  }
}

function exists(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

/** Node package names `tools install` recorded as dxkit-added devDeps — the set
 *  uninstall also strips from package.json (under --remove-devdep) so a
 *  dxkit-driven tool install doesn't outlive the uninstall. */
function nodeToolDeps(manifest: Manifest | null): string[] {
  return (manifest?.toolDeps ?? []).filter((d) => d.ecosystem === 'node').map((d) => d.package);
}

/** Build the ordered uninstall plan without touching the filesystem. */
export function planUninstall(cwd: string, opts: UninstallOptions = {}): UninstallPlan {
  const manifest = readManifest(cwd);
  const flags = manifest?.installFlags ?? detectInstallFlags(cwd);
  const actions: UninstallAction[] = [];
  const warnings: string[] = [];

  const del = (rel: string, detail: string, evolving = true, storedHash: string | null = null) => {
    if (!exists(cwd, rel)) {
      actions.push({ kind: 'delete-file', target: rel, detail, status: 'absent' });
      return;
    }
    // Hash-guard non-evolving dxkit files: a mismatch means the user edited a
    // dxkit-created file. Removing it still restores pre-dxkit state, but we
    // surface it and skip unless --force.
    if (!evolving && storedHash) {
      let current = '';
      try {
        current = sha256(fs.readFileSync(path.join(cwd, rel), 'utf-8'));
      } catch {
        /* unreadable → treat as present */
      }
      if (current && current !== storedHash && !opts.force) {
        warnings.push(`${rel} was edited after dxkit created it — skipped (use --force to remove)`);
        actions.push({ kind: 'delete-file', target: rel, detail, status: 'skip-modified' });
        return;
      }
    }
    actions.push({ kind: 'delete-file', target: rel, detail, status: 'pending' });
  };

  // 1. Additive-merge reversals (surgical — preserve user content). No-op when
  //    the marker is absent, so always safe to attempt.
  if (exists(cwd, '.gitignore') && stripAllGitignoreBlocks(read(cwd, '.gitignore')).changed) {
    actions.push({
      kind: 'revert-gitignore',
      target: '.gitignore',
      detail: 'strip dxkit runtime-output entries',
      status: 'pending',
    });
  }
  if (exists(cwd, 'CLAUDE.md')) {
    const claudeEntry = manifest?.files['CLAUDE.md'];
    // dxkit MADE the file only when it created it — a `skipped` entry means the
    // user's own CLAUDE.md that dxkit merely appended a loop block to. Legacy
    // manifests (no provenance) keep the pre-2.27 behavior of trusting the hash.
    const claudeMadeByDxkit = !!claudeEntry && claudeEntry.provenance !== 'skipped';
    const current = read(cwd, 'CLAUDE.md');
    const stripped = stripClaudeLoopBlock(current);
    if (claudeMadeByDxkit && claudeEntry!.hash && sha256(stripped.content) === claudeEntry!.hash) {
      // dxkit created the whole file, and stripping dxkit's own loop block leaves
      // exactly the recorded dxkit shim (no user edits) → remove the whole file
      // (pre-dxkit state had no CLAUDE.md).
      actions.push({
        kind: 'delete-file',
        target: 'CLAUDE.md',
        detail: 'dxkit-created Claude config',
        status: 'pending',
      });
    } else if (claudeMadeByDxkit && stripped.changed) {
      // dxkit created it but the user has since edited the shim → keep their
      // version, remove only dxkit's loop block; surface that we kept the file.
      actions.push({
        kind: 'revert-claude',
        target: 'CLAUDE.md',
        detail: 'strip the dxkit loop block (keeping your edits)',
        status: 'pending',
      });
      warnings.push(
        'CLAUDE.md was created by dxkit but you edited it — kept your version, removed only the loop block',
      );
    } else if (stripped.changed) {
      // The user's own pre-existing CLAUDE.md that dxkit only appended to
      // (no manifest entry, or a `skipped` one) — strip only the loop block.
      actions.push({
        kind: 'revert-claude',
        target: 'CLAUDE.md',
        detail: 'strip the dxkit loop block',
        status: 'pending',
      });
    }
  }
  if (exists(cwd, '.claude/settings.json')) {
    const parsed = tryJson(read(cwd, '.claude/settings.json'));
    const settingsEntry = manifest?.files['.claude/settings.json'];
    // Created only when dxkit wrote the whole file; a `skipped`/absent entry
    // means a pre-existing settings.json dxkit merged its hooks into → revert.
    const dxkitCreated = !!settingsEntry && settingsEntry.provenance !== 'skipped';
    if (parsed && stripSettingsDxkit(parsed, { dxkitCreated }).changed) {
      actions.push({
        kind: 'revert-settings',
        target: '.claude/settings.json',
        detail: 'remove dxkit hooks (context-hook / stop-gate)',
        status: 'pending',
      });
    }
  }
  if (opts.removeDevDependency && exists(cwd, 'package.json')) {
    const parsed = tryJson(read(cwd, 'package.json'));
    const tools = nodeToolDeps(manifest);
    if (parsed && stripPackageJsonDxkit(parsed, tools).changed) {
      const toolNote = tools.length ? ` + ${tools.length} tool devDep(s)` : '';
      actions.push({
        kind: 'revert-package',
        target: 'package.json',
        detail: `remove @vyuhlabs/dxkit devDependency + postinstall${toolNote}`,
        status: 'pending',
      });
    }
  }

  // 2. Delete generator-created files from the manifest (except merge targets).
  //    A `skipped` entry is a file that PRE-EXISTED dxkit — the user owns it, so
  //    it is never deleted (deleting it would be silent data loss; a --force
  //    that removed a project's own AGENTS.md is exactly the bug this guards).
  const recorded = new Set(Object.keys(manifest?.files ?? {}));
  for (const [rel, entry] of Object.entries(manifest?.files ?? {})) {
    if (MERGE_TARGETS.has(rel)) continue;
    if (entry.provenance === 'skipped') continue;
    del(rel, 'dxkit-created file', entry.evolving, entry.hash);
  }

  // 2b. Resilience sweep for `.claude/skills/dxkit-*`. A manifest written by an
  //     older dxkit (before skills were recorded) omits them, so the loop above
  //     misses them and the skills survive an uninstall — a repo that
  //     "uninstalled" dxkit still advertises its skills to every agent session.
  //     Every `dxkit-`-prefixed skill dir is unambiguously dxkit's, so remove
  //     any that the manifest did NOT already account for (recorded ones keep
  //     their hash-guarded per-file handling above + empty-dir pruning).
  const skillsRoot = '.claude/skills';
  if (exists(cwd, skillsRoot)) {
    for (const name of safeReaddir(path.join(cwd, skillsRoot))) {
      if (!name.startsWith('dxkit-')) continue;
      const dir = `${skillsRoot}/${name}`;
      if (!statIsDir(cwd, dir)) continue;
      if (recorded.has(`${dir}/SKILL.md`)) continue; // handled by the manifest loop
      actions.push({
        kind: 'delete-dir',
        target: dir,
        detail: 'dxkit skill (not recorded by an older manifest)',
        status: 'pending',
      });
    }
  }

  // 3. Delete gated ship-installer artifacts by flag / presence. The list is
  //    derived from the managed-artifact registry (the same source update and
  //    init read), so a surface can't be removed here yet forgotten by update.
  for (const rel of managedGatedArtifacts(flags)) {
    if (exists(cwd, rel)) del(rel, 'dxkit-installed artifact');
  }

  // 4. Runtime trees.
  if (exists(cwd, '.dxkit')) {
    if (opts.keepBaselines) {
      // Delete each top-level .dxkit entry except the curated ones.
      for (const name of safeReaddir(path.join(cwd, '.dxkit'))) {
        if (CURATED_DXKIT.includes(name)) continue;
        const rel = `.dxkit/${name}`;
        actions.push({
          kind: statIsDir(cwd, rel) ? 'delete-dir' : 'delete-file',
          target: rel,
          detail: 'dxkit runtime output',
          status: 'pending',
        });
      }
    } else {
      actions.push({
        kind: 'delete-dir',
        target: '.dxkit',
        detail: 'all dxkit state (baselines, reports, loop, policy)',
        status: 'pending',
      });
    }
  }
  if (exists(cwd, 'graphify-out')) {
    actions.push({
      kind: 'delete-dir',
      target: 'graphify-out',
      detail: 'graph analyzer output',
      status: 'pending',
    });
  }

  // 5. Unset the git hooksPath if dxkit pointed it at .githooks.
  if (flags.withHooks && gitHooksPath(cwd) === '.githooks') {
    actions.push({
      kind: 'git-config-unset',
      target: 'core.hooksPath',
      detail: 'unset core.hooksPath (was .githooks)',
      status: 'pending',
    });
  }

  // 6. The manifest itself — always last, and only when nothing was skipped.
  //    If we skipped a user-edited dxkit file, keep the manifest so a later
  //    `uninstall --force` can still find and remove it.
  if (exists(cwd, '.vyuh-dxkit.json')) {
    const hasSkips = actions.some((a) => a.status === 'skip-modified');
    actions.push({
      kind: 'delete-file',
      target: '.vyuh-dxkit.json',
      detail: hasSkips
        ? 'the dxkit install manifest (kept — edited files were skipped)'
        : 'the dxkit install manifest',
      status: hasSkips ? 'skip-modified' : 'pending',
    });
  }

  const empty = actions.every((a) => a.status === 'absent');
  return { actions, warnings, flags, empty };
}

export interface ExecuteResult {
  readonly removed: readonly string[];
  readonly reverted: readonly string[];
  readonly skipped: readonly string[];
}

/** Apply a plan. Only `pending` actions run; `absent`/`skip-modified` are recorded. */
export function executeUninstall(
  cwd: string,
  plan: UninstallPlan,
  opts: UninstallOptions = {},
): ExecuteResult {
  const removed: string[] = [];
  const reverted: string[] = [];
  const skipped: string[] = [];

  for (const a of plan.actions) {
    if (a.status !== 'pending') {
      if (a.status === 'skip-modified') skipped.push(a.target);
      continue;
    }
    const abs = path.join(cwd, a.target);
    switch (a.kind) {
      case 'delete-file':
        rm(abs);
        pruneEmptyParents(cwd, abs);
        removed.push(a.target);
        break;
      case 'delete-dir':
        fs.rmSync(abs, { recursive: true, force: true });
        pruneEmptyParents(cwd, abs);
        removed.push(a.target);
        break;
      case 'revert-gitignore': {
        const out = stripAllGitignoreBlocks(read(cwd, '.gitignore')).content;
        if (out === '') rm(abs);
        else fs.writeFileSync(abs, out, 'utf-8');
        reverted.push(a.target);
        break;
      }
      case 'revert-claude': {
        const out = stripClaudeLoopBlock(read(cwd, 'CLAUDE.md')).content;
        if (out === '') rm(abs);
        else fs.writeFileSync(abs, out, 'utf-8');
        reverted.push(a.target);
        break;
      }
      case 'revert-settings': {
        const original = read(cwd, '.claude/settings.json');
        const parsed = tryJson(original)!;
        const manifest = readManifest(cwd);
        const settingsEntry = manifest?.files['.claude/settings.json'];
        const dxkitCreated = !!settingsEntry && settingsEntry.provenance !== 'skipped';
        const { result, isDxkitOnly } = stripSettingsDxkit(parsed, { dxkitCreated });
        if (isDxkitOnly) {
          rm(abs);
          pruneEmptyParents(cwd, abs);
        } else {
          fs.writeFileSync(abs, serializePreservingJson(original, result), 'utf-8');
        }
        reverted.push(a.target);
        break;
      }
      case 'revert-package': {
        const original = read(cwd, 'package.json');
        const { result } = stripPackageJsonDxkit(
          tryJson(original)!,
          nodeToolDeps(readManifest(cwd)),
        );
        // Preserve the file's original indent + trailing-newline style so the
        // reverted file is byte-identical to its pre-dxkit content (git-clean).
        fs.writeFileSync(abs, serializePreservingJson(original, result), 'utf-8');
        reverted.push(a.target);
        break;
      }
      case 'git-config-unset':
        try {
          execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd, stdio: 'ignore' });
        } catch {
          /* best-effort */
        }
        reverted.push(a.target);
        break;
    }
  }
  void opts;
  return { removed, reverted, skipped };
}

// ─── small fs helpers ───────────────────────────────────────────────────────

function read(cwd: string, rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), 'utf-8');
}
function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function rm(abs: string): void {
  try {
    fs.rmSync(abs, { force: true });
  } catch {
    /* ignore */
  }
}
function statIsDir(cwd: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(cwd, rel)).isDirectory();
  } catch {
    return false;
  }
}
function safeReaddir(abs: string): string[] {
  try {
    return fs.readdirSync(abs);
  } catch {
    return [];
  }
}
function gitHooksPath(cwd: string): string | null {
  try {
    return (
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** After removing a file/dir, delete any now-empty ancestor directories up to
 *  (but not including) cwd — cleans up dxkit-only dir trees (.claude/skills, …)
 *  while leaving any dir that still holds user content. */
function pruneEmptyParents(cwd: string, abs: string): void {
  let dir = path.dirname(abs);
  const root = path.resolve(cwd);
  while (path.resolve(dir) !== root && path.resolve(dir).startsWith(root)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}
