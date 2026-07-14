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
   *  argv (e.g. the CI-auth extraheader reaches the push) without a real remote.
   *  Receives the FULL argv including any prepended auth `-c …` config. */
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
 * A credentialed HTTPS push URL for `originUrl` using the CI token, or `null`
 * when none applies. The load-bearing fix for the after-merge refresh regression
 * (gh #156): the 2.x refresh ran an inline `git push` inside the checkout, so it
 * reused the credential `actions/checkout` persists; when 3.1.0 moved the
 * refresh to this shared side-ref writer, the plumbing push stopped reusing that
 * ambient credential and hung → ETIMEDOUT with no auth. So when the workflow
 * exposes the CI token in the env (`GITHUB_TOKEN` / `GH_TOKEN` — GitHub Actions
 * only puts it there when the step maps `${{ github.token }}`), the writer
 * points `origin` at a token-credentialed URL for the operation (the mechanism
 * proven to authenticate in real Actions; an `http.extraheader` override did
 * NOT take — the real-CI smoke caught that).
 *
 * HTTPS only — an SSH origin authenticates by key (BatchMode handles the no-key
 * case). Any credentials already in the URL are stripped first. No token →
 * `null`, and the push falls back to the ambient credential (local dev: the
 * user's credential helper / SSH agent), so nothing changes off-CI.
 */
export function ciCredentialedUrl(
  originUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) return null;
  const m = /^https:\/\/(?:[^@/]*@)?(.+)$/.exec(originUrl); // strip any existing creds
  if (!m) return null; // ssh:// or git@host:… — token URL does not apply
  return `https://x-access-token:${token}@${m[1]}`;
}

/**
 * Turn a failed `git push` into an ACTIONABLE reason (gh #156). A bare
 * `push rejected: Command failed … ETIMEDOUT` reads as a mystery hang; the
 * caller (and CI logs) need to know it was a stuck/denied AUTH handshake and
 * what to check. A timeout after the prompt guards above almost always means
 * the remote never authenticated (the CI token lacks `contents: write`, or the
 * checkout didn't persist push credentials) rather than a slow network.
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
      `push timed out after ${Math.round(timeoutMs / 1000)}s with no response — the remote did ` +
      `not authenticate. In GitHub Actions ensure the job grants \`contents: write\` and the ` +
      `checkout persists push credentials (actions/checkout with \`persist-credentials: true\`); ` +
      `locally ensure your git credential helper / SSH key can push to origin.`
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
  const env = {
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
  // CI auth (gh #156): the plumbing writer does not reliably reuse the
  // credential actions/checkout persists. When the env carries a CI token we
  // point the NETWORK commands (fetch / ls-remote / push) DIRECTLY at a
  // token-credentialed URL — the exact form a raw `git ls-remote` proves
  // authenticates in Actions (a `set-url origin` rewrite or an
  // `http.extraheader` override did NOT take — the real-CI smoke caught both).
  // `credential.helper=` is disabled alongside so no ambient helper can hang the
  // handshake. Off-CI (no token) `netRemote` stays `origin` and nothing changes.
  const authPrefix: string[] = [];
  const exec = opts._exec ?? realExec;
  const git = (args: string[], input?: string): string => exec([...authPrefix, ...args], input);

  try {
    // Confirm a remote exists — no origin ⇒ nothing to publish to.
    let originUrl: string;
    try {
      originUrl = git(['remote', 'get-url', 'origin']).trim();
    } catch {
      return { pushed: false, commit: null, reason: 'no origin remote' };
    }
    const credUrl = ciCredentialedUrl(originUrl, env);
    // The remote for every NETWORK op below: the credentialed URL in CI, else
    // `origin`. Fetching by URL does not update `origin/<ref>` on its own, so the
    // fetch below carries an explicit refspec that does (resolveTip reads it).
    const netRemote = credUrl ?? 'origin';
    if (credUrl) authPrefix.push('-c', 'credential.helper=');

    const buildAndPush = (): PublishResult => {
      const baseParent = opts.baseParent !== false;
      // Refresh the remote-tracking ref so `resolveTip` sees the TRUE remote
      // tip — a prior push-by-refspec doesn't reliably update the local
      // `origin/<ref>` on every git version, and this also picks up a
      // concurrent merge's advance before we build. Both modes need it:
      // accumulate bases the commit on it, replace-all compares against it for
      // the no-change skip below. Explicit refspec so a URL fetch updates
      // `origin/<ref>` too.
      try {
        git([
          'fetch',
          '--depth=1',
          netRemote,
          `+refs/heads/${anchorRef}:refs/remotes/origin/${anchorRef}`,
        ]);
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
        remoteRefExists(git, netRemote, anchorRef) !== false
      ) {
        return { pushed: false, commit: null, reason: 'no change' };
      }
      const commitArgs = ['commit-tree', tree, '-m', opts.message];
      if (tip) commitArgs.push('-p', tip.commit);
      const commit = git(commitArgs).trim();

      // Accumulate: a plain (fast-forward) push; a concurrent-merge rejection is
      // retried once below. Replace-all (`baseParent:false`, latest-wins like the
      // baseline anchor): a parentless commit is non-fast-forward by design, so
      // force-overwrite the ref.
      const pushRefspec = `${commit}:refs/heads/${anchorRef}`;
      const pushArgs =
        baseParent === false
          ? ['push', '--force', netRemote, pushRefspec]
          : ['push', netRemote, pushRefspec];
      try {
        git(pushArgs);
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
        git([
          'fetch',
          '--depth=1',
          netRemote,
          `+refs/heads/${anchorRef}:refs/remotes/origin/${anchorRef}`,
        ]);
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
