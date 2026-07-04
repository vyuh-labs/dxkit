/**
 * Pure reversals for dxkit's additive merges — the inverse of each installer's
 * merge into a PRE-EXISTING user file. Each takes the current file content and
 * returns the content with ONLY dxkit's additions removed, preserving the
 * user's own lines/keys byte-for-byte. These are the load-bearing functions for
 * the uninstall feature's primary guarantee: restore the pre-dxkit state.
 *
 * The markers are imported from the installer modules (not re-declared), so a
 * marker change breaks install and uninstall together (recipe symmetry).
 */

import { GITIGNORE_HEADER, POSTINSTALL_CMD, DXKIT_PACKAGE } from '../ship-installers';
import { CLAUDE_BLOCK_START, CLAUDE_BLOCK_END } from '../loop/scaffold';

/** Result of a reversal: the new content and whether anything was removed.
 *  `content: null` means "the file is now empty of everything but dxkit's own
 *  content — the caller may delete it" (used when dxkit created the file). */
export interface ReversalResult {
  readonly changed: boolean;
  readonly content: string;
}

// ─── .gitignore ─────────────────────────────────────────────────────────────

/** Stealth-mode header (mirrors `STEALTH_HEADER` in cli.ts; kept as a literal
 *  here to avoid importing the CLI entry module). */
export const STEALTH_HEADER = '# dxkit (stealth mode — local only, not committed)';

/**
 * Remove a dxkit block from `.gitignore`. The installer writes each block as
 * `\n<HEADER>\n<entries…>\n` (a header line followed by its entries, up to the
 * next blank line or EOF). We strip from the header line through the run of
 * non-blank lines that follows it, leaving every other line — including the
 * user's own entries — untouched.
 */
export function stripGitignoreBlock(content: string, header: string): ReversalResult {
  const lines = content.split('\n');
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      changed = true;
      // Skip the header and the contiguous non-blank entry lines under it.
      i++;
      while (i < lines.length && lines[i].trim() !== '') i++;
      // `i` now points at the blank line (or EOF); the for-loop's i++ consumes
      // that blank separator so we don't leave a double blank behind.
      continue;
    }
    out.push(lines[i]);
  }
  if (!changed) return { changed: false, content };
  // Collapse a leading blank the block may have left, and trailing blanks.
  let result = out
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
  if (result.trim() === '') result = '';
  return { changed: true, content: result };
}

/** Strip both the runtime-outputs block and the stealth block from `.gitignore`. */
export function stripAllGitignoreBlocks(content: string): ReversalResult {
  const a = stripGitignoreBlock(content, GITIGNORE_HEADER);
  const b = stripGitignoreBlock(a.content, STEALTH_HEADER);
  return { changed: a.changed || b.changed, content: b.content };
}

// ─── CLAUDE.md (loop block) ─────────────────────────────────────────────────

/**
 * Remove the dxkit loop block delimited by `<!-- dxkit:loop:start -->` …
 * `<!-- dxkit:loop:end -->` from `CLAUDE.md`, including the sentinels and the
 * surrounding blank lines the installer added. Everything else is preserved.
 */
export function stripClaudeLoopBlock(content: string): ReversalResult {
  const start = content.indexOf(CLAUDE_BLOCK_START);
  const end = content.indexOf(CLAUDE_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return { changed: false, content };
  const before = content.slice(0, start);
  const after = content.slice(end + CLAUDE_BLOCK_END.length);
  // Join, collapsing the blank lines the block was fenced with.
  let result = (before.replace(/\n+$/, '') + '\n' + after.replace(/^\n+/, '')).trim();
  result = result === '' ? '' : result + '\n';
  return { changed: true, content: result };
}

// ─── .claude/settings.json ──────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

/**
 * Remove dxkit's contributions from a parsed `settings.json`:
 *   - the Stop hook whose command invokes `hook stop-gate` (loop gate),
 *   - the PreToolUse hook whose command invokes `context-hook` (passive graph).
 * Empty `hooks.Stop` / `hooks.PreToolUse` arrays and an empty `hooks` object are
 * pruned. The user's other hooks, permissions, and keys are preserved.
 *
 * `dxkitCreated` (the file is in the manifest) additionally strips the
 * dxkit-authored permission block and reports `content: '{}'`-equivalent
 * emptiness via `isDxkitOnly` so the caller can delete the file outright.
 */
export function stripSettingsDxkit(
  parsed: JsonRecord,
  opts: { dxkitCreated: boolean } = { dxkitCreated: false },
): { changed: boolean; result: JsonRecord; isDxkitOnly: boolean } {
  let changed = false;
  const obj: JsonRecord = { ...parsed };

  const hooks = obj.hooks as JsonRecord | undefined;
  if (hooks && typeof hooks === 'object') {
    const nextHooks: JsonRecord = { ...hooks };
    for (const [event, matchRe] of [
      ['Stop', /hook\s+stop-gate/],
      ['PreToolUse', /context-hook/],
    ] as const) {
      const arr = nextHooks[event];
      if (Array.isArray(arr)) {
        const kept = arr.filter((entry) => !entryInvokes(entry, matchRe));
        if (kept.length !== arr.length) changed = true;
        if (kept.length === 0) delete nextHooks[event];
        else nextHooks[event] = kept;
      }
    }
    if (Object.keys(nextHooks).length === 0) delete obj.hooks;
    else obj.hooks = nextHooks;
  }

  // When dxkit created the file, its permission block + $schema are dxkit's too.
  // Drop them so the emptiness check can decide the file is deletable.
  if (opts.dxkitCreated) {
    if ('permissions' in obj) {
      delete obj.permissions;
      changed = true;
    }
    if ('$schema' in obj) delete obj.$schema;
  }

  const isDxkitOnly = Object.keys(obj).length === 0;
  return { changed, result: obj, isDxkitOnly };
}

/** Does a hook-group entry (`{matcher?, hooks:[{command}]}` or `{command}`)
 *  invoke a command matching `re`? */
function entryInvokes(entry: unknown, re: RegExp): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as JsonRecord;
  if (typeof e.command === 'string' && re.test(e.command)) return true;
  if (Array.isArray(e.hooks)) {
    return e.hooks.some(
      (h) =>
        h &&
        typeof h === 'object' &&
        typeof (h as JsonRecord).command === 'string' &&
        re.test((h as JsonRecord).command as string),
    );
  }
  return false;
}

// ─── package.json ───────────────────────────────────────────────────────────

/**
 * Remove dxkit's contributions from a parsed `package.json`:
 *   - the `@vyuhlabs/dxkit` devDependency,
 *   - the `vyuh-dxkit hooks activate` postinstall (trimming a chained ` && …`
 *     suffix, or dropping the whole `postinstall` key when it was the sole cmd).
 * Nothing else is touched. Returns which pieces were removed for reporting.
 */
export function stripPackageJsonDxkit(parsed: JsonRecord): {
  changed: boolean;
  result: JsonRecord;
  removedDevDep: boolean;
  removedPostinstall: boolean;
} {
  const obj: JsonRecord = { ...parsed };
  let removedDevDep = false;
  let removedPostinstall = false;

  const dev = obj.devDependencies as JsonRecord | undefined;
  if (dev && typeof dev === 'object' && DXKIT_PACKAGE in dev) {
    const nextDev = { ...dev };
    delete nextDev[DXKIT_PACKAGE];
    removedDevDep = true;
    if (Object.keys(nextDev).length === 0) delete obj.devDependencies;
    else obj.devDependencies = nextDev;
  }

  const scripts = obj.scripts as JsonRecord | undefined;
  if (scripts && typeof scripts === 'object' && typeof scripts.postinstall === 'string') {
    const cmd = scripts.postinstall;
    if (cmd.includes(POSTINSTALL_CMD)) {
      const nextScripts = { ...scripts };
      const trimmed = cmd
        .replace(new RegExp(`\\s*&&\\s*${escapeRe(POSTINSTALL_CMD)}`), '') // chained suffix
        .replace(new RegExp(`${escapeRe(POSTINSTALL_CMD)}\\s*&&\\s*`), '') // chained prefix
        .trim();
      if (trimmed === '' || trimmed === POSTINSTALL_CMD) delete nextScripts.postinstall;
      else nextScripts.postinstall = trimmed;
      if (Object.keys(nextScripts).length === 0) delete obj.scripts;
      else obj.scripts = nextScripts;
      removedPostinstall = true;
    }
  }

  return {
    changed: removedDevDep || removedPostinstall,
    result: obj,
    removedDevDep,
    removedPostinstall,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
