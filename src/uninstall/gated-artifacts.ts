/**
 * Which gated ship-installer artifacts uninstall removes, and which it keeps.
 *
 * The list is derived from the managed-artifact registry (the same source
 * update and init read), so a surface cannot be removed here yet forgotten by
 * update. A file at a managed path that is the USER's own (install left it
 * alone) is kept: one ownership answer (`ManagedShipSurface.userOwned`) for
 * install and uninstall alike.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MANAGED_SHIP_SURFACES, managedGatedArtifacts } from '../managed-artifacts';
import type { InstallFlags } from '../update';

export interface GatedArtifactPlan {
  /** Present, dxkit's own: delete. */
  readonly remove: readonly string[];
  /** Present at a managed path but the user's own: keep, with a warning. */
  readonly kept: readonly string[];
}

export function planGatedArtifacts(cwd: string, flags: InstallFlags): GatedArtifactPlan {
  const userOwned = new Set(
    MANAGED_SHIP_SURFACES.filter((s) => s.userOwned?.(cwd)).flatMap((s) => s.artifacts(flags)),
  );
  const remove: string[] = [];
  const kept: string[] = [];
  for (const rel of managedGatedArtifacts(flags)) {
    if (!fs.existsSync(path.join(cwd, rel))) continue;
    (userOwned.has(rel) ? kept : remove).push(rel);
  }
  return { remove, kept };
}
