/**
 * Import-graph test matching.
 *
 * Replaces the filename-based `matchTestsToSource` heuristic with something
 * that actually reflects what a test exercises. A source file is "tested"
 * when at least one active test file imports it, directly or transitively
 * through a small number of hops.
 *
 * The point is to rescue common real-world shapes the filename matcher
 * misses:
 *
 *   test/cli-init.test.ts  imports  src/cli.ts
 *     src/cli.ts           imports  src/generator.ts, src/detect.ts, ...
 *   → all of those count as tested even though none of their filenames
 *     contain "cli-init".
 *
 * Phase 10e.B.4.6: the BFS now walks a pre-computed, union-of-packs
 * edge map produced by the `IMPORTS` capability via the dispatcher.
 * Each pack's provider walks its own source extensions and resolves
 * in-pack edges; the dispatcher concatenates the per-pack graphs
 * before BFS starts. Go dead-ends naturally at package directories
 * (edge target is a dir, and no pack has an edge out of a dir), which
 * preserves the pre-refactor semantics.
 */

import { defaultDispatcher } from '../dispatcher';
import { IMPORTS } from '../../languages/capabilities/descriptors';
import { LANGUAGES } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { ImportsResult } from '../../languages/capabilities/types';

export interface ImportGraphOptions {
  /** Transitive depth. 0 = direct imports only. Default 3. */
  maxHops?: number;
}

/**
 * Build the set of source files reachable from the given test-file seeds by
 * following import edges up to maxHops. Paths are project-relative.
 */
export async function buildReachable(
  seeds: string[],
  cwd: string,
  options: ImportGraphOptions = {},
): Promise<Set<string>> {
  // D010 fix: filter to packs active for this cwd. Imports gather is
  // expensive (find subprocess + per-file regex extraction); inactive
  // packs would walk the tree only to emit zero results.
  const providers: CapabilityProvider<ImportsResult>[] = [];
  for (const lang of LANGUAGES) {
    if (!lang.detect(cwd)) continue;
    const p = lang.capabilities?.imports;
    if (p) providers.push(p);
  }
  const result = await defaultDispatcher.gather(cwd, IMPORTS, providers);
  const edges = result?.edges ?? new Map<string, ReadonlySet<string>>();

  const maxHops = options.maxHops ?? 3;
  const reached = new Set<string>();
  let frontier = seeds.slice();
  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      const targets = edges.get(file);
      if (!targets) continue;
      for (const resolved of targets) {
        if (reached.has(resolved)) continue;
        reached.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }
  return reached;
}
