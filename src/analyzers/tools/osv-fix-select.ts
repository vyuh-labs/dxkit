/**
 * Fix-version SELECTION for an OSV record: the pure half of fix resolution
 * (which `fixed` event answers for an installed version, and the one key a
 * resolution is answered under). Split from `osv.ts` for module size only;
 * the network resolution (`resolveFixVersions`) stays there with the shared
 * session cache and re-exports these, so every consumer keeps one import.
 */
import type { OsvVuln } from './osv';

/**
 * Extract the patch-available version from an OSV record (D042). Walks
 * `affected[].ranges[].events[]` in document order and returns the
 * first non-empty `fixed` event. Multiple `fixed` events can exist
 * when the advisory covers multiple version branches (e.g., a
 * vulnerability backported across 1.x and 2.x lines); the first one
 * is conventionally the lowest patch version — which is the right
 * "minimum upgrade to clear this advisory" answer for most customers.
 *
 * Returns `undefined` when no `fixed` event exists (advisory exists
 * but no patch has been released yet — customer should consider
 * mitigations rather than waiting). Returns `undefined` for the
 * pathological case of empty `affected` / `ranges` / `events` arrays.
 */
export function extractOsvFixVersion(vuln: OsvVuln): string | undefined {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed && event.fixed.length > 0) return event.fixed;
      }
    }
  }
  return undefined;
}

/** ALL `fixed` events across the record's ranges — one per affected range
 *  (a 1.x backport and the 2.x mainline fix are separate events). Input to
 *  `selectFixVersion`, which picks the right one for an installed version. */
export function extractOsvFixedEvents(vuln: OsvVuln): string[] {
  const events: string[] = [];
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed && event.fixed.length > 0 && !events.includes(event.fixed)) {
          events.push(event.fixed);
        }
      }
    }
  }
  return events;
}

/** Numeric-field semver compare; non-numeric fields compare as 0. Total. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick the fix version appropriate for an INSTALLED version from a record's
 * fixed events: the SMALLEST fixed version that is still above the installed
 * one — the minimal safe move, and the right branch when a record carries
 * both a backport fix and a mainline fix (installed 1.4.0 with fixes
 * [1.4.7, 2.0.5] must propose 1.4.7, not a surprise major). Unknown
 * installed version ⟹ the smallest fixed event (the conservative default).
 * No event above the installed version ⟹ undefined — never propose a
 * downgrade.
 */
export function selectFixVersion(
  fixedEvents: readonly string[],
  installedVersion: string | undefined,
): string | undefined {
  if (fixedEvents.length === 0) return undefined;
  const sorted = [...fixedEvents].sort(compareVersions);
  if (!installedVersion) return sorted[0];
  for (const v of sorted) {
    if (compareVersions(v, installedVersion) > 0) return v;
  }
  return undefined;
}

/** One installation of one advisory: the unit fix resolution answers for.
 *  An advisory alone is NOT the unit: the same advisory can be installed
 *  twice (two packages it covers, two nested roots at different versions),
 *  and each installation has its own minimal safe move. */
export interface FixResolutionInput {
  readonly primaryId: string;
  readonly aliases: readonly string[];
  /** The affected package, when the finding names it. */
  readonly package?: string;
  readonly installedVersion?: string;
}

/**
 * The ONE key `resolveFixVersions` answers under: (advisory, package,
 * installed version). Keying by advisory id alone collapsed two
 * installations of one advisory onto whichever resolved last, so a finding
 * at 1.x could be handed the 2.x fix of its sibling.
 */
export function fixResolutionKey(input: FixResolutionInput): string {
  return `${input.primaryId}\u0000${input.package ?? ''}\u0000${input.installedVersion ?? ''}`;
}
