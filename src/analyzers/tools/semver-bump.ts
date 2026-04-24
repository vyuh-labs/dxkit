/**
 * Shared semver-bump classification used across language packs and the
 * cross-pack resolver. Originally duplicated in
 * `languages/{python,rust}.ts` + `analyzers/tools/osv-scanner-fix.ts`
 * (Phases 10h.6.1–10h.6.3); consolidated here in 10h.6.4 so every pack
 * and the transitive resolver agree on what "breaking" means.
 *
 * Convention:
 *   - Different major segment → breaking.
 *   - Pre-1.x (0.x) minor bump (0.5.0 → 0.6.0) → breaking. Semver says
 *     anything under 1.0 is development-unstable; npm-audit's own
 *     `isSemVerMajor` heuristic treats 0.x lines this way too.
 *   - Unparseable input → false (non-breaking). Conservative so we
 *     don't over-flag when we can't decide.
 */

export function isMajorBump(from: string, to: string): boolean {
  const fromParts = from.split('.').map((p) => parseInt(p, 10));
  const toParts = to.split('.').map((p) => parseInt(p, 10));
  if (fromParts.some(isNaN) || toParts.some(isNaN)) return false;
  if ((fromParts[0] ?? 0) !== (toParts[0] ?? 0)) return true;
  if ((fromParts[0] ?? 0) === 0 && (fromParts[1] ?? 0) !== (toParts[1] ?? 0)) return true;
  return false;
}
