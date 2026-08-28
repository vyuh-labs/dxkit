/**
 * The lockfile-sync floor check executor (4.4.5), split from the runner for
 * module size. Policy lives here exactly as for the other checks: a real
 * failure blocks, infrastructure is a disclosed skip, a pack-declared
 * tolerated failure is a PASS that carries its disclosure.
 */
import * as path from 'path';
import type { LanguageId, LanguageSupport } from '../../languages/types';
import {
  LOCKFILE_SYNC_LABEL,
  type CorrectnessContext,
  type CorrectnessProvider,
  type LockfileCheck,
} from '../../languages/capabilities/correctness';
import { discoverPackDepRoots } from '../security/nested-dep-roots';
import { tail, type CommandExec } from '../tools/bounded-exec';
import type { CorrectnessCheckResult } from './run';

/** The finding identity of the repo root inside a decomposed lockfile-sync
 *  check (a nested root's identity is its repo-relative directory). */
export const ROOT_DEP_ROOT_ID = '.';

/** `findings` entry -> repo-relative root dir ('' for the repo root). */
export function depRootDirOf(finding: string): string {
  return finding === ROOT_DEP_ROOT_ID ? '' : finding;
}

/**
 * Run a pack's lockfile-sync check at EVERY dependency root the pack's own
 * root discovery finds (the repo root plus each nested sub-project with its
 * own lockfile), through the same `discoverPackDepRoots` the dep audit
 * reads (Rule 2: one root set). Root-only checking read a nested
 * sub-project's stale lockfile as in sync, and the order the failure minted
 * could only ever point at the repo root.
 *
 * The result is ONE check per pack (the attribution unit stays the check)
 * that DECOMPOSES: `findings` names the failing roots (`.` for the repo
 * root), so the planner mints one stale-lockfile order per root and the
 * comparator can tell a newly stale nested root from pre-existing debt.
 * Merge policy: any failing root fails the check (its output prefixed by
 * root); otherwise any passing root passes it (a skipped root is disclosed,
 * never hidden behind the pass); otherwise the first skip stands. Null when
 * the pack declined at every root. A capped discovery is disclosed.
 */
export function runLockfileCheckAcrossRoots(
  id: LanguageId,
  provider: CorrectnessProvider,
  pack: Pick<LanguageSupport, 'capabilities'>,
  ctx: CorrectnessContext,
  exec: CommandExec,
): CorrectnessCheckResult | null {
  const discovery = discoverPackDepRoots(ctx.cwd, pack);
  const roots = ['', ...discovery.roots];
  const perRoot: { dir: string; result: CorrectnessCheckResult }[] = [];
  for (const dir of roots) {
    const result = runLockfileCheck(id, provider, { ...ctx, cwd: path.join(ctx.cwd, dir) }, exec);
    if (result !== null) perRoot.push({ dir, result });
  }
  if (perRoot.length === 0) return null;
  const idOf = (dir: string): string => (dir === '' ? ROOT_DEP_ROOT_ID : dir);
  const label = (dir: string): string => (dir === '' ? 'repo root' : dir);
  const disclosures: string[] = [];
  if (discovery.dropped.length > 0) {
    disclosures.push(
      `lockfile-sync root discovery capped: not checking ${discovery.dropped.join(', ')}`,
    );
  }
  for (const { dir, result } of perRoot) {
    if (result.status.startsWith('skipped')) {
      disclosures.push(
        `${label(dir)}: ${result.status}${result.output ? ` (${result.output})` : ''}`,
      );
    }
  }
  const withDisclosures = (r: CorrectnessCheckResult): CorrectnessCheckResult =>
    disclosures.length > 0 ? { ...r, disclosures: [...(r.disclosures ?? []), ...disclosures] } : r;
  const failed = perRoot.filter((r) => r.result.status === 'fail');
  if (failed.length > 0) {
    const first = failed[0].result;
    const output =
      perRoot.length === 1
        ? first.output
        : failed.map((r) => `[${label(r.dir)}]\n${r.result.output ?? ''}`).join('\n');
    return withDisclosures({
      ...first,
      ...(output !== undefined ? { output } : {}),
      findings: failed.map((r) => idOf(r.dir)),
    });
  }
  const passed = perRoot.find((r) => r.result.status === 'pass');
  if (passed) {
    const notes = perRoot.map((r) => r.result.note).filter((n): n is string => n !== undefined);
    return withDisclosures({
      ...passed.result,
      ...(notes.length > 0 ? { note: [...new Set(notes)].join('; ') } : {}),
    });
  }
  return withDisclosures(perRoot[0].result);
}

/**
 * Execute a pack's optional lockfile-sync check (4.4.5): the ecosystem's
 * non-installing frozen-install dry-run. A non-zero exit the pack declared
 * `tolerated` (npm's peer conflict, which CI's install retries under
 * `--legacy-peer-deps`) is a PASS carrying the disclosure as `note`; any
 * other non-zero exit (an out-of-sync lockfile) is a real failure, the exact
 * shape that killed CI's install before the gate ran. A pack skip and an
 * unavailable binary are fail-open, disclosed. Returns null when the pack
 * declined (no lockfile).
 */
export function runLockfileCheck(
  id: LanguageId,
  provider: CorrectnessProvider,
  ctx: CorrectnessContext,
  exec: CommandExec,
): CorrectnessCheckResult | null {
  let check;
  try {
    check = provider.lockfileCheck!(ctx);
  } catch (err) {
    return {
      pack: id,
      label: LOCKFILE_SYNC_LABEL,
      bin: '',
      status: 'skipped-unavailable',
      output: `lockfile-sync check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (check === null) return null;
  return executeLockfileCheck(id, check, ctx.cwd, exec);
}

/**
 * Execute an already-derived lockfile-sync check at `cwd`: the ONE
 * execution of the check shape, shared by the floor (above), the frame's
 * tree-invariant step (`lanes/tree-invariants.ts`) and the lockfile-sync
 * recipe's verify, so "the lockfile is in sync" is judged by one policy
 * wherever it is asked. A skip and an unavailable binary are fail-open,
 * disclosed; any non-tolerated non-zero exit fails.
 *
 * A tolerated-class failure of the primary is NEVER a verdict by itself
 * (4.4.6). The live class: on a tree whose pre-existing peer conflict is
 * tolerated, `npm ci --dry-run` fails ERESOLVE before it ever validates
 * the lock, so the pre-fix pass-on-match reported "in sync" over a lock an
 * agent's manifest edit had drifted, the frame's invariant never resynced
 * it, and the orders died at the landing install. The executor now walks
 * the tolerated retries like the install executor walks its fallback
 * ladder: it re-runs the dry-run UNDER the fallback's flags and judges on
 * THAT result. Pass = in sync, with the tolerance disclosed; drift = a
 * real FAIL (so the invariant resyncs); a further tolerated-class failure
 * with no retry left, or a retry with no composable command, keeps the
 * disclosed pass with CI's real install as the backstop; a retry that
 * cannot run (infrastructure) is a disclosed pass too, never a false
 * block.
 */
export function executeLockfileCheck(
  id: LanguageId,
  check: LockfileCheck,
  cwd: string,
  exec: CommandExec,
): CorrectnessCheckResult {
  if (check.kind === 'skipped') {
    return {
      pack: id,
      label: LOCKFILE_SYNC_LABEL,
      bin: '',
      status: 'skipped-unavailable',
      output: check.reason,
    };
  }
  const cmd = check.command;
  const base = { pack: id, label: cmd.label, bin: cmd.bin, args: cmd.args };
  let attempt = exec(cmd, cwd);
  // Infrastructure on the PRIMARY: the check could not run at all.
  if (!attempt.available) {
    return {
      ...base,
      status: 'skipped-unavailable',
      ...(attempt.output ? { output: attempt.output } : {}),
    };
  }
  if (attempt.timedOut) return { ...base, status: 'skipped-timeout' };
  if (attempt.overflowed) return { ...base, status: 'skipped-overflow' };

  const retries = check.tolerated ?? [];
  const remaining = [...retries];
  const notes: string[] = [];
  const pass = (): CorrectnessCheckResult =>
    notes.length > 0
      ? { ...base, status: 'pass', note: notes.join('; ') }
      : { ...base, status: 'pass' };
  for (;;) {
    if (attempt.code === 0) return pass();
    const idx = remaining.findIndex((r) => r.matches(attempt.output));
    if (idx === -1) {
      // A further tolerated-class failure with the ladder exhausted keeps
      // the disclosed pass (the pre-fix semantics, now the LAST resort).
      if (notes.length > 0 && retries.some((r) => r.matches(attempt.output))) return pass();
      // A pack-declared NON-DRIFT classification (poetry check validates
      // the whole pyproject alongside the lock) replaces the resync remedy
      // with the pack's own disclosure: the check still fails (the frozen
      // install fails on this tree either way), but the cause is named so
      // a manifest error is never read, or remediated, as lockfile drift.
      const classified = check.classifyFailure?.(attempt.output) ?? null;
      return {
        ...base,
        status: 'fail',
        output:
          tail(attempt.output) +
          '\n' +
          (classified ??
            'The lockfile does not satisfy the manifest: a frozen install (what CI runs before ' +
              'any gate) fails on this tree. Re-run the package manager install so the lockfile ' +
              'records the manifest, and commit both.'),
      };
    }
    const [retry] = remaining.splice(idx, 1);
    notes.push(retry.disclosure);
    // No composable dry-run under this fallback: the disclosed pass, with
    // CI's real install (which runs the actual fallback) as the backstop.
    if (retry.command === undefined) return pass();
    attempt = exec(retry.command, cwd);
    if (!attempt.available || attempt.timedOut || attempt.overflowed) {
      // The confirming dry-run could not run: fail-open, disclosed, never
      // a false block; CI's install remains the backstop.
      notes.push(
        "the confirming dry-run under the fallback could not run; CI's install is the backstop",
      );
      return pass();
    }
  }
}
