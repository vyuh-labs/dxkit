/**
 * Flow diagnosis — the "diagnose" surface, folded into `doctor` (there is no
 * standalone `flow doctor`). Where the gate answers "did this PR break an
 * integration?", diagnose answers "what is the current state of the contract?":
 * which client calls do NOT resolve to a served route and why, which served
 * routes nobody consumes, and how the served side is being resolved (the
 * connection-resolution ladder).
 *
 * The output is deliberately agent-legible — `doctor --json` carries the whole
 * `FlowDiagnosis`, so the `dxkit-flow` skill reads it as a thin consumer rather
 * than scraping console prose. Reuses the shared extractor (Rule 2); fail-open
 * (any error → `null`, and doctor simply omits the flow section).
 */

import {
  detectActiveLanguages,
  allFlowSourceExtensions,
  allPrimaryComponentPaths,
} from '../../languages';
import { detect } from '../../detect';
import { gatherRepoFlowModel } from './gather';
import { hasOpaqueLeadingSegment, isPlaceholderOnlyPath, type FlowModel } from './model';
import { readServedContract } from './contract';
import { contractFreshness, type ContractFreshness } from './staleness';
import { readWorkspace } from '../../workspace';
import type { FlowTopology } from './setup';

/** Why a client call did not cleanly bind to a served route. */
export type UnresolvedReason = 'no-route' | 'external' | 'placeholder-only';

/** The recommended next step for an unresolved call. `scaffold-resolver`
 *  (extend extraction to an unsupported framework) is intentionally NOT emitted
 *  here — an un-extracted call is absent, not unresolved; that path needs the
 *  extension SDK. */
export type FlowFixHint = 'add-route' | 'configure-participant' | 'adopt-spec' | 'annotate';

/** One client call that does not resolve, plus the reason and the suggested fix. */
export interface UnresolvedCall {
  readonly method: string;
  readonly rawUrl: string;
  readonly path: string | null;
  readonly file: string;
  readonly line: number;
  readonly reason: UnresolvedReason;
  readonly suggestion: FlowFixHint;
}

/** A served route no client call binds to — a dead route, or a route consumed
 *  only by a repo dxkit cannot see (a cross-repo consumer). */
export interface UnconsumedRoute {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  /** The route's handler symbol (best-effort, may be null / a bare HTTP verb).
   *  Carried so the dead-surface tier can check the direct-call seam — is this
   *  handler invoked directly (RSC / server action) rather than over HTTP? —
   *  without re-gathering the flow model. */
  readonly handler: string | null;
}

/** Which rung of the connection-resolution ladder produced the served set. */
export type ConnectionRung =
  | 'monorepo'
  | 'committed-counterpart'
  | 'configured-participants'
  | 'unresolved';

export interface FlowDiagnosis {
  readonly topology: FlowTopology;
  readonly calls: number;
  readonly routes: number;
  readonly resolved: number;
  /** Client calls that do not cleanly bind, each with a reason + suggestion. */
  readonly unresolved: readonly UnresolvedCall[];
  /** Served routes with no consuming call (dead-route / cross-repo candidates). */
  readonly servedUnconsumed: readonly UnconsumedRoute[];
  readonly connection: { readonly rung: ConnectionRung; readonly note: string };
  /** How many resolved client calls originate from a FRONTEND component/page
   *  file (a `primaryComponentPath`). A positive count means this repo hosts a
   *  co-located UI that consumes its own routes — a full-stack monorepo whose
   *  route consumers are all in-repo and therefore VISIBLE, distinguishing it
   *  from a backend that merely makes internal service-to-service HTTP calls
   *  (which has zero frontend consumers). The dead-surface tier uses this to know
   *  whether an unconsumed route's deadness can be trusted without a workspace
   *  declaration. Pack-driven (component paths are `architecturalShape` data). */
  readonly frontendConsumers: number;
  /** Freshness of the committed served contract, when one exists: when it was
   *  published, per-participant provenance, and whether a provider's tip has
   *  moved since (doctor may probe the network for this; the per-commit gate
   *  never does). Absent on repos that commit no contract. */
  readonly contract?: ContractFreshness;
  /** What flow can and cannot see — the coverage-honesty surface. */
  readonly coverage: FlowCoverage;
}

/**
 * Coverage honesty: green is not the same as complete, and this block says
 * exactly how incomplete. `dynamic` counts RECOGNIZED client call sites whose
 * URL is built at runtime — flow saw them and cannot verify them (they are
 * excluded from every resolved/unresolved number). The `paths` distribution
 * shows how anchored the extracted calls are: an `opaque` path (leading
 * `{var}`) is too generic for the gate to ever block on.
 */
export interface FlowCoverage {
  /** Every client call site the extractor recognized: extracted + dynamic. */
  readonly callSitesSeen: number;
  /** Call sites with a statically-extractable URL (what the join runs on). */
  readonly extracted: number;
  /** Recognized call sites with a dynamically-built URL — unverifiable. */
  readonly dynamic: number;
  /** Where the unverifiable call sites live (render capped; JSON complete). */
  readonly dynamicSites: ReadonlyArray<{ receiver: string; file: string; line: number }>;
  /** Anchoring of extracted call paths: `exact` (no placeholders), `templated`
   *  (placeholders but anchored), `opaque` (leading placeholder — warn-only). */
  readonly paths: { exact: number; templated: number; opaque: number };
  /** The standing blind-spot disclosure (dynamic URLs, GraphQL out of scope). */
  readonly note: string;
}

/** Build the coverage block from a gathered model (pure). */
export function flowCoverage(model: FlowModel): FlowCoverage {
  let exact = 0;
  let templated = 0;
  let opaque = 0;
  for (const c of model.calls) {
    if (c.path === null) continue; // external/unnormalizable — already in the unresolved tail
    if (hasOpaqueLeadingSegment(c.path)) opaque++;
    else if (c.path.includes('{var}')) templated++;
    else exact++;
  }
  const dynamic = model.dynamicCalls.length;
  return {
    callSitesSeen: model.calls.length + dynamic,
    extracted: model.calls.length,
    dynamic,
    dynamicSites: model.dynamicCalls,
    paths: { exact, templated, opaque },
    note:
      'Flow verifies statically-extractable REST-style calls. ' +
      (dynamic > 0
        ? `${dynamic} recognized call site(s) build their URL at runtime and cannot be verified. `
        : '') +
      'GraphQL operations are out of scope.',
  };
}

function suggestionFor(reason: UnresolvedReason, topology: FlowTopology): FlowFixHint {
  switch (reason) {
    case 'external':
      return 'adopt-spec'; // add the external API's OpenAPI spec to verify it
    case 'placeholder-only':
      return 'annotate'; // too generic to verify — annotate if intentional
    case 'no-route':
      // A monorepo serves its own routes, so a miss is a missing/typo'd route;
      // a consumer-only repo's provider lives elsewhere (configure it).
      return topology === 'monorepo' ? 'add-route' : 'configure-participant';
  }
}

/** Classify a binding into the unresolved tail, or `null` when it resolves. */
function classifyUnresolved(
  b: FlowModel['bindings'][number],
  topology: FlowTopology,
): UnresolvedCall | null {
  let reason: UnresolvedReason | null = null;
  if (b.reason === 'external') reason = 'external';
  else if (b.reason === 'no-route') reason = 'no-route';
  else if (b.reason === 'placeholder-only') reason = 'placeholder-only';
  if (reason === null) return null; // 'exact' → resolved
  return {
    method: b.call.method,
    rawUrl: b.call.rawUrl,
    path: b.call.path,
    file: b.call.file,
    line: b.call.line,
    reason,
    suggestion: suggestionFor(reason, topology),
  };
}

function resolveConnection(cwd: string, model: FlowModel): { rung: ConnectionRung; note: string } {
  if (model.routes.length > 0) {
    return { rung: 'monorepo', note: 'This repo serves the routes its calls target.' };
  }
  if (readServedContract(cwd)) {
    return {
      rung: 'committed-counterpart',
      note: 'Resolving calls against the counterpart contract this repo commits.',
    };
  }
  const ws = readWorkspace(cwd);
  if (ws && ws.participants.length > 0) {
    return {
      rung: 'configured-participants',
      note: `Configured participants: ${ws.participants.map((p) => p.name).join(', ')}.`,
    };
  }
  return {
    rung: 'unresolved',
    note: 'No served side in this repo and no counterpart contract — the gate stays inert. Publish the provider contract or add a participant.',
  };
}

/**
 * Diagnose the repo's flow contract. Returns `null` (and doctor omits the flow
 * section) when no flow-capable pack is active, when extraction finds nothing,
 * or on any error.
 */
export async function diagnoseFlow(cwd: string): Promise<FlowDiagnosis | null> {
  if (allFlowSourceExtensions(detectActiveLanguages(cwd)).length === 0) return null;

  let model: FlowModel;
  try {
    model = await gatherRepoFlowModel(cwd);
  } catch {
    return null;
  }

  const calls = model.calls.length;
  const routes = model.routes.length;
  if (calls === 0 && routes === 0) return null;

  const topology: FlowTopology =
    calls > 0 && routes > 0 ? 'monorepo' : calls > 0 ? 'consumer-only' : 'provider-only';

  const unresolved = model.bindings
    .map((b) => classifyUnresolved(b, topology))
    .filter((u): u is UnresolvedCall => u !== null);
  const resolved = calls - unresolved.length;

  // Served routes with no consuming binding. Consumed keys come from resolved
  // bindings; the union with a committed counterpart's served set does NOT
  // matter here — we only flag OUR served routes that nobody in scope calls.
  const consumedKeys = new Set(
    model.bindings
      .filter((b) => b.route !== null)
      .map((b) => `${b.route!.method} ${b.route!.path}`),
  );
  const servedUnconsumed: UnconsumedRoute[] = model.routes
    .filter((r) => !consumedKeys.has(`${r.method} ${r.path}`) && !isPlaceholderOnlyPath(r.path))
    .map((r) => ({
      method: r.method,
      path: r.path,
      file: r.file,
      line: r.line,
      handler: r.handler,
    }));

  // Frontend-consumer count: resolved calls whose SITE is a frontend component
  // /page file (a pack-declared `primaryComponentPath`). A positive count means a
  // co-located UI consumes this repo's routes — a full-stack monorepo whose
  // consumers are visible, vs a backend making internal service calls (zero).
  const componentPaths = allPrimaryComponentPaths(detect(cwd).languages);
  const frontendConsumers =
    componentPaths.length === 0
      ? 0
      : model.bindings.filter(
          (b) =>
            b.route !== null &&
            componentPaths.some((p) => b.call.file.toLowerCase().includes(p.toLowerCase())),
        ).length;

  // Freshness disclosure for a committed contract — stale-but-declared beats
  // stale-and-silent. May probe participant tips (local rev-parse / bounded
  // ls-remote), fail-open; doctor is the network-allowed surface.
  const contract = contractFreshness(cwd);

  return {
    topology,
    calls,
    routes,
    resolved,
    unresolved,
    servedUnconsumed,
    connection: resolveConnection(cwd, model),
    frontendConsumers,
    ...(contract ? { contract } : {}),
    coverage: flowCoverage(model),
  };
}
