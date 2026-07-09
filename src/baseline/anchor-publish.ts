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
}

export interface PublishResult {
  readonly pushed: boolean;
  readonly commit: string | null;
  /** Present when `pushed` is false — why (e.g. no origin, push rejected twice). */
  readonly reason?: string;
}

const DEFAULT_IDENTITY = { name: 'dxkit-bot', email: 'dxkit-bot@users.noreply.github.com' };

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
  const timeout = opts.timeoutMs ?? 60_000;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };

  const tmpIndex = path.join(mkdtempSync(path.join(tmpdir(), 'dxkit-anchor-idx-')), 'index');
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd,
      env: { ...env, GIT_INDEX_FILE: tmpIndex },
      timeout,
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    }).toString();

  try {
    // Confirm a remote exists — no origin ⇒ nothing to publish to.
    try {
      git(['remote', 'get-url', 'origin']);
    } catch {
      return { pushed: false, commit: null, reason: 'no origin remote' };
    }

    const buildAndPush = (): PublishResult => {
      const baseParent = opts.baseParent !== false;
      if (baseParent) {
        // Refresh the remote-tracking ref so `resolveTip` bases the commit on the
        // TRUE remote tip — a prior push-by-refspec doesn't reliably update the
        // local `origin/<ref>` on every git version, and this also picks up a
        // concurrent merge's advance before we build.
        try {
          git(['fetch', '--depth=1', 'origin', anchorRef]);
        } catch {
          /* first publish (ref absent) / offline — resolveTip returns null */
        }
      }
      const tip = baseParent ? resolveTip(git, anchorRef) : null;

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
      // No change vs the base tree → nothing to publish (idempotent refresh).
      if (tip && tree === tip.tree) {
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
          ? ['push', '--force', 'origin', pushRefspec]
          : ['push', 'origin', pushRefspec];
      try {
        git(pushArgs);
        return { pushed: true, commit };
      } catch (err) {
        return { pushed: false, commit, reason: `push rejected: ${(err as Error).message}` };
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
