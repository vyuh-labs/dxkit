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
import { landRefreshPaths, makeExec, type Exec } from '../../land-refresh';
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

/**
 * Land the already-published snapshot changes per `mode`. Call AFTER
 * `publishFlow` wrote `.dxkit/flow/`; reads the delta against the caller's
 * pre-publish snapshot. No-op ('clean') when git sees no snapshot change.
 *
 * The git/gh mechanics live in the ONE generic lander
 * (`src/land-refresh.ts`, shared with the extensions refresh — Rule 2);
 * this function owns only the flow-shaped parts: the served delta, the
 * substance check (a publish restamps `generatedAt`/`commitSha` on every
 * run, and metadata churn must never land a commit), and the PR prose.
 */
export function landFlowRefresh(opts: LandOptions): LandResult {
  const delta = servedDelta(opts.before, readServedContract(opts.cwd));
  const { title, body } = refreshPrText(delta);

  const volatile = (c: ServedContract | ConsumedContract | undefined): string => {
    if (!c) return 'absent';
    const rest: Record<string, unknown> = { ...c };
    delete rest.generatedAt;
    delete rest.commitSha;
    return JSON.stringify(rest);
  };

  const result = landRefreshPaths({
    cwd: opts.cwd,
    mode: opts.mode,
    paths: [FLOW_DIR],
    branchName: FLOW_REFRESH_BRANCH,
    defaultBranch: opts.defaultBranch,
    commitTitle: 'chore(flow): refresh contract snapshots',
    prTitle: title,
    prBody: body,
    isSubstantive: () =>
      volatile(opts.before) !== volatile(readServedContract(opts.cwd)) ||
      volatile(opts.beforeConsumed) !== volatile(readConsumedContract(opts.cwd)),
    ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
  });

  return {
    outcome: result.outcome,
    mode: opts.mode,
    delta,
    ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    ...(result.note !== undefined ? { note: result.note } : {}),
  };
}
