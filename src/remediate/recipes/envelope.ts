/**
 * Envelope containment for recipe diffs: the pure half of the phase
 * runner's enforcement. An envelope's `paths` speak the planner's language:
 * `''` means the whole repo, a trailing-`/` entry is a directory prefix,
 * anything else is one file.
 */
import type { WorkOrderEnvelope } from '../work-orders/types';

/** Is a repo-relative path inside the envelope? */
export function pathInEnvelope(p: string, envelope: WorkOrderEnvelope): boolean {
  return envelope.paths.some((e) => {
    if (e === '') return true;
    if (e.endsWith('/')) return p.startsWith(e);
    return p === e || p.startsWith(`${e}/`);
  });
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
