/**
 * Run the correctness floor for a NON-loop surface (`pre-push` / `ci`).
 *
 * The loop Stop-gate has its own runner (`src/loop/stop-gate.ts`) because it
 * diffs against a cheap entry snapshot to block only on NET-NEW failures.
 *
 *   - `pre-push` — AFFECTED scope, changed files computed vs the merge-base with
 *     the integration branch. Runs on the developer's machine where the
 *     toolchain is present, so the floor is meaningful; a per-command timeout
 *     keeps `git push` fast. Blocks the push when the affected tests don't pass.
 *     (It does not distinguish a pre-existing red test in a touched module from
 *     a newly-broken one — that distinction belongs to the two-sided surfaces.
 *     Bypass with `--no-verify`.)
 *   - `ci` — FULL scope, no timeout. DIFF-SCOPED (T2.3): when the current tree
 *     has failures and a merge-base is resolvable, the floor also runs at the
 *     base in a throwaway worktree and each failure is ATTRIBUTED through the
 *     ONE comparator the loop uses (`attributeFloorFailures`): only NET-NEW
 *     failures block (a PR bundling a breakage with, say, a dxkit install
 *     still blocks — base green, PR red), pre-existing debt warns by name,
 *     and a failure whose base side could not be observed is `unattributed`
 *     (disclosed, never blocked — the Rule 19 law applied to the floor). The
 *     base side only runs when the current side FAILED, so a green PR pays
 *     nothing.
 *
 * Both surfaces are ADAPTIVE (`resolveCorrectnessSurface`): when the repo
 * already runs its tests in its own CI, the floor defaults to opt-in here, so
 * this runner returns a disabled no-op unless explicitly enabled.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { detectActiveLanguages, changedFilesTouchDependencyManifest } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import { computeChangedFiles } from '../../baseline/changed-files';
import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
  describeEnvironmentSkips,
  type CommandExec,
  type CorrectnessFloorResult,
} from './run';
import { attributeFloorFailures, type AttributedFloorFailure } from './attribution';
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
  /** Present after a two-sided ci run (T2.3): every current failure with its
   *  attribution vs the merge-base. Renderers print net-new with full output
   *  and the non-blocking tiers by name. */
  readonly attributed?: readonly AttributedFloorFailure[];
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
  /** Scope the floor to these pack ids (a generated per-host gate job runs
   *  only the packs PLACED on its host — Rule 20). Unknown ids are ignored;
   *  undefined runs every active pack. */
  readonly packIds?: readonly string[];
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

  const packs = (opts.packs ?? detectActiveLanguages(cwd))
    .filter((p) => p.correctness)
    .filter((p) => !opts.packIds || opts.packIds.includes(p.id));
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

/**
 * Provision a base-ref worktree well enough for the floor to run (best
 * effort). Ecosystems with user-level caches (Gradle/Maven, go, cargo, pip)
 * just work in a fresh worktree; node needs node_modules. When the diff
 * touched NO dependency manifest (pack-declared patterns — Rule 6), the
 * current tree's install IS the base's install, so a symlink is sound. When
 * manifests changed (or the changed set is unknowable) we provision nothing —
 * affected checks then skip on the base side and their failures come back
 * `unattributed` (disclosed, non-blocking) rather than resting on a tree the
 * base never had.
 */
function provisionBaseWorktree(
  cwd: string,
  worktree: string,
  baseSha: string,
  packs: readonly LanguageSupport[],
): void {
  const changed = computeChangedFiles(cwd, baseSha);
  if (changed === null || changedFilesTouchDependencyManifest(changed, packs)) return;
  const src = path.join(cwd, 'node_modules');
  const dst = path.join(worktree, 'node_modules');
  try {
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, 'dir');
  } catch {
    /* best-effort — an unprovisioned base side degrades to `unattributed` */
  }
}

/**
 * Two-sided attribution for a BLOCKING ci floor outcome (T2.3): run the floor
 * at the merge-base in a throwaway worktree and re-derive `blocks` from the
 * ONE comparator — only failures the base side PASSED (net-new) block. Called
 * only when the current side failed, so a green PR never pays the base run.
 *
 * Fail-open discipline: an unresolvable base keeps the point-in-time verdict
 * (blocking — push-to-default-branch runs have no base and stay the liveness
 * backstop); a base-side crash attributes every failure `unattributed`
 * (non-blocking, disclosed) — the developer is never blamed on evidence dxkit
 * does not have.
 */
export async function attributeCiFloorOutcome(
  outcome: SurfaceFloorOutcome,
  opts: {
    readonly cwd: string;
    readonly base?: string;
    /** Injected for tests; default real exec / worktree pack detection. */
    readonly exec?: CommandExec;
    readonly packs?: readonly LanguageSupport[];
  },
): Promise<SurfaceFloorOutcome> {
  if (outcome.surface !== 'ci' || !outcome.blocks || !outcome.result) return outcome;
  const baseSha = resolvePrePushBase(opts.cwd, opts.base);
  if (!baseSha) {
    return {
      ...outcome,
      summary: `${outcome.summary} [no merge-base resolvable — point-in-time verdict]`,
    };
  }

  let baseResult: CorrectnessFloorResult | null = null;
  try {
    const { withRefWorktree } = await import('../../baseline/ref-baseline');
    baseResult = await withRefWorktree({ cwd: opts.cwd, ref: baseSha }, async (wt) => {
      const packs = (opts.packs ?? detectActiveLanguages(wt)).filter((p) => p.correctness);
      provisionBaseWorktree(opts.cwd, wt, baseSha, packs);
      return runCorrectnessFloor({
        cwd: wt,
        changedFiles: [],
        scope: 'full',
        packs,
        exec: opts.exec,
      });
    });
  } catch {
    baseResult = null; // base side unobservable → every failure unattributed
  }

  const baseChecks =
    baseResult === null
      ? null
      : baseResult.checks.map((c) => ({
          pack: c.pack as string,
          label: c.label,
          status: c.status === 'pass' || c.status === 'fail' ? c.status : ('skipped' as const),
        }));
  const attributed = attributeFloorFailures(outcome.result, baseChecks, {
    absentMeans: 'unattributed',
  });
  const netNew = attributed.filter((a) => a.attribution === 'net-new');
  const preExisting = attributed.filter((a) => a.attribution === 'pre-existing');
  const unattributed = attributed.filter((a) => a.attribution === 'unattributed');

  const parts: string[] = [];
  if (netNew.length > 0) {
    parts.push(
      `correctness floor: ${netNew.length} NET-NEW failure(s) vs ${baseSha.slice(0, 12)} — ${netNew
        .map((a) => `${a.check.pack} ${a.check.label}`)
        .join(', ')}`,
    );
  } else {
    parts.push(`correctness floor: no net-new failure vs ${baseSha.slice(0, 12)}`);
  }
  if (preExisting.length > 0) {
    parts.push(
      `${preExisting.length} pre-existing failure(s) also present at the base (not blocked): ${preExisting
        .map((a) => `${a.check.pack} ${a.check.label}`)
        .join(', ')}`,
    );
  }
  if (unattributed.length > 0) {
    parts.push(
      `${unattributed.length} failure(s) could not be attributed (the base side did not run that check — ${
        baseResult === null
          ? 'base floor run failed'
          : 'toolchain/deps unavailable in the base worktree'
      }); not blocked, review advised: ${unattributed
        .map((a) => `${a.check.pack} ${a.check.label}`)
        .join(', ')}`,
    );
  }

  return {
    ...outcome,
    blocks: netNew.length > 0,
    summary: parts.join(' | '),
    attributed,
  };
}
