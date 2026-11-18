/**
 * Uninstall's handling of a managed file that carries an owner section
 * (`AGENTS.md`). The owner section is the owner's, never dxkit's to delete:
 *   - markers that do not form one section → the owner's text has no known
 *     boundary, so the whole file is kept, even under --force;
 *   - owner text + no edit outside it (or --force) → dxkit's sections and the
 *     markers are removed and the owner's text is kept as the file;
 *   - owner text + an edit outside it → the whole file is kept (skip-modified)
 *     unless --force, exactly like any other edited dxkit file;
 *   - an empty section → null: the caller's ordinary hash-guarded delete.
 * Split, normal form and hash all come from `src/owner-section.ts`.
 */
import * as fs from 'fs';
import type { ManifestFileEntry } from '../types';
import type { UninstallAction, UninstallOptions } from './index';
import {
  hasAmbiguousOwnerSection,
  managedContentHash,
  OWNER_SECTION_FILES,
  ownerContentOnly,
} from '../owner-section';

export interface OwnerSectionPlan {
  readonly action: UninstallAction;
  readonly warning: string;
}

/** The plan for one manifest entry, or null when the ordinary delete applies. */
export function planOwnerSectionFile(
  rel: string,
  current: string,
  entry: ManifestFileEntry,
  opts: UninstallOptions,
): OwnerSectionPlan | null {
  if (!OWNER_SECTION_FILES.has(rel)) return null;
  const skipped = (warning: string): OwnerSectionPlan => ({
    action: {
      kind: 'delete-file',
      target: rel,
      detail: 'dxkit-created file',
      status: 'skip-modified',
    },
    warning,
  });
  if (hasAmbiguousOwnerSection(current)) {
    return skipped(
      `${rel} kept: its dxkit:owner markers do not form one section, so the owner's text cannot be separated from dxkit's`,
    );
  }
  if (ownerContentOnly(current) === null) return null;
  const unmodified =
    entry.evolving || !entry.hash || managedContentHash(rel, current) === entry.hash;
  if (!unmodified && !opts.force) {
    return skipped(`${rel} was edited after dxkit created it — skipped (use --force to remove)`);
  }
  return {
    action: {
      kind: 'keep-owner-section',
      target: rel,
      detail: "remove dxkit's sections, keep the owner section's text as the file",
      status: 'pending',
    },
    warning: `${rel} kept: it now holds only the text of its owner section (dxkit's sections removed)`,
  };
}

/** Execute a `keep-owner-section` action: the file becomes the owner's text. */
export function keepOwnerSectionOnly(abs: string): void {
  const kept = ownerContentOnly(fs.readFileSync(abs, 'utf-8'));
  if (kept === null) fs.rmSync(abs, { force: true });
  else fs.writeFileSync(abs, kept, 'utf-8');
}
