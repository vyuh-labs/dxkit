/**
 * Landing a refresh commit on the default branch — the ONE tested home for
 * what would otherwise be workflow bash, shared by every on-merge refresh
 * surface that updates TRACKED files (flow contract snapshots, extension
 * snapshots). Side-ref publishes are a different mechanism entirely
 * (src/baseline/anchor-publish.ts); this module is for changes that must
 * land in the default branch's tree because gates read them offline.
 *
 * Two modes (the flow-refresh semantics, generalized):
 *   - `pr`: push a STANDING branch (force-updated in place — never a pile)
 *     and open/update one PR. The review checkpoint sits where it matters;
 *     PR creation degrades gracefully (no `gh` / not GitHub → the branch is
 *     still pushed and the result says "open it manually").
 *   - `push`: commit straight to the default branch with `[skip ci]` — zero
 *     ceremony; a protected branch rejects it loudly (use `pr`).
 *
 * The caller owns everything domain-shaped: which paths, the substance
 * check (so metadata churn never lands a commit), and the PR prose. This
 * module owns only the git/gh mechanics, extracted verbatim from the flow
 * lander so the two consumers cannot drift (Rule 2).
 */
import { execFileSync } from 'child_process';
import { internalGitPushArgs } from './git-internal-push';

export type LandMode = 'pr' | 'push';

export type Exec = (
  bin: string,
  args: readonly string[],
  opts?: {
    allowFail?: boolean;
    /** Piped to stdin (git plumbing like `hash-object --stdin`). */
    input?: string;
    /** Extra env vars layered over the process env (e.g. GIT_INDEX_FILE). */
    env?: Readonly<Record<string, string>>;
  },
) => string;

/** Real exec: capture stdout, tolerate failure only when asked. The ONE
 *  machine git-exec factory (Rule 2): every lane spawn inherits the
 *  no-prompt hardening below instead of minting its own wrapper. */
export function makeExec(cwd: string): Exec {
  return (bin, args, opts = {}) => {
    try {
      return execFileSync(bin, [...args], {
        cwd,
        encoding: 'utf8',
        // Never hang a machine spawn on an interactive credential prompt; a
        // bad remote fails fast and the caller surfaces it. Both prompt
        // paths are disabled (HTTPS and SSH), the remote-ref discipline.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
          ...(opts.env ?? {}),
        },
        timeout: 60_000,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      }).toString();
    } catch (e) {
      if (opts.allowFail) return '';
      throw e;
    }
  };
}

export interface LandRefreshOptions {
  readonly cwd: string;
  readonly mode: LandMode;
  /** Git pathspecs the refresh may have touched (added + status-checked). */
  readonly paths: readonly string[];
  /** The standing refresh branch (`dxkit/<surface>-refresh`). */
  readonly branchName: string;
  readonly defaultBranch: string;
  /** Commit subject; push mode appends `[skip ci]` (a direct artifact
   *  refresh on the default branch should not churn CI). */
  readonly commitTitle: string;
  readonly prTitle: string;
  readonly prBody: string;
  /**
   * Stamp `[skip ci]` on the PR-mode head commit too (#304). Default FALSE:
   * GitHub honors the marker for `pull_request` workflows, so a stamped
   * standing PR can never run a single check — a code-carrying lane PR then
   * presents with zero CI, silently defeats the lane PAT tier's stated
   * purpose, and under required checks is permanently unmergeable (the
   * PR-mode sibling of the push-mode deadlock enforcement.ts documents).
   * Only an artifact-only refresh PR that deliberately wants silent updates
   * opts in — per consumer, never as the shared default.
   */
  readonly prSkipCi?: boolean;
  /**
   * Substance check, run only when git sees a byte diff: return false to
   * REVERT the paths and land nothing (a timestamp-only refresh must not
   * commit on every merge). Default: any diff is substantive.
   */
  readonly isSubstantive?: () => boolean;
  readonly identity?: { readonly name: string; readonly email: string };
  readonly exec?: Exec;
}

export interface LandRefreshResult {
  readonly outcome: 'clean' | 'pushed' | 'pr-opened' | 'pr-updated' | 'branch-pushed-no-pr';
  readonly mode: LandMode;
  readonly prUrl?: string;
  readonly note?: string;
}

/** The ONE machine-commit identity (Rule 2): the refresh lander, the
 *  remediate lane's sweep + ledger commits, and the remediate workflow's
 *  `git config` step (rendered from this constant) all use it — a CI runner
 *  has no ambient git identity, so every lane commit must carry its own. */
export const BOT_IDENTITY = {
  name: 'dxkit-bot',
  email: 'dxkit-bot@users.noreply.github.com',
} as const;
const BOT = BOT_IDENTITY;

export function landRefreshPaths(opts: LandRefreshOptions): LandRefreshResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  const identity = opts.identity ?? BOT;
  const paths = [...opts.paths];

  const status = exec('git', ['status', '--porcelain', '--', ...paths]).trim();
  if (status === '') return { outcome: 'clean', mode: opts.mode };

  if (opts.isSubstantive && !opts.isSubstantive()) {
    exec('git', ['checkout', '--', ...paths], { allowFail: true });
    return { outcome: 'clean', mode: opts.mode };
  }

  const commit = (message: string): void => {
    exec('git', ['add', ...paths]);
    exec('git', [
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '-m',
      message,
    ]);
  };

  if (opts.mode === 'push') {
    commit(`${opts.commitTitle} [skip ci]`);
    // Internal machine push → `--no-verify` (gh #156): must not fire the repo's
    // own pre-push guardrail hook against a bot refresh commit.
    exec('git', internalGitPushArgs(`HEAD:${opts.defaultBranch}`));
    return { outcome: 'pushed', mode: 'push' };
  }

  // PR mode: one standing branch, force-updated. On a LOCAL run, restore
  // whatever the user had checked out afterwards (CI checkouts are detached /
  // ephemeral and skip the restore) — landing a refresh must never leave a
  // human stranded on the bot branch.
  const priorRef = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).trim();
  exec('git', ['checkout', '-B', opts.branchName]);
  // Clean head commit by default (#304): the PR is the review vehicle, and a
  // PR that runs no checks is not reviewable in any meaningful sense.
  commit(opts.prSkipCi ? `${opts.prTitle}\n\n[skip ci]` : opts.prTitle);
  // Internal machine push → `--no-verify` (gh #156), same reason as the push mode.
  exec('git', internalGitPushArgs(opts.branchName, { force: true }));
  if (priorRef && priorRef !== 'HEAD' && priorRef !== opts.branchName) {
    exec('git', ['checkout', priorRef], { allowFail: true });
  }

  return openOrUpdateStandingPr(exec, {
    branchName: opts.branchName,
    defaultBranch: opts.defaultBranch,
    prTitle: opts.prTitle,
    prBody: opts.prBody,
  });
}

/**
 * Open (or update in place) the ONE standing PR for a refresh branch that has
 * already been pushed. Best-effort: no `gh` / not GitHub / no permission → the
 * branch still landed and the result says to open it manually. Extracted so
 * every standing-PR surface (this lander's `pr` mode, the advisory decision
 * lane) shares one implementation of the gh mechanics (Rule 2).
 */
export function openOrUpdateStandingPr(
  exec: Exec,
  opts: {
    readonly branchName: string;
    readonly defaultBranch: string;
    readonly prTitle: string;
    readonly prBody: string;
    /** Open as a DRAFT (the remediate lane's budget-exhausted salvage). An
     *  EXISTING PR's draft state is left as the reviewer set it. */
    readonly draft?: boolean;
  },
): LandRefreshResult {
  const existing = exec(
    'gh',
    ['pr', 'list', '--head', opts.branchName, '--state', 'open', '--json', 'url'],
    { allowFail: true },
  ).trim();
  let parsed: Array<{ url: string }> = [];
  try {
    parsed = existing ? (JSON.parse(existing) as Array<{ url: string }>) : [];
  } catch {
    parsed = [];
  }
  if (parsed.length > 0) {
    exec('gh', ['pr', 'edit', opts.branchName, '--title', opts.prTitle, '--body', opts.prBody], {
      allowFail: true,
    });
    return { outcome: 'pr-updated', mode: 'pr', prUrl: parsed[0].url };
  }
  const created = exec(
    'gh',
    [
      'pr',
      'create',
      '--head',
      opts.branchName,
      '--base',
      opts.defaultBranch,
      '--title',
      opts.prTitle,
      '--body',
      opts.prBody,
      ...(opts.draft ? ['--draft'] : []),
    ],
    { allowFail: true },
  ).trim();
  if (created) {
    const url = created.split('\n').pop() ?? '';
    return { outcome: 'pr-opened', mode: 'pr', ...(url ? { prUrl: url } : {}) };
  }
  return {
    outcome: 'branch-pushed-no-pr',
    mode: 'pr',
    note:
      `Pushed '${opts.branchName}' but could not open the PR (no gh CLI / not GitHub / ` +
      `no permission). Under GitHub Actions the usual cause is the repo/org setting ` +
      `"Allow GitHub Actions to create and approve pull requests" being off ` +
      `(Settings > Actions > General > Workflow permissions). Open the PR manually ` +
      `meanwhile: ${opts.branchName} -> ${opts.defaultBranch}.`,
  };
}
