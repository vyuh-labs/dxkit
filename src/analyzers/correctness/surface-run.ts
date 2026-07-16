/**
 * Run the correctness floor for a NON-loop surface (`pre-push` / `ci`).
 *
 * The loop Stop-gate has its own runner (`src/loop/stop-gate.ts`) because it
 * diffs against a cheap entry snapshot to block only on NET-NEW failures. The
 * pre-push and CI surfaces are point-in-time LIVENESS gates instead: they run
 * the floor at the current tree and are fail-CLOSED on the surface's scope.
 * There is no net-new diffing here (that would cost a base-ref worktree run on
 * every push / PR); the entry-snapshot trick is the loop's alone.
 *
 *   - `pre-push` — AFFECTED scope, changed files computed vs the merge-base with
 *     the integration branch. Runs on the developer's machine where the
 *     toolchain is present, so the floor is meaningful; a per-command timeout
 *     keeps `git push` fast. Blocks the push when the affected tests don't pass.
 *     (It does not distinguish a pre-existing red test in a touched module from
 *     a newly-broken one — that distinction is the loop Stop-gate's job. Bypass
 *     with `--no-verify`.)
 *   - `ci` — FULL scope, no timeout (the full suite is expected to run). The
 *     backstop.
 *
 * Both surfaces are ADAPTIVE (`resolveCorrectnessSurface`): when the repo
 * already runs its tests in its own CI, the floor defaults to opt-in here, so
 * this runner returns a disabled no-op unless explicitly enabled.
 */

import { execFileSync } from 'child_process';

import { detectActiveLanguages } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import { computeChangedFiles } from '../../baseline/changed-files';
import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
  describeEnvironmentSkips,
  type CommandExec,
  type CorrectnessFloorResult,
} from './run';
import { resolveCorrectnessSurface } from './surface';

/** The surfaces this runner serves (the loop-stop surface has its own runner). */
export type RunnableSurface = 'pre-push' | 'ci';

export interface SurfaceFloorOutcome {
  readonly surface: RunnableSurface;
  /** Was the floor enabled on this surface (via the resolver)? */
  readonly enabled: boolean;
  /** Why it resolved the way it did (or why it was skipped). */
  readonly reason: string;
  /** Did any check actually execute (false when disabled / no pack / all skipped)? */
  readonly ran: boolean;
  /** Does the floor block this surface (a real failure)? Always false when not `ran`. */
  readonly blocks: boolean;
  /** One-line human summary for CLI / hook output. */
  readonly summary: string;
  readonly result?: CorrectnessFloorResult;
}

/** Best-effort git stdout for a fixed arg vector; '' on any failure. */
function gitOut(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The merge-base of HEAD against the most likely integration branch, so the
 * pre-push floor scopes to what this branch actually introduces. Tries, in
 * order: an explicit ref, the tracking upstream, then the common remote/local
 * default-branch names. Returns '' when none resolve (caller then runs full).
 */
export function resolvePrePushBase(cwd: string, explicit?: string): string {
  const candidates = explicit
    ? [explicit]
    : ['@{upstream}', 'origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    const mb = gitOut(cwd, ['merge-base', 'HEAD', ref]);
    if (mb) return mb;
  }
  return '';
}

/** Per-command wall-clock budget for the fast (pre-push) surface. Env-tunable;
 *  CI runs unbounded (the full suite is expected to run to completion). */
function prePushTimeoutMs(): number {
  const raw = process.env.DXKIT_FLOOR_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export interface RunFloorForSurfaceOptions {
  readonly surface: RunnableSurface;
  readonly cwd: string;
  /** Explicit base ref for pre-push affected scoping (else auto-resolved). */
  readonly base?: string;
  /** Explicit `--correctness` / `--no-correctness` override (highest precedence). */
  readonly flag?: boolean;
  /** Injected for tests; defaults to the real PATH-resolving exec. */
  readonly exec?: CommandExec;
  /** Injected for tests; defaults to the active packs detected at `cwd`. */
  readonly packs?: readonly LanguageSupport[];
  /** Injected for tests; defaults to the real adaptive resolver. */
  readonly resolveEnabled?: (
    surface: RunnableSurface,
    cwd: string,
  ) => { enabled: boolean; reason: string };
}

/**
 * Resolve enablement + scope for a surface and run the floor. Never throws — a
 * disabled surface, an absent pack, or an all-skipped run all return
 * `blocks: false` (the caller exits 0); only a real check failure blocks.
 */
export function runFloorForSurface(opts: RunFloorForSurfaceOptions): SurfaceFloorOutcome {
  const { surface, cwd } = opts;
  const res = opts.resolveEnabled
    ? opts.resolveEnabled(surface, cwd)
    : resolveCorrectnessSurface({ surface, cwd, flag: opts.flag });
  if (!res.enabled) {
    return {
      surface,
      enabled: false,
      reason: res.reason,
      ran: false,
      blocks: false,
      summary: `correctness floor (${surface}): disabled — ${res.reason}`,
    };
  }

  const packs = (opts.packs ?? detectActiveLanguages(cwd)).filter((p) => p.correctness);
  if (packs.length === 0) {
    return {
      surface,
      enabled: true,
      reason: res.reason,
      ran: false,
      blocks: false,
      summary: `correctness floor (${surface}): no active language pack provides a floor`,
    };
  }

  let scope: 'affected' | 'full' = 'full';
  let changedFiles: readonly string[] = [];
  let timeoutMs: number | undefined;
  if (surface === 'pre-push') {
    scope = 'affected';
    const base = resolvePrePushBase(cwd, opts.base);
    // Empty changedFiles (base unresolved / diff undeterminable) → the packs
    // treat the scope as full, per the CorrectnessContext contract.
    changedFiles = base ? (computeChangedFiles(cwd, base) ?? []) : [];
    timeoutMs = prePushTimeoutMs();
  }
  // ci: full scope, no timeout — the full suite runs to completion.

  const result = runCorrectnessFloor({
    cwd,
    changedFiles,
    scope,
    packs,
    timeoutMs,
    exec: opts.exec,
  });
  // A declared environment boundary is disclosed on every outcome — a floor
  // that cannot run HERE names where it would run, never skips silently
  // (Rule 20). Appended to the summary so hooks/CI logs carry it verbatim.
  const envSkips = describeEnvironmentSkips(result);
  const envSuffix = envSkips.length > 0 ? ` [${envSkips.join('; ')}]` : '';
  if (!result.ran) {
    const cause =
      envSkips.length > 0
        ? 'not measurable in this environment'
        : 'all checks skipped (toolchain not present)';
    return {
      surface,
      enabled: true,
      reason: res.reason,
      ran: false,
      blocks: false,
      summary: `correctness floor (${surface}): ${cause} — CI is the backstop${envSuffix}`,
      result,
    };
  }
  return {
    surface,
    enabled: true,
    reason: res.reason,
    ran: true,
    blocks: result.blocks,
    summary: describeCorrectnessFloor(result) + envSuffix,
    result,
  };
}
