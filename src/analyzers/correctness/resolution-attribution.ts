/**
 * Pre-push attribution for import-resolution failures (4.3.3) — a sound
 * base-side answer WITHOUT a base worktree run, so the one hook surface that
 * cannot afford a two-sided floor still obeys the floor's law: only a
 * net-new failure blocks.
 *
 * The class this closes, observed live on a real repository: a chore branch
 * bumping one unrelated lockfile entry escalated the pre-push floor to full
 * scope, and the repo's PRE-EXISTING phantom imports (specifiers imported by
 * untouched files, declared in no manifest at the base either) hard-blocked
 * the push — debt the change cannot have caused, blamed on the change.
 */

import { execFileSync } from 'child_process';

import { dependencyManifestFilesIn } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import { IMPORT_RESOLUTION_LABEL, type CorrectnessFloorResult } from './run';
import { attributeFloorFailures, type FloorBaseCheck } from './attribution';

/**
 * Sound base-side evidence for unresolved import specifiers, WITHOUT a base
 * worktree run. A specifier could only have resolved at the merge base if
 * some package by that name was installed there — and every install is
 * recorded in a manifest/lockfile. So:
 *
 *   - the specifier appears in NO base manifest/lockfile blob (conservative
 *     textual containment — a false "present" merely keeps the block), AND
 *   - the base tree already carried the import (the QUOTED specifier appears
 *     in base source — quoting excludes prose mentions, and a false "absent"
 *     merely keeps the block)
 *
 *   ⇒ the specifier was ALREADY unresolvable at the base: pre-existing
 *     phantom-dependency debt this change cannot have caused. Refuted.
 *
 * Everything else stays attributable (the un-hoist class the resolution
 * check exists for: a specifier the base lockfile DID provide transitively
 * reads as present and keeps blocking; a newly-added import of an undeclared
 * package is absent from base source and keeps blocking). Every uncertainty
 * lands on "keep blocking" — the refutation only fires when the base
 * evidence is decisive. Returns null when the base side is unreadable (no
 * refutation, behavior unchanged). Exported for tests.
 */
export function refutedResolutionSpecifiers(
  cwd: string,
  baseSha: string,
  packs: readonly LanguageSupport[],
  specifiers: readonly string[],
): string[] | null {
  if (specifiers.length === 0) return [];
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  try {
    const treeFiles = git(['ls-tree', '-r', '--name-only', baseSha]).split('\n').filter(Boolean);
    const manifestPaths = dependencyManifestFilesIn(treeFiles, packs);
    const manifestBlobs = manifestPaths.map((p) => {
      try {
        return git(['show', `${baseSha}:${p}`]);
      } catch {
        // An unreadable manifest blob makes base evidence non-decisive for
        // every specifier — fail toward keeping the block.
        throw new Error(`unreadable base manifest ${p}`);
      }
    });
    const refuted: string[] = [];
    for (const spec of specifiers) {
      if (manifestBlobs.some((blob) => blob.includes(spec))) continue; // maybe provided at base
      // Quoted-containment probe for the import existing at base. `git grep`
      // exits 1 on no match — treated as "not imported at base" (keep block).
      const importedAtBase = [`'${spec}'`, `"${spec}"`].some((needle) => {
        try {
          git(['grep', '-l', '--fixed-strings', needle, baseSha]);
          return true;
        } catch {
          return false;
        }
      });
      if (importedAtBase) refuted.push(spec);
    }
    return refuted;
  } catch {
    return null;
  }
}

/**
 * Route a blocking pre-push floor result through the ONE attribution
 * comparator (`attributeFloorFailures`), with the resolution check's base
 * side supplied by `refutedResolutionSpecifiers`. Checks with no base
 * evidence keep the surface's point-in-time semantics
 * (`absentMeans: 'net-new'` — a failing syntax or test check still blocks
 * exactly as before). Returns null when there is nothing to adjust (no
 * failing resolution check, no decisive base evidence) so the caller keeps
 * the original outcome byte-for-byte.
 */
export function attributePrePushResolution(
  cwd: string,
  baseSha: string,
  packs: readonly LanguageSupport[],
  result: CorrectnessFloorResult,
): { blocks: boolean; note: string } | null {
  const failingResolution = result.checks.filter(
    (c) => c.status === 'fail' && c.label === IMPORT_RESOLUTION_LABEL && c.findings?.length,
  );
  if (failingResolution.length === 0) return null;

  const baseRows: FloorBaseCheck[] = [];
  for (const check of failingResolution) {
    const refuted = refutedResolutionSpecifiers(cwd, baseSha, packs, check.findings ?? []);
    if (refuted === null || refuted.length === 0) continue;
    baseRows.push({ pack: check.pack, label: check.label, status: 'fail', findings: refuted });
  }
  if (baseRows.length === 0) return null;

  const attributed = attributeFloorFailures(result, baseRows, { absentMeans: 'net-new' });
  const blocks = attributed.some((a) => a.attribution === 'net-new');
  const parts: string[] = [];
  for (const a of attributed) {
    if (a.check.label !== IMPORT_RESOLUTION_LABEL) continue;
    const refutedCount =
      (a.check.findings?.length ?? 0) -
      (a.attribution === 'net-new' ? (a.netNewFindings?.length ?? 0) : 0);
    if (refutedCount > 0) {
      parts.push(
        `${refutedCount} unresolved import(s) are PRE-EXISTING — already unresolvable at the ` +
          `merge base ${baseSha.slice(0, 12)} (absent from its manifests/lockfiles, already ` +
          `imported there) — not blocked; declare or remove them`,
      );
    }
    if (a.attribution === 'net-new' && a.netNewFindings?.length) {
      parts.push(`net-new unresolved import(s) BLOCK: ${a.netNewFindings.join(', ')}`);
    }
  }
  return { blocks, note: parts.length > 0 ? ` [${parts.join('; ')}]` : '' };
}
