/**
 * Ref-based baseline gather — produces a `CurrentScan` for a git
 * ref by checking it out into a temporary worktree and running the
 * analyzer pipeline there.
 *
 * # When this runs
 *
 * `mode === 'ref-based'` (see `./modes.ts`). The guardrail check
 * needs a "prior side" to diff against; in committed modes the
 * prior side comes from `.dxkit/baselines/<name>.json`, but in
 * ref-based mode no file is committed — the prior side is
 * recomputed on the fly from a git ref (default
 * `origin/<default-branch>`).
 *
 * # Mechanics
 *
 * 1. Resolve `ref` to a commit SHA. Failure here surfaces a
 *    `RefBaselineError` with one of three actionable hints:
 *      - Shallow clone → `git fetch --unshallow` / CI fetch-depth
 *      - Ref doesn't exist → `git fetch origin` or fix policy
 *      - Local-only ref → push it or use a remote-tracking ref
 * 2. `git worktree add --detach <tempDir> <sha>`. The worktree is a
 *    full checkout of the source tree at that SHA — but NOT a
 *    package-manager install, so dep-vuln scanners that read
 *    `node_modules` directly will see degraded results. The
 *    dxkit dep scanners use lockfiles (`package-lock.json`,
 *    `Pipfile.lock`, etc.) which ARE in the worktree, so coverage
 *    survives the gap.
 * 3. Run `gatherCurrentScan` against the worktree directory. Same
 *    pipeline as the live current scan — same producer registry,
 *    same envelope shape — so the matcher diffs apples-to-apples.
 * 4. Clean up the worktree on the way out (try/finally).
 *
 * # Why a generic `withRefWorktree` helper
 *
 * The worktree setup + cleanup pattern is reusable. Future modes-
 * aware tooling (e.g., a `vyuh-dxkit baseline diff <refA> <refB>`
 * subcommand) can compose `withRefWorktree` directly instead of
 * re-deriving the temp-dir + cleanup dance. `gatherFromRef` is a
 * thin specialization for the guardrail-check use case.
 *
 * # Failure semantics
 *
 * Recoverable failures (ref unreachable, worktree-add fails) throw
 * `RefBaselineError` with a `hint` field the CLI renders in plain
 * prose. Unrecoverable failures (the gather pipeline itself
 * crashes) propagate up the original Error subclass — they're not
 * specific to ref-based mode and live with the existing error
 * handling in the orchestrator.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { VERSION } from '../constants';
import { CURRENT_IDENTITY_SCHEME } from './types';
import { gatherCurrentScan } from './create';
import type { CurrentScan } from './create';
import { type GatherScope, FULL_SCOPE, scopeSignature } from './gather-scope';

/**
 * Recoverable error from the ref-based gather path. Carries an
 * actionable `hint` the CLI surfaces verbatim so customers don't
 * have to interpret raw git output. Inherits from `Error` so
 * existing catch-by-Error code keeps working.
 */
export class RefBaselineError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'RefBaselineError';
    this.hint = hint;
  }
}

export interface RefWorktreeOptions {
  readonly cwd: string;
  readonly ref: string;
}

/**
 * Resolve a ref to a commit SHA via `git rev-parse --verify
 * <ref>^{commit}`. Returns null when the ref isn't reachable (the
 * caller surfaces the appropriate hint based on shallow-clone /
 * remote-only state).
 */
export function resolveRefToSha(cwd: string, ref: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Whether the current working tree was cloned shallowly. Drives
 * the hint surfaced when a ref isn't reachable: a CI clone with
 * `fetch-depth: 1` won't have the baseline ref's history, and the
 * fix is `fetch-depth: 0`, not pushing the missing ref.
 */
export function isShallowRepo(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * Build the right `RefBaselineError` for an unreachable ref. The
 * hint is the actionable next step, not a tautology — shallow
 * clones get fetch-depth advice, otherwise we suggest configuring
 * a different ref.
 */
function unreachableRefError(cwd: string, ref: string): RefBaselineError {
  if (isShallowRepo(cwd)) {
    return new RefBaselineError(
      `Cannot resolve baseline ref ${ref}: this is a shallow clone.`,
      'Run `git fetch --unshallow` locally, or set `fetch-depth: 0` in your CI checkout step.',
    );
  }
  return new RefBaselineError(
    `Cannot resolve baseline ref ${ref}.`,
    `Run \`git fetch origin\`, push the ref upstream, or set \`baseline.ref\` in .dxkit/policy.json to an existing ref.`,
  );
}

/**
 * Check out `ref` into a temporary worktree, run `fn` with the
 * worktree path, and tear down the worktree on the way out.
 *
 * Always cleans up — even when `fn` throws. The cleanup tolerates
 * `git worktree remove` failures (e.g., dirty worktree from a
 * partial gather) by falling back to `rm -rf` on the temp dir.
 */
export async function withRefWorktree<T>(
  opts: RefWorktreeOptions,
  fn: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const sha = resolveRefToSha(opts.cwd, opts.ref);
  if (sha === null) throw unreachableRefError(opts.cwd, opts.ref);

  // mkdtempSync returns an empty dir; git worktree add wants the
  // target path NOT to exist (or to be empty). Use a fresh subdir
  // inside the temp parent so git creates it cleanly.
  const tempBase = mkdtempSync(path.join(tmpdir(), 'dxkit-ref-'));
  const worktreePath = path.join(tempBase, 'baseline');
  let worktreeAdded = false;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, sha], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worktreeAdded = true;
    // Mirror file-mode salt into the worktree so secret-HMAC entries
    // pair across prior/current sides. Env-var + deterministic modes
    // resolve identically across cwd + worktree (env inheritance +
    // shared initial-commit SHA); file mode is the one that drifts
    // because `.dxkit/salt` is gitignored and so isn't part of the
    // checkout. The copy is no-op when the file doesn't exist.
    mirrorSaltFile(opts.cwd, worktreePath);
    return await fn(worktreePath);
  } catch (err) {
    if (err instanceof RefBaselineError) throw err;
    if (!worktreeAdded) {
      // The worktree-add itself failed. Surface a clean error
      // instead of bubbling the raw stderr.
      throw new RefBaselineError(
        `Failed to set up baseline worktree at ${opts.ref}.`,
        `Check that 'git worktree' is available and that ${tempBase} is writable.`,
      );
    }
    throw err;
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: opts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // git worktree remove can fail if the worktree dir was
        // already cleaned externally. The rmSync below recovers.
      }
    }
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the temp parent. A stale temp dir
      // is preferable to surfacing a misleading error if the gather
      // already succeeded.
    }
  }
}

/**
 * Copy `.dxkit/salt` from `srcCwd` into `dstCwd` when present.
 * Public for testing — production callers reach this through
 * `withRefWorktree`. The directory is created on demand; absent
 * source files are silently skipped (env-var + deterministic salt
 * modes both work without the file).
 */
export function mirrorSaltFile(srcCwd: string, dstCwd: string): void {
  const src = path.join(srcCwd, '.dxkit', 'salt');
  if (!existsSync(src)) return;
  const dstDir = path.join(dstCwd, '.dxkit');
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, path.join(dstDir, 'salt'));
}

/**
 * Run `gatherCurrentScan` against a temporary worktree checked out
 * to `ref`. Returns the same shape as a live gather — the matcher
 * doesn't care which side was the worktree, only that both sides
 * are `CurrentScan` envelopes.
 *
 * Per-tool degradation note: dep-vuln scanners may report less
 * coverage in the worktree because `node_modules` (and analogous
 * install artifacts) are typically gitignored and so don't exist
 * in the worktree. The lockfile-driven scanners dxkit prefers
 * survive the gap; `npm audit`-style probes do not.
 */
export async function gatherFromRef(opts: {
  readonly cwd: string;
  readonly ref: string;
  readonly verbose?: boolean;
  /** Scope the ref-side gather identically to the current side so the
   *  cross-run diff stays balanced. Defaults to `FULL_SCOPE`. */
  readonly scope?: GatherScope;
}): Promise<CurrentScan> {
  const sha = resolveRefToSha(opts.cwd, opts.ref);
  if (sha === null) throw unreachableRefError(opts.cwd, opts.ref);

  const scope = opts.scope ?? FULL_SCOPE;
  const key = refScanCacheKey(opts.cwd, sha, scope);
  const cached = readRefScanCache(opts.cwd, key);
  if (cached) return cached;

  const scan = await withRefWorktree({ cwd: opts.cwd, ref: opts.ref }, async (worktreePath) => {
    return gatherCurrentScan({ cwd: worktreePath, verbose: opts.verbose, scope });
  });
  writeRefScanCache(opts.cwd, key, scan);
  return scan;
}

/**
 * Content-addressed cache for ref-side gathers.
 *
 * A ref scan is a pure function of its inputs: the ref commit, the dxkit
 * version, the identity scheme, and the salt. The loop Stop-gate fires the
 * ref gather on every stop against an `origin/main` that rarely moves, so
 * without this cache it re-scans an unchanged ref each time — the dominant
 * cost of a ref-based gate. A cache hit is only ever a genuinely identical
 * scan (the key captures every input that can change the findings), so the
 * cache can never alter a guardrail verdict.
 *
 * Safety note: `gatherFromRef` returns a full `CurrentScan`, but the sole
 * consumer (the ref-based branch of `runGuardrailCheck`) reads only the
 * plain `findings`/`repoState`/`analysisMeta`/`tools`/`saltMode` fields,
 * all of which JSON round-trip exactly. The cache file is JSON, lives under
 * the already-gitignored `.dxkit/cache/`, and is bypassed entirely with
 * `DXKIT_NO_REF_CACHE=1`. Bump `REF_SCAN_CACHE_FORMAT` if `CurrentScan`'s
 * serialized shape changes.
 */
const REF_SCAN_CACHE_FORMAT = 1;
const REF_SCAN_CACHE_DIR = path.join('.dxkit', 'cache', 'ref-scan');

/** Hash of the file-mode salt, or a sentinel when absent. */
function saltSignature(cwd: string): string {
  try {
    const buf = readFileSync(path.join(cwd, '.dxkit', 'salt'));
    return createHash('sha256').update(buf).digest('hex').slice(0, 16); // fingerprint-helper-ok
  } catch {
    return 'no-salt';
  }
}

/** Deterministic cache key over every input that can change a ref scan.
 *  Includes the gather scope so a scoped ref scan is never reused for a
 *  full request (or vice versa). Exported for testing. */
export function refScanCacheKey(cwd: string, sha: string, scope: GatherScope = FULL_SCOPE): string {
  const material = [
    `fmt:${REF_SCAN_CACHE_FORMAT}`,
    `sha:${sha}`,
    `ver:${VERSION}`,
    `scheme:${CURRENT_IDENTITY_SCHEME}`,
    `salt:${saltSignature(cwd)}`,
    `scope:${scopeSignature(scope)}`,
  ].join('\0');
  return createHash('sha256').update(material).digest('hex').slice(0, 32); // fingerprint-helper-ok
}

/** Read a cached ref scan; null on miss, bypass, or any shape mismatch.
 *  Exported for testing. */
export function readRefScanCache(cwd: string, key: string): CurrentScan | null {
  if (process.env.DXKIT_NO_REF_CACHE === '1') return null;
  try {
    const raw = readFileSync(path.join(cwd, REF_SCAN_CACHE_DIR, `${key}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { format?: number; scan?: CurrentScan };
    if (
      parsed.format !== REF_SCAN_CACHE_FORMAT ||
      !parsed.scan ||
      !Array.isArray(parsed.scan.findings)
    ) {
      return null; // unexpected shape → gather fresh (safe default)
    }
    return parsed.scan;
  } catch {
    return null; // miss / unreadable / parse error → gather fresh (safe default)
  }
}

/** Persist a ref scan keyed by its content address. Best-effort.
 *  Exported for testing. */
export function writeRefScanCache(cwd: string, key: string, scan: CurrentScan): void {
  if (process.env.DXKIT_NO_REF_CACHE === '1') return;
  try {
    const dir = path.join(cwd, REF_SCAN_CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ format: REF_SCAN_CACHE_FORMAT, scan }) + '\n',
      'utf8',
    );
  } catch {
    /* A cache write must never break the gather. */
  }
}
