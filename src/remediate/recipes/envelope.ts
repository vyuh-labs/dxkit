/**
 * Envelope containment: the pure half of both enforcement sweeps (the
 * recipe phase and the agent orders phase). An envelope's `paths` speak the
 * planner's language: the explicit `REPO_WIDE_ENVELOPE` marker means the
 * whole repo, a trailing-`/` entry is a directory prefix, anything else is
 * one file. An empty string matches NOTHING (the accidental match-all it
 * used to be is exactly what the explicit marker replaced).
 */
import { REPO_WIDE_ENVELOPE, type WorkOrderEnvelope } from '../work-orders/types';

/** Is a repo-relative path inside the envelope? */
export function pathInEnvelope(p: string, envelope: WorkOrderEnvelope): boolean {
  return envelope.paths.some((e) => {
    if (e === REPO_WIDE_ENVELOPE) return true;
    if (e === '') return false;
    if (e.endsWith('/')) return p.startsWith(e);
    return p === e || p.startsWith(`${e}/`);
  });
}

/**
 * The full allow decision for one changed path under an order's envelope:
 * containment, PLUS the `manifests: false` gate — an envelope that declares
 * no manifest changes excludes dependency manifests/lockfiles even inside
 * its paths (and under the repo-wide marker). `isManifestPath` is the
 * pack-declared manifest-pattern union, injected by the caller (Rule 6:
 * language facts come from the packs).
 */
export function pathAllowedByEnvelope(
  p: string,
  envelope: WorkOrderEnvelope,
  isManifestPath: (path: string) => boolean,
): boolean {
  if (!envelope.manifests && isManifestPath(p)) return false;
  return pathInEnvelope(p, envelope);
}

/** Split changed paths into the envelope's and the strays to drop. */
export function partitionByEnvelope(
  changed: readonly string[],
  envelope: WorkOrderEnvelope,
): { inside: string[]; outside: string[] } {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const p of changed) (pathInEnvelope(p, envelope) ? inside : outside).push(p);
  return { inside, outside };
}
