/**
 * The ONE constructor for a dxkit-INTERNAL (machine) `git push` argv.
 *
 * Every push dxkit performs ITSELF — side-ref anchors (`baseline publish` /
 * `report snapshot` via `src/baseline/anchor-publish.ts`) and refresh lands (flow
 * contract / extension snapshots via `src/land-refresh.ts`) — is a MACHINE
 * operation, never a gated developer push. It therefore MUST carry `--no-verify`.
 *
 * Why (gh #156, load-bearing): an internal push runs `git` in a checkout where
 * `core.hooksPath=.githooks` is active whenever dxkit is installed with git
 * hooks. Without `--no-verify` the push fires the repo's OWN `pre-push` hook —
 * dxkit's `guardrail check` — as a side effect of a machine refresh. Under the
 * bounded exec timeout every internal push wraps that in, the hook is SIGTERM'd
 * mid-run → ETIMEDOUT. That timeout was misread as "the remote did not
 * authenticate" and cost four debug builds chasing a non-existent auth bug; the
 * push never even reached the network. Skipping the hook is the fix, and it's
 * also just correct: dxkit must not run a developer's pre-push gate against its
 * own bot commits.
 *
 * A developer's own `git push` stays fully gated — that push is the human's and
 * does NOT go through dxkit. dxkit gates its own machine pushes never.
 *
 * `scripts/check-architecture.sh` bans a raw `['push', …]` git argv anywhere in
 * `src/` except this module, so a future internal push cannot silently drop the
 * flag and reintroduce the class.
 */
export function internalGitPushArgs(
  refspec: string,
  opts: { readonly force?: boolean; readonly remote?: string } = {},
): string[] {
  return [
    'push',
    '--no-verify',
    ...(opts.force ? ['--force'] : []),
    opts.remote ?? 'origin',
    refspec,
  ];
}
