/**
 * Remote-repo ref checkout — the cross-repo sibling of `withRefWorktree`
 * (`./ref-baseline.ts`). Where that checks out a ref from the CURRENT repo's
 * object DB, this fetches a repo we do NOT have locally — a cross-repo flow
 * participant declared by a `repo:` URL (`flow publish`).
 *
 * Split out of `ref-baseline.ts` to keep each module a cohesive unit; the two
 * still share the one "do something at a git ref" contract (CLAUDE.md Rule 11)
 * and the same `RefBaselineError`. The arch-check confines `git worktree
 * add/remove` to `ref-baseline.ts`; this module uses clone/fetch, never a
 * worktree, so it lives here without tripping that rule.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { RefBaselineError } from './ref-baseline';

export interface RemoteRefOptions {
  /** Clone URL: `https://…`, `git@host:owner/repo.git`, `ssh://…`, or `file://`. */
  readonly repo: string;
  /** Branch / tag / advertised commit to fetch. Omitted → the remote's HEAD. */
  readonly ref?: string;
  /** Network-op deadline in ms (default 60s). A stalled fetch must never wedge
   *  a gate — combined with the disabled auth prompts, a bad remote fails fast. */
  readonly timeoutMs?: number;
}

/**
 * Reject a git argument that could be interpreted as an option (leading `-`) or
 * that carries control characters. The `repo`/`ref` values originate in the
 * repo's committed `.dxkit/workspace.json` (the same trust boundary as its CI
 * config), and `execFileSync` already prevents shell injection by passing args
 * as an array — this closes the remaining ARGUMENT-injection vector (a `repo`
 * of `--upload-pack=…`, a `ref` of `--exec=…`).
 */
function assertSafeGitArg(kind: 'repo' | 'ref', value: string): void {
  if (value.startsWith('-')) {
    throw new RefBaselineError(
      `Refusing a participant ${kind} that begins with '-': ${JSON.stringify(value)}.`,
      `A leading dash would be parsed as a git option. Fix the ${kind} in .dxkit/workspace.json.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new RefBaselineError(
      `Refusing a participant ${kind} containing control characters.`,
      `Fix the ${kind} in .dxkit/workspace.json.`,
    );
  }
}

/**
 * Clone a REMOTE repo at a ref into a temp dir, run `fn` against the checkout,
 * then remove it. Where `withRefWorktree` checks out a ref from the CURRENT
 * repo's object DB, this fetches a repo we do NOT have locally — a cross-repo
 * flow participant declared by a `repo:` URL, so `flow publish` composes on it
 * rather than scattering clone/fetch calls.
 *
 * A shallow, single-ref fetch (`--depth 1`): the served-contract gather needs
 * only the tree at one ref, never history. `ref` may be a branch, tag, or
 * advertised commit; omitted → the remote's default HEAD.
 *
 * Auth is the AMBIENT git environment (SSH agent for `git@…`, the credential
 * helper / a token-in-URL for `https://…`) — dxkit never handles credentials
 * itself, the same boundary as the repo's own git operations. BOTH interactive
 * prompt paths are disabled (`GIT_TERMINAL_PROMPT=0` and SSH `BatchMode=yes`) so
 * a missing credential fails FAST instead of hanging a headless gate, and the
 * network op is time-bounded. Any failure throws `RefBaselineError`; the caller
 * (`flow publish`) degrades that participant to "unreachable — skipped".
 */
export async function withRemoteRefWorktree<T>(
  opts: RemoteRefOptions,
  fn: (checkoutPath: string) => Promise<T>,
): Promise<T> {
  assertSafeGitArg('repo', opts.repo);
  const ref = opts.ref && opts.ref.trim() ? opts.ref.trim() : 'HEAD';
  if (ref !== 'HEAD') assertSafeGitArg('ref', ref);

  const tempBase = mkdtempSync(path.join(tmpdir(), 'dxkit-remote-'));
  const checkout = path.join(tempBase, 'repo');
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // never prompt for HTTPS credentials — fail fast
    // Never prompt for an SSH passphrase / host-key. Respect a user-set
    // GIT_SSH_COMMAND, else force batch mode.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
  const timeout = opts.timeoutMs ?? 60_000;
  const git = (args: readonly string[]): void => {
    execFileSync('git', args as string[], {
      cwd: checkout,
      env,
      timeout,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  };
  try {
    // Only the git clone/fetch is wrapped into a RefBaselineError — an error
    // from `fn` (the gather) must propagate as its own type, exactly as
    // `withRefWorktree` keeps them distinct.
    try {
      mkdirSync(checkout, { recursive: true });
      git(['init', '-q']);
      git(['remote', 'add', 'origin', opts.repo]);
      git(['fetch', '--depth', '1', '--quiet', 'origin', ref]);
      git(['checkout', '-q', 'FETCH_HEAD']);
    } catch {
      throw new RefBaselineError(
        `Failed to fetch participant repo ${opts.repo} at ${ref}.`,
        `Check the URL and that git can authenticate to it (dxkit uses your ambient ` +
          `git credentials, no prompts). For a private repo, ensure an SSH key or ` +
          `credential helper is configured. Ref must be a branch, tag, or advertised commit.`,
      );
    }
    return await fn(checkout);
  } finally {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — a stale temp dir beats masking a real result.
    }
  }
}
