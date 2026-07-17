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
 * This module is the single reader AND the single publisher of that side
 * branch, so the two sides cannot drift (CLAUDE.md Rule 2 — the read and the
 * write resolve the transport + ref from the SAME policy section):
 *   - `loadAnchorFromBranch` — read-only: writes the anchor to a TEMP file and
 *     returns its path, never touching the working tree (what a `guardrail
 *     check` uses — a read must not mutate a tracked file).
 *   - `hydrateAnchorFromBranch` — materialize the anchor AT `baselinePath` (used
 *     when the tree copy is simply absent, e.g. a CI checkout).
 *   - `publishBaselineAnchor` — publish `.dxkit/baselines/` to the side branch
 *     through the canonical side-ref writer (`anchor-publish.ts`), replace-all
 *     (latest-wins). What `vyuh-dxkit baseline publish` and therefore the
 *     after-merge refresh workflow run — never an inline `git push` in a
 *     workflow's bash.
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
import {
  publishFilesToAnchorRef,
  readFromAnchorRef,
  type AnchorFile,
  type PublishResult,
} from './anchor-publish';
import { loadPolicyFromCwd, type BaselineSection } from './policy';

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

/**
 * The dangerous anchor↔local divergence, pure over the two parsed baseline
 * payloads (VERIFY-40 F-6): update's migration lanes rewrite the LOCAL file,
 * but the branch-transport guardrail reads the ANCHOR — a migrated local over
 * a pre-migration anchor means every check still drifts (or CANNOT GATE)
 * while `update` and this file both look done. Only the migration-shaped
 * divergences alarm; ordinary content lag (CI refreshed the anchor after a
 * merge, the local copy is older) is normal and stays quiet.
 */
export function anchorStalenessFromContents(
  anchor: { identityScheme?: unknown; recall?: unknown } | null,
  local: { identityScheme?: unknown; recall?: unknown } | null,
): string | null {
  if (anchor == null || local == null) return null;
  if (local.identityScheme && anchor.identityScheme !== local.identityScheme) {
    return (
      `the anchor branch holds identity scheme '${String(anchor.identityScheme ?? 'pre-v2')}' ` +
      `while the local baseline is '${String(local.identityScheme)}'`
    );
  }
  if (local.recall != null && anchor.recall == null) {
    return 'the anchor branch predates recall attribution while the local baseline carries it';
  }
  return null;
}

/**
 * IO wrapper over `anchorStalenessFromContents`: reads the side-branch anchor
 * (when the transport is `branch` and the branch is reachable) and the local
 * baseline file. `null` on any unreadable side — the presence probe above
 * covers absence; this probe only speaks when it can actually compare.
 */
export function anchorStalenessProblem(
  cwd: string,
  baselinePath: string,
  section: BaselineSection | undefined,
): string | null {
  try {
    const tmp = loadAnchorFromBranch(cwd, baselinePath, section);
    if (tmp == null || !fs.existsSync(baselinePath)) return null;
    return anchorStalenessFromContents(
      JSON.parse(fs.readFileSync(tmp, 'utf8')),
      JSON.parse(fs.readFileSync(baselinePath, 'utf8')),
    );
  } catch {
    return null;
  }
}

/** Outcome of a `baseline publish`. `ok:false` carries `error` (wrong
 *  transport / nothing captured); a transport failure (no origin, rejected
 *  push) surfaces on `publish.reason` with `ok:true` left false-ish only via
 *  `publish.pushed` — the CLI decides loud-vs-quiet per reason. */
export interface BaselineAnchorPublishOutcome {
  readonly ok: boolean;
  readonly anchorRef: string;
  /** Files published (count of `.dxkit/baselines/` entries). */
  readonly files: number;
  /** The side branch was missing on a reachable remote and this publish
   *  recreated it — the deleted-anchor self-heal path. */
  readonly selfHealed: boolean;
  readonly publish?: PublishResult;
  readonly error?: string;
}

/** Collect every file under `.dxkit/baselines/` as anchor files (repo-relative
 *  POSIX paths) — exactly what the guardrail reader resolves off the ref. */
function collectBaselineFiles(cwd: string): AnchorFile[] {
  const root = path.join(cwd, '.dxkit', 'baselines');
  const out: AnchorFile[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        out.push({
          path: path.relative(cwd, abs).split(path.sep).join('/'),
          content: fs.readFileSync(abs, 'utf8'),
        });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Publish the on-disk `.dxkit/baselines/` to the anchor side branch —
 * replace-all (latest-wins), through the ONE side-ref writer. Resolves the
 * transport + ref from the SAME policy section the guardrail reader uses, so
 * the two sides cannot disagree about where the anchor lives. Refuses (ok:false)
 * when the policy transport is not `branch` — publishing to a side branch the
 * check would never read is exactly the drift this module exists to prevent.
 *
 * Idempotent + self-healing via the writer: identical content pushes nothing,
 * while a deleted side branch is recreated even when the content is unchanged.
 */
export function publishBaselineAnchor(
  cwd: string,
  sectionOverride?: BaselineSection,
): BaselineAnchorPublishOutcome {
  let section = sectionOverride;
  if (section === undefined) {
    try {
      section = loadPolicyFromCwd(cwd).baseline;
    } catch {
      section = undefined;
    }
  }
  const anchorRef = section?.anchorRef ?? DEFAULT_ANCHOR_REF;
  if (section?.anchor !== 'branch') {
    return {
      ok: false,
      anchorRef,
      files: 0,
      selfHealed: false,
      error:
        "the baseline anchor transport is not 'branch' — set .dxkit/policy.json:baseline.anchor " +
        "to 'branch' (the guardrail check only reads a side-branch anchor when the policy says so).",
    };
  }
  const files = collectBaselineFiles(cwd);
  if (files.length === 0) {
    return {
      ok: false,
      anchorRef,
      files: 0,
      selfHealed: false,
      error: 'no baseline captured — run `baseline create` first (.dxkit/baselines/ is empty).',
    };
  }

  // Probe BEFORE publishing so a recreated-after-deletion push is reported as
  // the self-heal it is (doctor's deleted-anchor warning points here as the repair).
  const before = anchorBranchStatus(cwd, section);
  const missing = before.remoteReachable && !before.branchExists;

  const publish = publishFilesToAnchorRef({
    cwd,
    anchorRef,
    files,
    message: 'chore(baseline): refresh anchor',
    baseParent: false,
  });
  return {
    ok: true,
    anchorRef,
    files: files.length,
    selfHealed: missing && publish.pushed,
    publish,
  };
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
