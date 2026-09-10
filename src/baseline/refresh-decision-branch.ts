/**
 * The advisory decision branch's git plumbing, moved verbatim out of
 * `refresh.ts` at the large-file bar (the lane's orchestration stays there).
 * ONE standing branch, force-updated on every refresh; the working tree and
 * HEAD are never touched.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AllowlistEntry, AllowlistFile } from '../allowlist/file';
import { internalGitPushArgs } from '../git-internal-push';
import { noPromptGitEnv } from '../git-no-prompt';
import { invalidateAnchorReadMemo, readFromAnchorRef } from './anchor-publish';

/** The standing decision branch. ONE branch, force-updated — never a pile. */
export const ADVISORY_DECISION_BRANCH = 'dxkit/advisory-decision';

/**
 * Existing deferred entries on the standing decision branch, so a re-raise
 * (the branch is force-updated every refresh) preserves each advisory's
 * ORIGINAL expiry — re-dating on every refresh would quietly turn the 7-day
 * window into defer-forever, the exact failure the lane exists to prevent.
 * Since #389 this is ALSO the hold-out's "still pending" set: an advisory
 * here was held out by a previous refresh and is never announced as new.
 */
export function carryOverEntries(cwd: string): Map<string, AllowlistEntry> {
  const out = new Map<string, AllowlistEntry>();
  const raw = readFromAnchorRef(cwd, ADVISORY_DECISION_BRANCH, '.dxkit/allowlist.json');
  if (!raw) return out;
  try {
    const file = JSON.parse(raw) as AllowlistFile;
    for (const e of file.entries ?? []) {
      if (e.kind === 'dep-vuln' && e.category === 'deferred') out.set(e.fingerprint, e);
    }
  } catch {
    /* malformed standing content — regenerate from scratch */
  }
  return out;
}

/** Serialize an allowlist file exactly as `saveAllowlist` does (plain JSON,
 *  the `full`-mode format — the decision lane never writes sanitized mode). */
export function serializeAllowlist(file: AllowlistFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/**
 * Commit ONE file onto the standing decision branch, parented on the current
 * HEAD (so the PR is mergeable into the default branch), using a temp index —
 * the working tree and HEAD never move. Force-pushes the standing branch
 * (latest-wins; it is machine-owned) through the one internal-push argv.
 */
export function commitFileToDecisionBranch(
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): void {
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-decision-idx-')), 'idx');
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: 'dxkit-bot',
    GIT_AUTHOR_EMAIL: 'dxkit-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'dxkit-bot',
    GIT_COMMITTER_EMAIL: 'dxkit-bot@users.noreply.github.com',
    ...noPromptGitEnv({ cwd }),
  };
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    }).toString();

  git(['read-tree', 'HEAD']);
  const blob = git(['hash-object', '-w', '--stdin'], content).trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},${relPath}`]);
  const tree = git(['write-tree']).trim();
  const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', message]).trim();
  git(internalGitPushArgs(`${commit}:refs/heads/${ADVISORY_DECISION_BRANCH}`, { force: true }));
  // This push can CREATE the decision ref, so the anchor reader's per-process
  // absent-ref memo must forget it (the writer contract on the memo): the
  // next refresh in this process re-reads the branch instead of treating
  // every held-out advisory as brand new (which would roll its expiry).
  invalidateAnchorReadMemo(ADVISORY_DECISION_BRANCH);
}
