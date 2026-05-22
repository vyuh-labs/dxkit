/**
 * Allowlist delta — what changed between two repo states.
 *
 * The guardrail check posts a PR comment whenever new allowlist
 * entries appear on the PR branch. Reviewers see the suppressions
 * being introduced and can sanity-check the typed category / reason
 * / expiry without manually grepping for `dxkit-allow:` lines.
 *
 * # Two-state comparison
 *
 * `computeAllowlistDelta` compares the current on-disk allowlist
 * (loaded via the canonical `loadAllowlist`) against the allowlist
 * at the baseline's commit SHA (read via `git show <sha>:.dxkit/...`).
 * Each entry's identity is its `fingerprint`; the delta is the
 * symmetric difference of the two fingerprint sets, hydrated back
 * to the full entries on each side.
 *
 *   added   — entries present in current but not at the baseline SHA
 *   removed — entries present at the baseline SHA but not in current
 *
 * # Graceful degradation
 *
 * When the baseline SHA isn't reachable (shallow clone, force-push
 * orphaned base), the delta reports `baselineAccessible: false` and
 * an empty `added` / `removed`. Callers (the renderer) treat that
 * as "delta unavailable" rather than "no changes" — surfacing the
 * incident so the customer can either deepen the clone or accept
 * the missing review signal.
 *
 * Architectural posture:
 *   - All IO goes through `loadAllowlist` (CLAUDE.md arch rule 1).
 *   - `git show` is the only direct git interaction; failure modes
 *     return null without throwing.
 *   - Pure function over both inputs (current allowlist + git-resolved
 *     baseline allowlist) — testable independently of git state.
 */

import { execFileSync } from 'child_process';
import {
  ALLOWLIST_DIR,
  ALLOWLIST_FILENAME,
  ALLOWLIST_SCHEMA_VERSION,
  loadAllowlist,
  type AllowlistEntry,
  type AllowlistFile,
} from './file';

export interface AllowlistDelta {
  /** Entries present in current but not at the baseline SHA. */
  readonly added: ReadonlyArray<AllowlistEntry>;
  /** Entries present at the baseline SHA but not in current. */
  readonly removed: ReadonlyArray<AllowlistEntry>;
  /** False when the baseline SHA wasn't reachable (shallow clone,
   *  force-push that orphaned the base). When false, added/removed
   *  are always empty — callers surface "delta unavailable" rather
   *  than "no changes." */
  readonly baselineAccessible: boolean;
}

/**
 * Compute the delta between the current on-disk allowlist and the
 * allowlist at the baseline's commit SHA. Returns a structurally
 * empty delta with `baselineAccessible: false` when the baseline
 * SHA can't be read.
 *
 * `baselineCommitSha` must be a non-empty hex SHA; an empty string
 * (the canonical "no commit" value baseline-create uses outside a
 * git repo) yields `baselineAccessible: false` immediately.
 */
export function computeAllowlistDelta(cwd: string, baselineCommitSha: string): AllowlistDelta {
  const current = loadAllowlist(cwd);
  const empty: AllowlistDelta = { added: [], removed: [], baselineAccessible: false };

  if (!baselineCommitSha) return empty;

  const baselineFile = readAllowlistAtSha(cwd, baselineCommitSha);
  if (baselineFile === null) {
    // git unreachable OR file genuinely didn't exist at the
    // baseline SHA. We can still produce a useful delta in the
    // "file didn't exist" case — every current entry is "added"
    // (the customer adopted the allowlist after baseline-create).
    // Distinguish the two cases by checking whether the SHA is at
    // least resolvable.
    if (!shaReachable(cwd, baselineCommitSha)) return empty;
    // SHA reachable but file absent → current entries are all new.
    return {
      added: current?.entries ?? [],
      removed: [],
      baselineAccessible: true,
    };
  }

  const currentEntries = current?.entries ?? [];
  return diffEntries(baselineFile.entries, currentEntries);
}

/**
 * Pure delta over two entry arrays. Exposed for testability —
 * callers without git state can synthesize before/after fixtures
 * directly. Uses fingerprint equality (the canonical identity
 * predicate) for set diff.
 */
export function diffEntries(
  prior: ReadonlyArray<AllowlistEntry>,
  current: ReadonlyArray<AllowlistEntry>,
): AllowlistDelta {
  const priorByFp = new Map<string, AllowlistEntry>();
  for (const e of prior) priorByFp.set(e.fingerprint, e);
  const currentByFp = new Map<string, AllowlistEntry>();
  for (const e of current) currentByFp.set(e.fingerprint, e);

  const added: AllowlistEntry[] = [];
  for (const [fp, e] of currentByFp) {
    if (!priorByFp.has(fp)) added.push(e);
  }
  const removed: AllowlistEntry[] = [];
  for (const [fp, e] of priorByFp) {
    if (!currentByFp.has(fp)) removed.push(e);
  }
  return { added, removed, baselineAccessible: true };
}

// ─── Internals ────────────────────────────────────────────────────────────

function readAllowlistAtSha(cwd: string, sha: string): AllowlistFile | null {
  const gitPath = `${ALLOWLIST_DIR}/${ALLOWLIST_FILENAME}`;
  let raw: string;
  try {
    raw = execFileSync('git', ['show', `${sha}:${gitPath}`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // File existed at the SHA but isn't valid JSON. Treat the same
    // as "absent" — no useful delta computable.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Partial<AllowlistFile>;
  if (obj.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) return null;
  if (!Array.isArray(obj.entries)) return null;
  return parsed as AllowlistFile;
}

function shaReachable(cwd: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', sha], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}
