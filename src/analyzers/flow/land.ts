/**
 * Landing a flow-contract refresh on the default branch — the tested home for
 * what would otherwise be workflow bash (the exact class the baseline refresh
 * consolidated out of its workflow: landing logic in the CLI, the workflow one
 * command).
 *
 * Flow snapshots live in the default branch's TREE (the gate reads them
 * offline), so an on-merge refresh must land a commit there. Two modes, chosen
 * by `.dxkit/policy.json:flow.refreshMode`:
 *
 *   - `pr` (default): push a `dxkit/flow-refresh` branch and open/update ONE
 *     standing PR. The review checkpoint sits exactly where it matters — a
 *     route REMOVAL will start flagging its consumers once merged, so a human
 *     sees removals before they arm the gate; pure additions are a rubber
 *     stamp (or a GitHub auto-merge, the user's choice). The PR body is a
 *     contract-change summary, not a JSON diff.
 *   - `push`: commit straight to the default branch with `[skip ci]` — zero
 *     ceremony for unprotected-trunk teams. A protected branch rejects it
 *     loudly (use `pr`).
 *
 * PR creation degrades gracefully: without a `gh` CLI (or outside GitHub) the
 * branch is still pushed and the result says "open the PR manually" — the
 * refresh never hard-fails on missing tooling (the workflow's job is the
 * snapshot; the PR is the vehicle).
 */
import { execFileSync } from 'child_process';
import {
  contractKey,
  FLOW_DIR,
  readConsumedContract,
  readServedContract,
  type ConsumedContract,
  type ServedContract,
} from './contract';

export type FlowLandMode = 'pr' | 'push';

/** The standing refresh branch (force-updated in place — never a pile). */
export const FLOW_REFRESH_BRANCH = 'dxkit/flow-refresh';

export interface ContractDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface LandResult {
  /** 'clean' = snapshots unchanged, nothing to land. */
  readonly outcome: 'clean' | 'pushed' | 'pr-opened' | 'pr-updated' | 'branch-pushed-no-pr';
  readonly mode: FlowLandMode;
  readonly delta: ContractDelta;
  /** PR URL when one was created / already open. */
  readonly prUrl?: string;
  /** Human-readable note (degradations, next step). */
  readonly note?: string;
}

/** `(method, path)` keys added/removed between two served contracts — the
 *  substance of a refresh, and what the PR body narrates. */
export function servedDelta(
  before: ServedContract | undefined,
  after: ServedContract | undefined,
): ContractDelta {
  const keys = (c: ServedContract | undefined): Set<string> =>
    new Set((c?.routes ?? []).map((r) => contractKey(r.method, r.path)));
  const a = keys(before);
  const b = keys(after);
  return {
    added: [...b].filter((k) => !a.has(k)).sort(),
    removed: [...a].filter((k) => !b.has(k)).sort(),
  };
}

/**
 * The standing PR's title + body from a delta (pure — testable without git).
 * Removals lead and carry the warning: they are the part a reviewer must
 * actually read.
 */
export function refreshPrText(delta: ContractDelta): { title: string; body: string } {
  const parts: string[] = [];
  if (delta.removed.length > 0) {
    parts.push(
      `### ⚠ ${delta.removed.length} route(s) removed\n\n` +
        delta.removed.map((k) => `- \`${k}\``).join('\n') +
        '\n\nOnce merged, the integration gate starts flagging any consumer still ' +
        'calling these. Verify the routes are really gone (not a renamed prefix or ' +
        'an extraction miss) before merging.',
    );
  }
  if (delta.added.length > 0) {
    parts.push(
      `### ${delta.added.length} route(s) added\n\n` +
        delta.added.map((k) => `- \`${k}\``).join('\n') +
        '\n\nAdditions are safe: they only let consumer calls resolve that previously ' +
        'read as `no-route`.',
    );
  }
  if (parts.length === 0) {
    parts.push(
      'Snapshot metadata refreshed (participant provenance / provenance SHAs) — no route changes.',
    );
  }
  parts.push(
    // PR-body prose naming the directory, not contract IO.
    '---\n_Auto-refreshed flow contract (`.dxkit/flow/`). One standing PR, updated in place ' + // flow-contract-ok
      'by the `dxkit-flow-refresh` workflow; enable auto-merge if additions-only updates ' +
      'need no ceremony._',
  );
  const title =
    delta.removed.length > 0
      ? `chore(flow): contract refresh — ${delta.removed.length} route(s) removed, review before merge`
      : 'chore(flow): contract refresh';
  return { title, body: parts.join('\n\n') };
}

interface Exec {
  (cmd: string, args: string[], opts?: { allowFail?: boolean }): string;
}

function makeExec(cwd: string): Exec {
  return (cmd, args, opts = {}) => {
    try {
      return execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch (e) {
      if (opts.allowFail) return '';
      throw e;
    }
  };
}

export interface LandOptions {
  readonly cwd: string;
  readonly mode: FlowLandMode;
  /** Contract state BEFORE the publish (captured by the caller). */
  readonly before: ServedContract | undefined;
  /** Consumed contract BEFORE the publish — part of the substance check. */
  readonly beforeConsumed?: ConsumedContract | undefined;
  /** Default branch the refresh targets in `push` mode. */
  readonly defaultBranch: string;
  /** Identity for the refresh commit. */
  readonly identity?: { readonly name: string; readonly email: string };
  /** Injectable exec for tests. */
  readonly exec?: Exec;
}

const BOT = { name: 'dxkit-bot', email: 'dxkit-bot@users.noreply.github.com' };

/**
 * Land the already-published snapshot changes per `mode`. Call AFTER
 * `publishFlow` wrote `.dxkit/flow/`; reads the delta against the caller's
 * pre-publish snapshot. No-op ('clean') when git sees no snapshot change.
 */
export function landFlowRefresh(opts: LandOptions): LandResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  const identity = opts.identity ?? BOT;
  const delta = servedDelta(opts.before, readServedContract(opts.cwd));

  const status = exec('git', ['status', '--porcelain', '--', FLOW_DIR]).trim();
  if (status === '') return { outcome: 'clean', mode: opts.mode, delta };

  // Every publish restamps `generatedAt` (and possibly `commitSha`), so a
  // byte-diff alone would land a metadata-churn commit on EVERY merge. Land
  // only on SUBSTANCE: routes, bindings, or participant provenance changed.
  // A pure-timestamp refresh reverts the files and reports clean.
  const volatile = (c: ServedContract | ConsumedContract | undefined): string => {
    if (!c) return 'absent';
    const rest: Record<string, unknown> = { ...c };
    delete rest.generatedAt;
    delete rest.commitSha;
    return JSON.stringify(rest);
  };
  const substantive =
    volatile(opts.before) !== volatile(readServedContract(opts.cwd)) ||
    volatile(opts.beforeConsumed) !== volatile(readConsumedContract(opts.cwd));
  if (!substantive) {
    exec('git', ['checkout', '--', FLOW_DIR], { allowFail: true });
    return { outcome: 'clean', mode: opts.mode, delta };
  }

  const commit = (message: string): void => {
    exec('git', ['add', FLOW_DIR]);
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
    // Zero-ceremony mode: straight to the default branch. `[skip ci]` keeps the
    // refresh from re-triggering itself; a protected branch rejects the push
    // loudly (the caller surfaces the error — switch to `pr`).
    commit('chore(flow): refresh contract snapshots [skip ci]');
    exec('git', ['push', 'origin', `HEAD:${opts.defaultBranch}`]);
    return { outcome: 'pushed', mode: 'push', delta };
  }

  // PR mode: one standing branch, force-updated (never a pile). Created at
  // HEAD with the snapshot change committed on top. On a LOCAL run, restore
  // whatever the user had checked out afterwards (CI checkouts are detached /
  // ephemeral and skip the restore) — landing a refresh must never leave a
  // human stranded on the bot branch.
  const priorRef = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).trim();
  exec('git', ['checkout', '-B', FLOW_REFRESH_BRANCH]);
  const { title, body } = refreshPrText(delta);
  commit(`${title}\n\n[skip ci]`);
  exec('git', ['push', '--force', 'origin', FLOW_REFRESH_BRANCH]);
  if (priorRef && priorRef !== 'HEAD' && priorRef !== FLOW_REFRESH_BRANCH) {
    exec('git', ['checkout', priorRef], { allowFail: true });
  }

  // The PR itself is best-effort: no gh / not GitHub → the branch still landed.
  const existing = exec(
    'gh',
    ['pr', 'list', '--head', FLOW_REFRESH_BRANCH, '--state', 'open', '--json', 'url'],
    { allowFail: true },
  ).trim();
  let parsed: Array<{ url: string }> = [];
  try {
    parsed = existing ? (JSON.parse(existing) as Array<{ url: string }>) : [];
  } catch {
    parsed = [];
  }
  if (parsed.length > 0) {
    // Standing PR exists — refresh its face to match the new delta.
    exec('gh', ['pr', 'edit', FLOW_REFRESH_BRANCH, '--title', title, '--body', body], {
      allowFail: true,
    });
    return { outcome: 'pr-updated', mode: 'pr', delta, prUrl: parsed[0].url };
  }
  const created = exec(
    'gh',
    [
      'pr',
      'create',
      '--head',
      FLOW_REFRESH_BRANCH,
      '--base',
      opts.defaultBranch,
      '--title',
      title,
      '--body',
      body,
    ],
    { allowFail: true },
  ).trim();
  if (created) {
    const url = created.split('\n').pop() ?? '';
    return { outcome: 'pr-opened', mode: 'pr', delta, ...(url ? { prUrl: url } : {}) };
  }
  return {
    outcome: 'branch-pushed-no-pr',
    mode: 'pr',
    delta,
    note:
      `Pushed '${FLOW_REFRESH_BRANCH}' but could not open the PR (no gh CLI / not GitHub / ` +
      `no permission). Open it manually: ${FLOW_REFRESH_BRANCH} → ${opts.defaultBranch}.`,
  };
}
