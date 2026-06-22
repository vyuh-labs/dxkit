/**
 * `init --claude-loop` scaffolding — wires the loop pack into a repo
 * ADDITIVELY. None of these writers clobber a user's file:
 *
 *   - `.claude/settings.json`: deep-merge our Stop hook into `hooks.Stop[]`,
 *     preserving every existing hook / permission / key. Idempotent.
 *   - `CLAUDE.md`: upsert a sentinel-delimited managed block, never
 *     touching prose outside the markers. Idempotent.
 *   - `.dxkit/policy.json`: set `loop.preset`, preserving all other policy.
 *
 * Each writer reads the existing file, mutates the minimum, and writes
 * back; a malformed existing file is left untouched and surfaced as a
 * note rather than overwritten. This mirrors the additive `.gitignore`
 * installer (`ship-installers.ts:installIgnoreFiles`), extended to JSON +
 * a Markdown managed block.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ShipInstallResult } from '../ship-installers';
import { DEFAULT_LOOP_PRESET, type LoopPreset } from './policy';
import { dxkitCli } from '../self-invocation';

/** The command Claude Code runs on Stop. Built from the canonical CLI
 *  invocation (`src/self-invocation.ts`) so the installer, doctor, and any
 *  future tooling agree on the exact string and the loop Stop hook is a
 *  registered self-invocation surface (devDependency + doctor coverage). */
export const STOP_HOOK_COMMAND = dxkitCli('hook stop-gate');

/**
 * Timeout (seconds) for the installed Stop hook. Claude Code's default
 * hook timeout (60s) is too short for a cold first guardrail gather on a
 * large repo — especially in ref-based mode, where the comparison side is
 * scanned in a worktree — so the hook surfaces as a "Stop hook error" even
 * though it would have finished. The verdict + ref-scan caches make warm
 * gathers fast; this generous ceiling covers the cold case.
 */
export const STOP_HOOK_TIMEOUT_SECONDS = 600;

/** Sentinel markers bounding the dxkit-managed region of CLAUDE.md. Only
 *  the text between them is ever rewritten. */
const CLAUDE_BLOCK_START = '<!-- dxkit:loop:start -->';
const CLAUDE_BLOCK_END = '<!-- dxkit:loop:end -->';

/** Preset-agnostic loop norm. Points at `.dxkit/policy.json` as the
 *  source of truth for the active posture, so this prose stays correct
 *  when the preset is switched without re-running init. */
const CLAUDE_LOOP_NORM = `## Autonomous loop safety (dxkit)

This repo runs coding loops behind the dxkit Stop-gate: when an unattended
loop tries to stop, \`vyuh-dxkit hook stop-gate\` re-runs the guardrail and
blocks completion if the branch introduced net-new findings, handing them
back for repair. Loop norms:

- The gate runs only for UNATTENDED loops, so interactive sessions are not
  slowed. A headless loop (\`claude --dangerously-skip-permissions\`, i.e.
  \`permission_mode=bypassPermissions\`) auto-activates it — nothing to
  configure. For a hard guarantee (\`permission_mode\` is not on every event),
  export \`DXKIT_LOOP_ACTIVE=1\` or \`touch .dxkit/loop/active\` before
  launching the agent. Interactive work is covered by your review + CI.
- Fix the net-new finding the gate reports. Do NOT refresh the baseline to
  clear a block, and do NOT fix unrelated pre-existing debt — the gate
  only asks for what this branch introduced.
- The blocking posture is \`loop.preset\` in \`.dxkit/policy.json\`:
  \`security-only\` (default) blocks net-new secrets + crit/high security +
  reachable dependency vulns; \`full-debt\` also blocks test-gap + quality.
- \`vyuh-dxkit loop doctor\` verifies the loop is wired safely;
  \`vyuh-dxkit loop ledger summarize\` reports what the gate did.`;

interface LoopScaffoldOpts {
  /**
   * Explicit loop posture to write into `.dxkit/policy.json`. When set
   * (init with `--loop-preset`), it OVERRIDES any existing preset. When
   * omitted (bare init re-run, or update), an existing preset is PRESERVED
   * and `security-only` is seeded only if none exists — so an upgrade
   * never silently resets a user's chosen posture.
   */
  readonly preset?: LoopPreset;
}

interface StopHookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
interface ClaudeSettings {
  hooks?: { Stop?: StopHookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** True when `.claude/settings.json` already registers the Stop-gate. Used
 *  by `update`'s install-flag detection so an upgrade refreshes the loop
 *  surface only on repos that opted into it. */
export function isClaudeLoopInstalled(cwd: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return (parsed.hooks?.Stop ?? []).some((e) =>
      (e.hooks ?? []).some(
        (h) => typeof h.command === 'string' && /hook\s+stop-gate/.test(h.command),
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Merge the Stop hook into `.claude/settings.json`. Preserves all existing
 * settings; idempotent (no-op when our hook is already registered). A
 * malformed existing file is left intact and reported via `sidecars`.
 */
function mergeStopHook(cwd: string, result: ShipInstallResult): void {
  const rel = path.join('.claude', 'settings.json');
  const abs = path.join(cwd, rel);

  let settings: ClaudeSettings = {};
  let existed = false;
  if (fs.existsSync(abs)) {
    existed = true;
    try {
      settings = JSON.parse(fs.readFileSync(abs, 'utf8')) as ClaudeSettings;
    } catch {
      // Don't clobber a file we can't parse — drop a reference sidecar.
      const sidecar = rel + '.dxkit';
      fs.writeFileSync(
        path.join(cwd, sidecar),
        JSON.stringify({ hooks: { Stop: [stopEntry()] } }, null, 2) + '\n',
        'utf8',
      );
      result.sidecars.push(sidecar);
      result.notes.push(
        `${rel} is not valid JSON — left untouched. Merge the Stop hook from ${sidecar} by hand.`,
      );
      return;
    }
  }

  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const already = settings.hooks.Stop.some((e) =>
    (e.hooks ?? []).some(
      (h) => typeof h.command === 'string' && /hook\s+stop-gate/.test(h.command),
    ),
  );
  if (already) {
    result.skipped.push(rel);
    return;
  }
  settings.hooks.Stop.push(stopEntry());
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  result.installed.push(rel);
  if (existed) {
    result.notes.push(
      `Merged the Stop-gate hook into your existing ${rel} (other hooks preserved).`,
    );
  }
}

function stopEntry(): StopHookEntry {
  // Stop hooks take no matcher (unlike PreToolUse).
  return {
    hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: STOP_HOOK_TIMEOUT_SECONDS }],
  };
}

/**
 * Upsert the dxkit loop managed block in CLAUDE.md. Replaces the block
 * between the sentinels if present (idempotent), appends it otherwise, and
 * never touches content outside the markers.
 */
function upsertClaudeBlock(cwd: string, result: ShipInstallResult): void {
  const rel = 'CLAUDE.md';
  const abs = path.join(cwd, rel);
  const block = `${CLAUDE_BLOCK_START}\n${CLAUDE_LOOP_NORM}\n${CLAUDE_BLOCK_END}`;

  let existing = '';
  let existed = false;
  if (fs.existsSync(abs)) {
    existed = true;
    existing = fs.readFileSync(abs, 'utf8');
  }

  const startIdx = existing.indexOf(CLAUDE_BLOCK_START);
  const endIdx = existing.indexOf(CLAUDE_BLOCK_END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + CLAUDE_BLOCK_END.length);
    next = before + block + after;
    if (next === existing) {
      result.skipped.push(rel);
      return;
    }
  } else if (existed) {
    next = existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
  } else {
    next = `# CLAUDE.md\n\n${block}\n`;
  }
  fs.writeFileSync(abs, next, 'utf8');
  result.installed.push(rel);
  if (existed && startIdx === -1) {
    result.notes.push(
      `Appended a dxkit loop block to your existing ${rel} (your content preserved).`,
    );
  }
}

/**
 * Ensure `loop.preset` in `.dxkit/policy.json`, preserving all other
 * policy fields. `explicit` (init `--loop-preset`) overrides; otherwise an
 * existing preset is preserved and `security-only` is seeded only when
 * none exists. Idempotent; a malformed existing policy is reported, not
 * overwritten.
 */
function ensureLoopPreset(
  cwd: string,
  explicit: LoopPreset | undefined,
  result: ShipInstallResult,
): void {
  const rel = path.join('.dxkit', 'policy.json');
  const abs = path.join(cwd, rel);

  let policy: { loop?: { preset?: string }; [k: string]: unknown } = {};
  if (fs.existsSync(abs)) {
    try {
      policy = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      result.notes.push(`${rel} is not valid JSON — left untouched. Set loop.preset by hand.`);
      return;
    }
  }
  const existing = policy.loop?.preset;
  // Override on explicit; else keep existing; else seed the default.
  const target = explicit ?? existing ?? DEFAULT_LOOP_PRESET;
  if (existing === target) {
    result.skipped.push(rel);
    return;
  }
  policy.loop = { ...policy.loop, preset: target };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  result.installed.push(rel);
}

/**
 * Scaffold the loop pack into `cwd`. Additive + idempotent: safe to run on
 * a fresh repo or re-run on one that already has settings/CLAUDE.md/policy.
 */
export function installClaudeLoop(cwd: string, opts: LoopScaffoldOpts = {}): ShipInstallResult {
  const result: ShipInstallResult = { installed: [], skipped: [], sidecars: [], notes: [] };
  mergeStopHook(cwd, result);
  upsertClaudeBlock(cwd, result);
  ensureLoopPreset(cwd, opts.preset, result);
  return result;
}
