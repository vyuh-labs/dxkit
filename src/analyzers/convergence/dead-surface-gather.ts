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
import { sawParticipantConsumers, type ParticipantConsumers } from '../flow/model';
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
  /** Whether every consumer was actually READ (cross-repo ruled out). When false,
   *  the whole set is capped at `likely` and the renderer explains WHY via
   *  `consumerVisibilityNudge` — which needs `participantConsumers` to say
   *  something true, since "declare workspace.json" is wrong advice for a repo
   *  that already has one. */
  readonly crossRepoConsumersVisible: boolean;
  /** Per-participant consumed-side provenance from the gathered model, carried so
   *  a renderer can name the ACTUAL blocker rather than assume the workspace is
   *  undeclared. Absent when the repo declares no participants. */
  readonly participantConsumers?: readonly ParticipantConsumers[];
  /** Counts by tier, for a one-line summary. */
  readonly byTier: Readonly<Record<DeadSurfaceTier, number>>;
}

/**
 * The ONE explanation of why deadness could not be confirmed — `null` when it
 * could (consumers were read, so the tiers stand on their own).
 *
 * Both the flow map and `evaluate` render this; it lives here so they cannot
 * drift (Rule 2.30 — the same nudge string was previously duplicated in two
 * renderers). More importantly, it must be TRUE: `crossRepoConsumersVisible`
 * is false for three different reasons, and the old single string
 * ("declare workspace.json") is correct for only one of them. Telling a user
 * who ALREADY declared a workspace to declare a workspace sends them to fix a
 * thing that is not broken — the same confidently-wrong failure this module's
 * false-`removable` bug was.
 */
export function consumerVisibilityNudge(
  res: Pick<DeadSurfaceResult, 'crossRepoConsumersVisible' | 'participantConsumers'>,
): string | null {
  if (res.crossRepoConsumersVisible) return null;
  const participants = res.participantConsumers ?? [];
  if (participants.length === 0) {
    // Nothing declared — the original nudge, now only where it is accurate.
    return 'cross-repo consumers unverified — declare workspace.json to confirm deadness';
  }
  const absent = participants.filter((p) => p.source === 'not-checked-out');
  const readButUnbound = participants.filter((p) => p.source === 'local' && p.bound === 0);
  if (absent.length > 0) {
    const names = absent.map((p) => p.name).join(', ');
    return (
      `cross-repo consumers unverified — participant(s) ${names} are declared but not checked out ` +
      'locally; dxkit reads a participant from its `path`'
    );
  }
  if (readButUnbound.length > 0) {
    const worst = readButUnbound[0];
    return (
      `cross-repo consumers unverified — read ${worst.calls} call(s) from ${worst.name} but bound 0 ` +
      "to this repo's routes; check that participant's flow.stripUrlPrefixes"
    );
  }
  // Declared, read, and bound — yet still not visible. Reachable only if a future
  // arm of `consumersVisible` fails; say so rather than invent a cause.
  return 'cross-repo consumers unverified';
}

/**
 * What dxkit actually READ that could call this repo's routes — the ONE
 * definition of consumer evidence, and the sole input to `consumersVisible`.
 *
 * This shape exists because centralizing the LOCATION of the check was not
 * enough. `consumersVisible` was already the single source of truth — one
 * function, every consumer routed through it, no duplication, Rule 2.30
 * satisfied — and it was still wrong TWICE, because it was a DISJUNCTION OF
 * PROXIES: three independent guesses at one concept, OR'd together, so the
 * loosest arm always won. Two were invalid:
 *
 *   - `workspace.json` participants declared → read as "consumers visible".
 *     Declaring is not reading. It presented 593 live, actively-called endpoints
 *     as `removable` on a real split-repo pair.
 *   - this repo's own `served.json` exists → read as "consumers visible".
 *     Publishing what I SERVE says nothing about who CONSUMES me; it is my own
 *     output. Reachable only on repos that serve routes — exactly where the
 *     question matters — so it was never right. And the documented cross-repo
 *     setup tells a backend to commit `served.json` so a frontend can gate
 *     against it, meaning following our own instructions re-armed the bug.
 *     Verified on the same pair: `flow refresh` alone resurrected all 593.
 *
 * Nobody had written down what the predicate MEANS, so heuristics accreted
 * beside it and read as peers — which is why fixing one left the other in place.
 * The fix is to make the concept a QUANTITY OF THINGS READ rather than a flag:
 * every field below counts consumer code dxkit actually parsed. An invalid proxy
 * then has nowhere to live — there is no field for "an artifact exists", because
 * a file's existence is not a consumer. Adding an evidence source means adding a
 * count and saying what it counts, a question that makes an unsound proxy
 * obvious at the moment someone tries to add it.
 */
interface ConsumerEvidence {
  /** Resolved calls originating from a FRONTEND component/page in THIS repo — a
   *  co-located UI consuming its own routes. Real: dxkit parsed those files. A
   *  backend making only internal service-to-service calls scores 0 and does not
   *  qualify; dxkit cannot tell those apart from topology alone, so the ladder
   *  biases to false-negative on deadness (measured on a real split-repo backend:
   *  1214 dead controllers, 0 false removable). */
  readonly inRepoFrontendCalls: number;
  /** Declared workspace participants whose consumed side was GATHERED, with what
   *  each contributed. Real: dxkit walked those trees. `bound` (not `calls`) is
   *  what counts — see `sawParticipantConsumers`. */
  readonly participants: readonly ParticipantConsumers[];
}

/**
 * Whether every consumer was actually READ — the precondition for the loud
 * `removable` tier, computed from evidence and nothing else.
 *
 * A route is confidently dead only if dxkit has SEEN the code that would have
 * called it. There is no third arm: a declaration is not a read, and an artifact
 * this repo published is not a consumer.
 */
function consumersVisible(ev: ConsumerEvidence): boolean {
  return (
    ev.inRepoFrontendCalls > 0 || sawParticipantConsumers({ participantConsumers: ev.participants })
  );
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

  // Assemble the evidence ONCE, from what the diagnosis actually read, then ask.
  const crossRepoConsumersVisible = consumersVisible({
    inRepoFrontendCalls: diag.frontendConsumers,
    participants: diag.participantConsumers ?? [],
  });
  const surfaces = tierDeadSurfaces(relRoutes, {
    crossRepoConsumersVisible,
    calledSymbols,
    conventionPatterns,
    duplicateFiles,
  });

  const byTier = { removable: 0, likely: 0, expected: 0 } as Record<DeadSurfaceTier, number>;
  for (const s of surfaces) byTier[s.tier]++;
  return {
    surfaces,
    crossRepoConsumersVisible,
    ...(diag.participantConsumers ? { participantConsumers: diag.participantConsumers } : {}),
    byTier,
  };
}
