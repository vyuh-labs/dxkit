/**
 * Dead-surface gatherer — composes the flow diagnosis (`servedUnconsumed`), the
 * graph's direct-call seam, the pack-declared conventions, and the convergence
 * join (structural duplicates) into a TIERED list of served-but-unconsumed
 * routes. This is a VISIBILITY signal (warn-tier / inventory), recomputed each
 * run — it never blocks, so it carries no baseline identity (see the design's
 * scoping refinement: no gate machinery for a non-gate signal).
 *
 * Two layers, so the ladder logic is testable without I/O:
 *   - `tierDeadSurfaces` — PURE: unconsumed routes + signals → tiered surfaces.
 *   - `gatherDeadSurfaces` — the thin I/O wrapper: diagnoseFlow + the graph +
 *     the convention union + the optional dup findings → the tiered result.
 *
 * `diagnoseFlow` stays graph-FREE (its invariant); the graph-dependent
 * direct-call seam is applied HERE, above it (Rule 2: servedUnconsumed is still
 * computed in exactly one place — diagnose — and consumed here).
 */

import type { FlowDiagnosis, UnconsumedRoute } from '../flow/diagnose';
import { diagnoseFlow } from '../flow/diagnose';
import { tryLoadGraph } from '../../explore/load';
import type { Graph } from '../../explore/types';
import { calledSymbolNames } from '../../explore/queries';
import { allNonConsumerRoutePaths } from '../../languages';
import { detect } from '../../detect';
import { readWorkspace } from '../../workspace';
import { readServedContract } from '../flow/contract';
import * as path from 'path';
import type { DuplicateFinding } from '../duplication/findings';
import {
  deadSurfaceTier,
  isSpecificHandlerName,
  matchesNonConsumerConvention,
  type DeadSurfaceTier,
} from './dead-surface';

/** A served-but-unconsumed route with its resolved confidence tier + the reason
 *  the tier landed where it did (the honest ladder — never present uncertain as
 *  certain). */
export interface TieredDeadSurface {
  readonly route: UnconsumedRoute;
  readonly tier: DeadSurfaceTier;
  /** Human-legible reason the tier resolved this way — one of the ladder rungs.
   *  Agent- and human-legible; renderers show it verbatim. */
  readonly reason: DeadSurfaceReason;
  /** True when a structural duplicate co-locates here (the convergence input) —
   *  carried so a renderer can name the "removable slop" story. */
  readonly convergesWithDuplicate: boolean;
}

export type DeadSurfaceReason =
  | 'convention' // matched a pack-declared external-actor route shape
  | 'direct-call' // handler is invoked directly (RSC / server action), not over HTTP
  | 'converged-dead' // unconsumed, consumers visible, AND a duplicate → removable
  | 'unconfirmed'; // unconsumed but cross-repo consumers could not be ruled out

export interface DeadSurfaceResult {
  readonly surfaces: readonly TieredDeadSurface[];
  /** Whether every consumer was VISIBLE (cross-repo ruled out) — derived from
   *  topology + connection rung. When false, the whole set is capped at `likely`
   *  and the renderer nudges "configure workspace.json". */
  readonly crossRepoConsumersVisible: boolean;
  /** Counts by tier, for a one-line summary. */
  readonly byTier: Readonly<Record<DeadSurfaceTier, number>>;
}

/**
 * Whether cross-repo consumers could ALL be seen — the precondition for the loud
 * `removable` tier. Only an EXPLICIT mesh qualifies: a `workspace.json` that
 * declares the system's participants, or a committed counterpart contract. When
 * the user has DECLARED the system boundary, a route unconsumed across it is
 * confidently dead.
 *
 * Read DIRECTLY from the workspace / committed contract, NOT from
 * `diagnoseFlow.connection.rung`: the rung reports `monorepo` for ANY repo that
 * serves routes (it resolves the CONSUMER side, and a route-serving repo short-
 * circuits to `monorepo` before the participant check), so it can never report
 * `configured-participants` for a provider — the signal we actually need is
 * "has this provider declared who consumes it," which only the workspace answers.
 *
 * A bare `monorepo` with no declaration does NOT qualify, even though it looks
 * full-stack: a backend with internal service-to-service HTTP calls also reads
 * as `monorepo`, yet its real UI consumers live in a separate repo dxkit never
 * scanned. dxkit cannot tell those two apart from topology alone, so claiming
 * "consumers visible" there would false-flag a cross-repo-consumed route as
 * removable slop — the exact precision break the ladder avoids (measured on a
 * real split-repo backend: 1214 dead controllers, 0 false removable). The
 * `likely` tier's nudge ("declare your system in workspace.json") graduates a
 * repo to the loud signal — an adoption loop, not a false positive.
 */
function consumersVisible(cwd: string, diag: Pick<FlowDiagnosis, 'frontendConsumers'>): boolean {
  // 1. An explicit mesh: the user DECLARED the system boundary.
  const ws = readWorkspace(cwd);
  if (ws && ws.participants.length > 0) return true;
  if (readServedContract(cwd) !== undefined) return true;
  // 2. A co-located full-stack monorepo: a frontend component/page in THIS repo
  //    consumes its own routes, so every consumer is in-repo and visible. A
  //    backend that only makes internal service calls has zero frontend
  //    consumers and does NOT qualify (the platform false-positive stays out).
  return diag.frontendConsumers > 0;
}

/**
 * Pure ladder application. Tiers each unconsumed route from already-computed
 * signals: the convention union, the direct-call symbol set, whether consumers
 * are visible, and the set of files carrying a structural duplicate (the
 * convergence join). No I/O.
 */
export function tierDeadSurfaces(
  servedUnconsumed: readonly UnconsumedRoute[],
  opts: {
    readonly crossRepoConsumersVisible: boolean;
    readonly calledSymbols: ReadonlySet<string>;
    readonly conventionPatterns: readonly string[];
    readonly duplicateFiles: ReadonlySet<string>;
  },
): TieredDeadSurface[] {
  return servedUnconsumed.map((route) => {
    const isConventionRoute = matchesNonConsumerConvention(
      route.file,
      route.path,
      opts.conventionPatterns,
    );
    // Direct-call seam: only trust a SPECIFIC handler name (a bare HTTP verb
    // collides across the codebase — treating it as "called" would falsely mark
    // a route consumed; bias to false-negative on deadness).
    const isDirectlyCalled =
      isSpecificHandlerName(route.handler) &&
      opts.calledSymbols.has(stripHandler(route.handler as string));
    const convergesWithDuplicate = opts.duplicateFiles.has(route.file);
    // Deadness is only CONFIRMABLE for a specific-handler route: a bare HTTP-verb
    // handler (App-Router `GET`/`POST`) can be consumed by a server component
    // without a resolvable call, so its "unconsumed" is ambiguous and it can
    // never reach the loud `removable` tier.
    const deadnessConfirmable = isSpecificHandlerName(route.handler);
    const tier = deadSurfaceTier({
      isConventionRoute,
      isDirectlyCalled,
      crossRepoConsumersVisible: opts.crossRepoConsumersVisible,
      isStructuralDuplicate: convergesWithDuplicate,
      deadnessConfirmable,
    });
    const reason: DeadSurfaceReason = isConventionRoute
      ? 'convention'
      : isDirectlyCalled
        ? 'direct-call'
        : tier === 'removable'
          ? 'converged-dead'
          : 'unconfirmed';
    return { route, tier, reason, convergesWithDuplicate };
  });
}

/** Strip a handler symbol to its bare name, matching `calledSymbolNames`. */
function stripHandler(handler: string): string {
  const h = handler.replace(/\(\)$/, '');
  return h.includes('.') ? (h.split('.').pop() ?? h) : h;
}

/**
 * Gather the tiered dead-surface inventory for a repo. Fail-open: no flow
 * surface, no graph, or any error → an empty result (never throws). The optional
 * `dupFindings` supply the convergence join; omit them for a dead-only view.
 *
 * Zero-write: reads diagnoseFlow + a graph, both read-only. The graph powers the
 * direct-call seam (is a route's handler invoked directly?). The caller may pass
 * a pre-built `graph` (so the inventory reuses the SAME graph it computed the
 * duplicates from — one build, consistent seam); otherwise it falls back to the
 * on-disk `graph.json` via `tryLoadGraph`, and to no direct-call resolution when
 * neither is present.
 */
export async function gatherDeadSurfaces(
  cwd: string,
  opts: { readonly dupFindings?: readonly DuplicateFinding[]; readonly graph?: Graph } = {},
): Promise<DeadSurfaceResult> {
  const empty: DeadSurfaceResult = {
    surfaces: [],
    crossRepoConsumersVisible: false,
    byTier: { removable: 0, likely: 0, expected: 0 },
  };
  let diag: FlowDiagnosis | null;
  try {
    diag = await diagnoseFlow(cwd);
  } catch {
    return empty;
  }
  if (!diag || diag.servedUnconsumed.length === 0) return empty;

  const stack = detect(cwd);
  const conventionPatterns = allNonConsumerRoutePaths(stack.languages);
  // Direct-call seam from the graph when one is present: the caller's pre-built
  // graph (shared with the duplicate pass), else the on-disk graph.json, else an
  // empty set (degrades to "no direct-call resolution", never an error).
  const graph = opts.graph ?? tryLoadGraph(cwd);
  const calledSymbols = graph ? calledSymbolNames(graph) : new Set<string>();
  // The convergence + direct-call joins compare FILE paths, so both sides must
  // be in the same format. Graph-derived dup anchors are repo-relative; flow's
  // route files are absolute — normalize BOTH to repo-relative here, or the
  // join silently never matches (caught on a real multi-project repo where dup
  // anchors read `axum/src/…` and route files read `/home/…`).
  const toRel = (f: string) => (path.isAbsolute(f) ? path.relative(cwd, f) : f);
  const duplicateFiles = new Set<string>();
  for (const d of opts.dupFindings ?? []) {
    for (const a of d.anchors) duplicateFiles.add(toRel(a.file));
  }
  // Re-express each unconsumed route with a repo-relative file so the tier's
  // convergence + convention checks compare like with like (and downstream
  // renderers show a clean relative locator).
  const relRoutes = diag.servedUnconsumed.map((r) => ({ ...r, file: toRel(r.file) }));

  const crossRepoConsumersVisible = consumersVisible(cwd, diag);
  const surfaces = tierDeadSurfaces(relRoutes, {
    crossRepoConsumersVisible,
    calledSymbols,
    conventionPatterns,
    duplicateFiles,
  });

  const byTier = { removable: 0, likely: 0, expected: 0 } as Record<DeadSurfaceTier, number>;
  for (const s of surfaces) byTier[s.tier]++;
  return { surfaces, crossRepoConsumersVisible, byTier };
}
