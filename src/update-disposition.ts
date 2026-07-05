/**
 * The per-file disposition `update` (and a re-init over an existing dxkit
 * install) uses to decide, for each managed file, whether to WRITE the shipped
 * template or SKIP and preserve what's on disk.
 *
 * This is the update-side mirror of `uninstall`'s provenance model (2.27): both
 * paths must agree on what dxkit owns vs what the user owns, read from the same
 * manifest fields (`provenance` + `hash`). Before this, update decided purely on
 * "does the file exist?" + `--force`, which produced two shipped bugs:
 *   - #10: dxkit's OWN unmodified files (skills, workflows) were treated as
 *     "user-evolved, preserve", so a fixed template in a new version was never
 *     delivered — update no-op'd the very files it exists to refresh.
 *   - #11: `--force` overwrote user-authored files (a project's own AGENTS.md /
 *     CLAUDE.md / a Stop hook in settings.json) — the manifest already recorded
 *     them as `provenance: 'skipped'` (user-owned), but the write path never
 *     read it.
 *
 * The rules:
 *   - absent on disk           → WRITE (re)create the dxkit-owned/new file
 *   - evolving (user prose)    → SKIP, never overwrite
 *   - untracked + present      → SKIP, the user owns a file dxkit never wrote
 *   - provenance 'skipped'     → SKIP even with --force, the user owned it at
 *                                install time
 *   - dxkit-owned, unmodified  → WRITE (refresh — this delivers shipped fixes)
 *   - dxkit-owned, user-edited → SKIP unless --force re-applies the template;
 *                                for a user-merge target (settings.json /
 *                                CLAUDE.md / AGENTS.md — files the user extends
 *                                and a full overwrite always loses their part)
 *                                SKIP even under --force.
 */

import type { ManifestFileEntry } from './types';

export type UpdateDecision = 'write' | 'skip';

export interface UpdateDispositionInput {
  /** The file exists on disk right now. */
  exists: boolean;
  /** An "evolving" user-maintained file (gotchas / conventions) — never
   *  overwritten once it exists. */
  evolving: boolean;
  /** The prior manifest entry for this path, or `undefined` when dxkit never
   *  tracked it (a file the user owns). */
  priorEntry: ManifestFileEntry | undefined;
  /** Lazily-computed sha256 of the current on-disk content. A thunk so we don't
   *  read a file we're going to write regardless. */
  onDiskHash: () => string;
  /** `--force` was passed. */
  force: boolean;
  /** A user-merge / prose target (settings.json, CLAUDE.md, AGENTS.md): a full
   *  template overwrite always destroys the user's additions, so a user-edited
   *  one is preserved even under --force. */
  userMergeTarget?: boolean;
}

export function decideUpdateDisposition(input: UpdateDispositionInput): UpdateDecision {
  const { exists, evolving, priorEntry, onDiskHash, force, userMergeTarget } = input;
  if (!exists) return 'write';
  if (evolving) return 'skip';
  if (!priorEntry) return 'skip';
  if (priorEntry.provenance === 'skipped') return 'skip';
  // dxkit-owned (created / overwritten). Refresh only when the on-disk content
  // still matches what dxkit last wrote — otherwise the user edited a dxkit
  // file.
  if (priorEntry.hash && onDiskHash() === priorEntry.hash) return 'write';
  if (userMergeTarget) return 'skip';
  return force ? 'write' : 'skip';
}
