/**
 * Anchor hydration for the `anchor: 'branch'` transport.
 *
 * With that transport the committed baseline is NOT stored in the default
 * branch's working tree — it lives on a separate unprotected branch
 * (`anchorRef`, default `dxkit-baselines`) that the after-merge refresh
 * direct-pushes to (branch protection covers the default branch, not this one).
 * So the SIDE BRANCH is the source of truth; any copy in the working tree is
 * stale (only the refresh updates the side branch). Both the local and CI
 * guardrail check must read the anchor from the side branch, so their verdicts
 * agree — reading a stale tree copy locally is exactly the drift this closes.
 *
 * This module is the single reader of that side branch (`git show
 * origin/<anchorRef>:<path>`), in two flavors:
 *   - `loadAnchorFromBranch` — read-only: writes the anchor to a TEMP file and
 *     returns its path, never touching the working tree (what a `guardrail
 *     check` uses — a read must not mutate a tracked file).
 *   - `hydrateAnchorFromBranch` — materialize the anchor AT `baselinePath` (used
 *     when the tree copy is simply absent, e.g. a CI checkout).
 *
 * Both are scoped to `anchor === 'branch'` and fail-open on any git error (wrong
 * transport, side branch not created yet, offline) returns null/false and the
 * caller falls back to whatever is (or isn't) on disk. This is a transport
 * detail, never a place to hard-fail a check.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_ANCHOR_REF } from './modes';
import { readFromAnchorRef } from './anchor-publish';
import type { BaselineSection } from './policy';

/**
 * Fetch the baseline anchor's content from the side branch. Returns the file
 * text, or `null` when the transport is not `branch`, or the branch/file is
 * unreachable (not created yet, offline). Never throws. Gates on the baseline
 * `section` then delegates to the ONE side-ref reader `readFromAnchorRef`
 * (`anchor-publish.ts`) so baseline + reports read a side ref through the same
 * primitive (CLAUDE.md Rule 2).
 */
function anchorContentFromBranch(
  cwd: string,
  relPath: string,
  section: BaselineSection | undefined,
): string | null {
  if (section?.anchor !== 'branch') return null;
  const anchorRef = section.anchorRef ?? DEFAULT_ANCHOR_REF;
  return readFromAnchorRef(cwd, anchorRef, relPath);
}

function relFromCwd(cwd: string, baselinePath: string): string {
  return path.relative(cwd, baselinePath).split(path.sep).join('/');
}

/**
 * Read-only side-branch anchor read for a `guardrail check`. When
 * `section.anchor === 'branch'` and the side branch is reachable, writes the
 * anchor to a fresh temp file and returns its path (the caller reads it without
 * mutating the possibly-stale committed tree copy). Returns `null` for any other
 * transport, or when the side branch is unreachable (not created yet / offline)
 * — the caller then falls back to the on-disk copy.
 */
export function loadAnchorFromBranch(
  cwd: string,
  baselinePath: string,
  section: BaselineSection | undefined,
): string | null {
  const content = anchorContentFromBranch(cwd, relFromCwd(cwd, baselinePath), section);
  if (content == null) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-anchor-'));
  const tmp = path.join(dir, path.basename(baselinePath));
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

/**
 * Materialize the side-branch anchor AT `baselinePath` (creating parent dirs).
 * Returns `true` if written, `false` otherwise (wrong transport, or the
 * branch/file is unreachable). Use this only when the tree copy is absent (a CI
 * checkout, or a bootstrap) — for a read-only check prefer `loadAnchorFromBranch`
 * so the working tree is left untouched.
 */
export function hydrateAnchorFromBranch(
  cwd: string,
  baselinePath: string,
  section: BaselineSection | undefined,
): boolean {
  const content = anchorContentFromBranch(cwd, relFromCwd(cwd, baselinePath), section);
  if (content == null) return false;
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, content, 'utf8');
  return true;
}

/**
 * Health of the `branch`-transport anchor branch. `configured` is true when
 * the policy uses the branch transport; `remoteReachable` distinguishes an
 * offline probe (don't alarm) from a reachable remote that genuinely lacks
 * the branch; `branchExists` is the deletion signal. Doctor warns only when
 * `configured && remoteReachable && !branchExists` — a deleted anchor branch,
 * which silently strands the guardrail's committed baseline (#101).
 */
export interface AnchorBranchStatus {
  configured: boolean;
  anchorRef: string;
  remoteReachable: boolean;
  branchExists: boolean;
}

export function anchorBranchStatus(
  cwd: string,
  section: BaselineSection | undefined,
): AnchorBranchStatus {
  const configured = section?.anchor === 'branch';
  const anchorRef = section?.anchorRef ?? DEFAULT_ANCHOR_REF;
  if (!configured) {
    return { configured: false, anchorRef, remoteReachable: false, branchExists: false };
  }
  try {
    const out = execSync(`git ls-remote --heads origin ${JSON.stringify(anchorRef)}`, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    // Reachable: exit 0. Branch present iff a matching head ref was returned.
    return { configured: true, anchorRef, remoteReachable: true, branchExists: out.length > 0 };
  } catch {
    // Offline / no `origin` remote — unknown, not confirmed-missing.
    return { configured: true, anchorRef, remoteReachable: false, branchExists: false };
  }
}
