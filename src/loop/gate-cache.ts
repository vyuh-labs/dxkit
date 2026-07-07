/**
 * Loop Stop-gate: activation + caching helpers.
 *
 * Extracted from `stop-gate.ts` so the hook body stays focused on the gate
 * decision. Three cohesive concerns live here:
 *
 *   - `loopGateActive` — is this an unattended run that should be gated at all?
 *   - `workingTreeSignature` — a content-complete hash of the tree the gather
 *     would see, so an unchanged tree can replay the last verdict.
 *   - the verdict cache (`readStateCache` / `writeStateCache`).
 */
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LEDGER_DIR } from './ledger';

/** Permission modes that mean "running unattended", so the gate
 *  auto-activates. `bypassPermissions` is what `--dangerously-skip-permissions`
 *  and `--permission-mode bypassPermissions` (the canonical headless-loop
 *  flags) resolve to; an interactive session never bypasses all permissions. */
const UNATTENDED_PERMISSION_MODES = new Set(['bypassPermissions']);

/**
 * Whether this Stop should be gated. The Stop-gate exists for unattended
 * loops; interactive turns must not pay the guardrail cost. A run counts as
 * unattended when ANY of these hold:
 *
 *   1. Claude Code reports an unattended `permission_mode` on the hook
 *      payload (`bypassPermissions`) — the zero-config common case, since a
 *      headless loop runs with `--dangerously-skip-permissions`.
 *   2. `DXKIT_LOOP_ACTIVE=1` is exported in the launching environment.
 *   3. A `.dxkit/loop/active` sentinel file exists.
 *
 * (2) and (3) are the explicit override: `permission_mode` is not guaranteed
 * on every event, so a loop that wants a hard gating guarantee sets one of
 * them. Absent all three, the gate is an instant no-op allow.
 */
export function loopGateActive(repoDir: string, payload?: { permission_mode?: string }): boolean {
  if (payload?.permission_mode && UNATTENDED_PERMISSION_MODES.has(payload.permission_mode)) {
    return true;
  }
  if (process.env.DXKIT_LOOP_ACTIVE === '1') return true;
  try {
    return fs.existsSync(path.join(repoDir, LEDGER_DIR, 'active'));
  } catch {
    return false;
  }
}

/** Best-effort git stdout; '' on any error. `args` is always a fixed,
 *  caller-controlled string (no interpolation of untrusted input). */
function gitCapture(repoDir: string, args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 96 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/**
 * A content-complete signature of the working tree the guardrail would
 * scan. Captures HEAD, the ref-based comparison base (best effort), every
 * tracked content change vs HEAD (staged + unstaged), and the untracked
 * file list AND each untracked file's contents. Any edit to any file the
 * gather would see changes this signature, so a cache HIT is only ever a
 * genuinely-identical tree — the verdict cache can never skip a real
 * net-new finding. Returns null when it cannot be computed (then the gate
 * always gathers, the safe default).
 */
/** dxkit's own regenerated output dirs — never the code under test, so they
 *  must not contribute to the tree signature (else a gather that writes one
 *  perturbs the next signature). */
function isDxkitOutput(rel: string): boolean {
  return rel.startsWith('.dxkit/cache/') || rel.startsWith('.dxkit/reports/');
}

/** Drop `git status --porcelain` lines that reference a dxkit output path
 *  (they appear as `?? .dxkit/cache/…` when not gitignored). */
function stripDxkitOutputs(status: string): string {
  return status
    .split('\n')
    .filter((line) => {
      const rel = line.slice(3).trim(); // porcelain: XY + space, then path
      return !isDxkitOutput(rel);
    })
    .join('\n');
}

export function workingTreeSignature(repoDir: string): string | null {
  const head = gitCapture(repoDir, 'rev-parse HEAD').trim();
  if (!head) return null; // not a git repo / no commit → never cache
  const parts: string[] = [
    `head:${head}`,
    // Comparison base for ref-based mode (the default is vs origin/main);
    // empty when there is no such ref. Committed-full mode is fully
    // captured by HEAD + the tracked/untracked content below.
    `base:${gitCapture(repoDir, 'rev-parse origin/main').trim()}`,
    // Drop dxkit's OWN regenerated outputs from the status — the verdict cache
    // and the reports dir are written BY a gather, so including them would make
    // every gather perturb the next signature and defeat the replay. These are
    // never the code under test. (In an installed repo they're gitignored too;
    // this makes the signature robust even when they aren't.)
    `status:${stripDxkitOutputs(gitCapture(repoDir, 'status --porcelain=v1 -uall'))}`,
    `diff:${gitCapture(repoDir, 'diff HEAD')}`,
  ];
  const untracked = gitCapture(repoDir, 'ls-files --others --exclude-standard')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => !isDxkitOutput(rel));
  for (const rel of untracked) {
    try {
      const buf = fs.readFileSync(path.join(repoDir, rel));
      parts.push(`u:${rel}:${createHash('sha256').update(buf).digest('hex')}`);
    } catch {
      parts.push(`u:${rel}:unreadable`);
    }
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

/** Cached verdict keyed on a working-tree signature. Only the
 *  tree-deterministic outcomes (allow / block-model) are cached;
 *  operator/preflight failures are environment-dependent and re-tried. */
export interface StopGateStateCache {
  readonly signature: string;
  readonly outcome: 'allow' | 'block-model';
  readonly message: string;
  readonly netNew: number;
  readonly baselineFindings: number;
}
const STATE_FILE = 'last-state.json';

export function readStateCache(repoDir: string): StopGateStateCache | null {
  try {
    const raw = fs.readFileSync(path.join(repoDir, LEDGER_DIR, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as StopGateStateCache;
    if (
      typeof parsed.signature === 'string' &&
      (parsed.outcome === 'allow' || parsed.outcome === 'block-model')
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStateCache(repoDir: string, cache: StopGateStateCache): void {
  try {
    const dir = path.join(repoDir, LEDGER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort: a cache write must never break the gate */
  }
}
