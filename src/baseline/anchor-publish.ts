/**
 * Anchor-branch WRITER — the single path that publishes a set of files to a
 * dxkit side ref (`dxkit-baselines`, `dxkit-reports`, …) and the single READER
 * of an arbitrary side ref. Companion to `anchor.ts` (which reads the baseline
 * anchor specifically); the low-level ref read/write primitives live here so
 * BOTH the baseline after-merge refresh and `report snapshot` publish through
 * ONE implementation (CLAUDE.md Rule 2 / Rule 11) — the protected-branch side-ref
 * push is never copied into a workflow's inline bash.
 *
 * Why plumbing, not a checkout: this writes a commit onto the side ref using
 * `git hash-object → update-index (on a TEMP index) → write-tree → commit-tree →
 * push`. It therefore never runs `git worktree` (Rule 11 confines that to
 * `ref-baseline.ts`), never touches the checkout's working tree or index, and
 * needs no clean tree — safe to call from any CI job. Auth is the ambient remote
 * of `cwd` (the CI checkout's token / the dev's credential helper), the same
 * boundary as every other dxkit git operation.
 *
 * Accumulate vs replace: `baseParent: true` (default) bases the new commit on the
 * current `origin/<ref>` tip, so unchanged files persist and history accrues
 * (reports append `report-history.jsonl` + refresh `latest/`); `false` writes an
 * orphan single-parentless commit (replace-all, the baseline latest-wins model).
 * Both modes skip the push when the tree they would write already matches the
 * remote tip (idempotent refresh) — and because a deleted ref has no tip, a
 * republish after deletion always goes through (self-heal), even byte-identical.
 * `removePaths` deletes entries (report snapshot pruning). A non-fast-forward
 * push (a concurrent merge advanced the ref) is retried once against the new tip.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { internalGitPushArgs } from '../git-internal-push';

export interface AnchorFile {
  /** Repo-relative path on the side ref (POSIX separators). */
  readonly path: string;
  readonly content: string;
}

export interface PublishToAnchorOptions {
  readonly cwd: string;
  /** Side branch name, e.g. `dxkit-reports` (NOT a protected branch). */
  readonly anchorRef: string;
  /** Files to add or overwrite on the ref. */
  readonly files: readonly AnchorFile[];
  /** Paths to delete from the ref (pruning). Ignored when a path is absent. */
  readonly removePaths?: readonly string[];
  readonly message: string;
  /**
   * Base the commit on the existing `origin/<ref>` tip so unchanged files
   * persist (accumulate). `false` → an orphan replace-all commit. Default true.
   */
  readonly baseParent?: boolean;
  /** Author/committer identity for the plumbing commit. */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly timeoutMs?: number;
  /** Test seam: override the git executor. Production leaves this undefined and
   *  runs `git` via `execFileSync`; a test injects a spy to assert the exact
   *  argv (e.g. the push carries `--no-verify`) without a real remote. */
  readonly _exec?: (args: string[], input?: string) => string;
}

export interface PublishResult {
  readonly pushed: boolean;
  readonly commit: string | null;
  /** Present when `pushed` is false — why (e.g. no origin, push rejected twice). */
  readonly reason?: string;
}

const DEFAULT_IDENTITY = { name: 'dxkit-bot', email: 'dxkit-bot@users.noreply.github.com' };

/**
 * Turn a failed `git push` into an ACTIONABLE reason. A bare `push rejected:
 * Command failed … ETIMEDOUT` reads as a mystery hang; the caller (and CI logs)
 * need to know what stalled.
 *
 * gh #156 — the load-bearing lesson: DO NOT assert "auth" from a bare timeout.
 * The original message here declared "the remote did not authenticate" on any
 * timeout, and that single mislabel sent four debug builds chasing a
 * non-existent credential bug. The REAL cause of the timeout was that the
 * internal side-ref push fired the repo's own `pre-push` hook (dxkit's guardrail
 * check), which ran past the `execFileSync` timeout and got SIGTERM'd
 * mid-hook → ETIMEDOUT. That is now fixed at the source (the push runs with
 * `--no-verify`, below), so a timeout here is a genuine transport/network stall,
 * not auth and not a hook.
 */
export function describePushFailure(err: Error, timeoutMs: number): string {
  const e = err as Error & { code?: string; signal?: string; killed?: boolean };
  const timedOut =
    e.code === 'ETIMEDOUT' ||
    e.signal === 'SIGTERM' ||
    e.killed === true ||
    /ETIMEDOUT|timed out/i.test(err.message);
  if (timedOut) {
    return (
      `push did not complete within ${Math.round(timeoutMs / 1000)}s. The internal side-ref ` +
      `push runs with \`--no-verify\` (so a project pre-push hook is not the cause); a persistent ` +
      `timeout points at a stuck network/transport or an unreachable remote rather than auth.`
    );
  }
  if (/denied|forbidden|403|not authorized|authentication failed/i.test(err.message)) {
    return `push denied by the remote (authentication/permission): ${err.message}`;
  }
  return `push rejected: ${err.message}`;
}

/**
 * Read a single file's content from an arbitrary side ref (`origin/<ref>` then
 * `<ref>`), best-effort. Returns `null` when the ref/file is unreachable (not
 * created yet, offline, wrong ref). Never throws. This is the generalized read
 * that `anchor.ts:anchorContentFromBranch` (baseline) and the reports layer both
 * use — one reader of a side ref, one write path below.
 */
export function readFromAnchorRef(cwd: string, anchorRef: string, relPath: string): string | null {
  // Best-effort fetch so `origin/<ref>` exists locally (no-op offline / in CI
  // where the checkout already fetched).
  try {
    execFileSync('git', ['fetch', '--depth=1', 'origin', anchorRef], { cwd, stdio: 'ignore' });
  } catch {
    /* offline / already present */
  }
  for (const ref of [`origin/${anchorRef}`, anchorRef]) {
    try {
      return execFileSync('git', ['show', `${ref}:${relPath}`], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
    } catch {
      /* try next ref form */
    }
  }
  return null;
}

/** Does the ref exist on the REMOTE right now? `null` when unknown (offline /
 *  no ls-remote) — used only to veto the no-change skip, never to fail. */
function remoteRefExists(
  git: (args: string[]) => string,
  remote: string,
  anchorRef: string,
): boolean | null {
  try {
    return git(['ls-remote', '--heads', remote, anchorRef]).trim().length > 0;
  } catch {
    return null;
  }
}

/** Resolve the tree-ish + commit of the current side-ref tip, or null if absent. */
function resolveTip(
  git: (args: string[]) => string,
  anchorRef: string,
): { commit: string; tree: string } | null {
  for (const ref of [`origin/${anchorRef}`, anchorRef]) {
    try {
      const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
      const tree = git(['rev-parse', '--verify', `${ref}^{tree}`]).trim();
      if (commit && tree) return { commit, tree };
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Publish `files` (and delete `removePaths`) to `anchorRef` as a new commit, then
 * push. Returns `{ pushed:false }` (never throws for an expected transport
 * failure — no origin, unreachable ref) so a caller in a workflow degrades
 * gracefully; a genuinely malformed call (bad git) still throws.
 */
export function publishFilesToAnchorRef(opts: PublishToAnchorOptions): PublishResult {
  const { cwd, anchorRef } = opts;
  const identity = opts.identity ?? DEFAULT_IDENTITY;
  // A short, SURFACED bound: a small baseline push completes in seconds, so a
  // stall is a stuck auth handshake, not slow transport. Kept low so a hang
  // fails FAST with a clear reason instead of 60s of CI silence (gh #156).
  const timeout = opts.timeoutMs ?? 30_000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // BOTH prompt paths off so a push that would otherwise BLOCK on input fails
    // fast instead of hanging until the timeout: HTTPS credential prompts
    // (`GIT_TERMINAL_PROMPT=0`) AND SSH passphrase / host-key prompts
    // (`BatchMode=yes`, mirroring remote-ref.ts). Without the SSH guard an
    // unauthenticated push over an `ssh://` remote hangs — the "mystery hang"
    // gh #156 reported in Actions.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };

  const tmpIndex = path.join(mkdtempSync(path.join(tmpdir(), 'dxkit-anchor-idx-')), 'index');
  const realExec = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd,
      env: { ...env, GIT_INDEX_FILE: tmpIndex },
      timeout,
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    }).toString();
  // Auth is the ambient credential of `cwd` — in CI the one actions/checkout
  // persists (`http.<host>.extraheader`); locally the git credential helper /
  // SSH agent. We inject NOTHING: the whole gh #156 saga was a misdiagnosis
  // (see `describePushFailure`) — a plain plumbing push always authenticated
  // fine; the 30s "timeout" was the internal push firing the repo's own
  // `pre-push` guardrail hook and getting SIGTERM'd mid-hook. The real fix is
  // `--no-verify` on the push (below), not any credential handling.
  const exec = opts._exec ?? realExec;
  // Diagnosability (gh #156): with DXKIT_DEBUG set, trace every git command and
  // how long it took, so a stall shows exactly which command hung (this is what
  // finally surfaced the pre-push hook as the cause). Any embedded credential in
  // a URL is masked.
  const debugOn = !!env.DXKIT_DEBUG;
  const mask = (s: string): string =>
    s.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').replace(/(:\/\/)[^@/]+@/g, '$1***@');
  const dbg = (msg: string): void => {
    if (debugOn) process.stderr.write(`[dxkit-anchor] ${mask(msg)}\n`);
  };
  const git = (args: string[], input?: string): string => {
    if (!debugOn) return exec(args, input);
    const started = Date.now();
    try {
      const out = exec(args, input);
      dbg(`git ${args.join(' ')}  (${Date.now() - started}ms)`);
      return out;
    } catch (err) {
      dbg(
        `git ${args.join(' ')}  FAILED after ${Date.now() - started}ms: ${(err as Error).message}`,
      );
      throw err;
    }
  };

  try {
    // Confirm a remote exists — no origin ⇒ nothing to publish to.
    let originUrl: string;
    try {
      originUrl = git(['remote', 'get-url', 'origin']).trim();
    } catch {
      return { pushed: false, commit: null, reason: 'no origin remote' };
    }
    dbg(`origin=${mask(originUrl)} · push=ambient-credential · hook=skipped (--no-verify)`);

    const buildAndPush = (): PublishResult => {
      const baseParent = opts.baseParent !== false;
      // Refresh the remote-tracking ref so `resolveTip` sees the TRUE remote
      // tip — a prior push-by-refspec doesn't reliably update the local
      // `origin/<ref>` on every git version, and this also picks up a
      // concurrent merge's advance before we build. Both modes need it:
      // accumulate bases the commit on it, replace-all compares against it for
      // the no-change skip below.
      try {
        git(['fetch', '--depth=1', 'origin', anchorRef]);
      } catch {
        /* first publish (ref absent) / offline — resolveTip returns null */
      }
      const remoteTip = resolveTip(git, anchorRef);
      const tip = baseParent ? remoteTip : null;

      // Seed the temp index from the base tree (accumulate) or empty (orphan).
      if (tip) git(['read-tree', tip.tree]);
      else git(['read-tree', '--empty']);

      for (const f of opts.files) {
        const rel = f.path.split(path.sep).join('/');
        const blob = git(['hash-object', '-w', '--stdin'], f.content).trim();
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`]);
      }
      for (const p of opts.removePaths ?? []) {
        const rel = p.split(path.sep).join('/');
        try {
          git(['update-index', '--force-remove', rel]);
        } catch {
          /* not present on the ref — nothing to prune */
        }
      }

      const tree = git(['write-tree']).trim();
      // No change vs the remote tip's tree → nothing to publish (idempotent
      // refresh). This applies in BOTH modes: replace-all compares the orphan
      // tree it would write against what's already on the ref, so a periodic
      // refresh with identical content pushes nothing. Before skipping, confirm
      // the ref still EXISTS on the remote: `resolveTip` falls back to a stale
      // local `origin/<ref>` when the fetch fails, and a fetch fails both when
      // offline AND when the remote branch was deleted — in the deleted case a
      // byte-identical republish must still push (the self-heal path), or the
      // anchor stays gone until the content next changes.
      if (
        remoteTip &&
        tree === remoteTip.tree &&
        remoteRefExists(git, 'origin', anchorRef) !== false
      ) {
        return { pushed: false, commit: null, reason: 'no change' };
      }
      const commitArgs = ['commit-tree', tree, '-m', opts.message];
      if (tip) commitArgs.push('-p', tip.commit);
      const commit = git(commitArgs).trim();

      const pushRefspec = `${commit}:refs/heads/${anchorRef}`;
      // The push routes through `internalGitPushArgs` — the ONE constructor that
      // guarantees `--no-verify` (gh #156: this is a machine push of a dxkit-owned
      // side ref; running the repo's pre-push guardrail hook here is what caused
      // the ETIMEDOUT the fix chased as auth for four builds). Accumulate: plain
      // fast-forward push (a concurrent-merge rejection is retried once below).
      // Replace-all (`baseParent:false`, latest-wins): a parentless commit is
      // non-fast-forward by design, so force-overwrite.
      const pushArgs = internalGitPushArgs(pushRefspec, { force: baseParent === false });
      try {
        git(pushArgs);
        dbg('push succeeded (ambient credential, hook skipped)');
        return { pushed: true, commit };
      } catch (err) {
        return { pushed: false, commit, reason: describePushFailure(err as Error, timeout) };
      }
    };

    let result = buildAndPush();
    // Non-fast-forward: a concurrent merge advanced the ref. Re-fetch and rebuild
    // the commit onto the new tip once.
    if (!result.pushed && result.reason?.startsWith('push rejected') && opts.baseParent !== false) {
      try {
        git(['fetch', '--depth=1', 'origin', anchorRef]);
      } catch {
        /* offline — the retry will just fail again, returning the rejection */
      }
      result = buildAndPush();
    }
    return result;
  } finally {
    try {
      rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
