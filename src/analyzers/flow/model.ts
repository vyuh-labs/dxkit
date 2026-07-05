/**
 * Flow model + the join — assemble extracted client calls and route
 * declarations into a `FlowModel`, then bind each call to the route it targets
 * on the normalized `(method, path)` key.
 *
 * The join is where consumed meets served. A binding carries a confidence in
 * [0, 1] + a reason, mirroring the git-aware matcher's contract: an exact key
 * match on a path with real static signal is full confidence; a path that is
 * all placeholder (`/{var}`) carries no signal and is low confidence even when
 * it happens to match a catch-all; a dynamic or unrouted call is unresolved.
 * Confidence is what a gate thresholds on — only high-confidence bindings can
 * block, which is what keeps the false-positive budget intact.
 *
 * Pure over its inputs (the file-extraction step that produces `FileFlow`s does
 * the I/O); this module just structures + joins.
 */

import { extractFileFlow, type ClientCall, type FileFlow, type RouteEndpoint } from './extract';
import { catchAllStaticPrefix, isCatchAllPath, type NormalizeConfig } from './normalize';

/**
 * Why a call did or didn't bind to a route:
 *   - `exact`            — matched a route on a path with real static signal;
 *   - `catch-all`        — matched a wildcard route (`/api/{*}` from `[...slug]`,
 *                          Express `/*`, Spring `/**`) on its static prefix; the
 *                          call IS served, but via a splat rather than a literal
 *                          route, so confidence sits below an exact match;
 *   - `placeholder-only` — matched, but the path is all `{var}` (no signal);
 *   - `no-route`         — path resolved to an internal route shape, but no
 *                          served route matches it;
 *   - `external`         — the URL is an external/absolute address we don't
 *                          serve (path is null), so it is not an internal binding.
 */
export type BindingReason = 'exact' | 'catch-all' | 'placeholder-only' | 'no-route' | 'external';

/** One client call resolved (or not) against the served routes. */
export interface FlowBinding {
  readonly call: ClientCall;
  readonly route: RouteEndpoint | null;
  readonly confidence: number;
  readonly reason: BindingReason;
}

/** The assembled flow: both surfaces plus the bindings between them. */
export interface FlowModel {
  readonly calls: readonly ClientCall[];
  readonly routes: readonly RouteEndpoint[];
  readonly bindings: readonly FlowBinding[];
}

/** A path made up entirely of `{var}` segments carries no static signal. One
 *  source of truth (Rule 2) for both the join's confidence and the gate's
 *  confidence gating (a placeholder-only path is too generic to block on). */
export function isPlaceholderOnlyPath(path: string): boolean {
  return /^(\/\{var\})+$/.test(path);
}

/**
 * Bind each client call to the route it targets, on the normalized
 * `(method, path)` key. Routes are indexed once; each call resolves in O(1).
 */
export function joinFlow(
  calls: readonly ClientCall[],
  routes: readonly RouteEndpoint[],
): FlowBinding[] {
  const routeIndex = new Map<string, RouteEndpoint>();
  // Catch-all routes, grouped by method, each with its static prefix. A concrete
  // call that misses the exact index falls back to the LONGEST-prefix catch-all
  // for its method — a splat route (`/api/{*}` from `[...slug]`, Express `/*`,
  // Spring `/**`) genuinely serves every path under its prefix.
  const catchAllsByMethod = new Map<HttpMethodKey, { route: RouteEndpoint; prefix: string }[]>();
  for (const r of routes) {
    routeIndex.set(`${r.method} ${r.path}`, r);
    if (isCatchAllPath(r.path)) {
      const list = catchAllsByMethod.get(r.method) ?? [];
      list.push({ route: r, prefix: catchAllStaticPrefix(r.path) });
      catchAllsByMethod.set(r.method, list);
    }
  }

  return calls.map((call): FlowBinding => {
    if (call.path == null) return { call, route: null, confidence: 0, reason: 'external' };
    const route = routeIndex.get(`${call.method} ${call.path}`) ?? null;
    if (route) {
      if (isPlaceholderOnlyPath(call.path)) {
        return { call, route, confidence: 0.3, reason: 'placeholder-only' };
      }
      return { call, route, confidence: 1, reason: 'exact' };
    }
    const catchAll = bestCatchAllMatch(call.path, catchAllsByMethod.get(call.method));
    if (catchAll) return { call, route: catchAll, confidence: 0.7, reason: 'catch-all' };
    return { call, route: null, confidence: 0, reason: 'no-route' };
  });
}

/** The most-specific catch-all route whose static prefix covers `callPath`
 *  (`/api` covers `/api/x` and `/api/x/y`), or null. Longest prefix wins so a
 *  nested `/api/v2/{*}` beats `/api/{*}`; a root catch-all (`''` prefix) matches
 *  anything. Not applied to an all-placeholder call (no static signal to align). */
function bestCatchAllMatch(
  callPath: string,
  candidates: { route: RouteEndpoint; prefix: string }[] | undefined,
): RouteEndpoint | null {
  if (!candidates || isPlaceholderOnlyPath(callPath)) return null;
  let best: { route: RouteEndpoint; prefix: string } | null = null;
  for (const c of candidates) {
    const covers = c.prefix === '' || callPath === c.prefix || callPath.startsWith(c.prefix + '/');
    if (covers && (!best || c.prefix.length > best.prefix.length)) best = c;
  }
  return best?.route ?? null;
}

type HttpMethodKey = RouteEndpoint['method'];

/**
 * Dedup served routes to one per distinct `(method, path)` — the canonical
 * "what this repo serves" set. A route surfaced by both a spec and static
 * extraction collapses to one, spec winning (authoritative handler +
 * provenance). One source of truth (Rule 2) for the graph overlay's endpoint
 * nodes AND the served contract snapshot.
 */
export function dedupeServedRoutes(routes: readonly RouteEndpoint[]): RouteEndpoint[] {
  const byKey = new Map<string, RouteEndpoint>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const existing = byKey.get(key);
    if (!existing || (existing.via !== 'spec' && route.via === 'spec')) {
      byKey.set(key, route);
    }
  }
  return [...byKey.values()];
}

/** Flatten per-file surfaces into one model + its bindings. */
export function buildFlowModel(fileFlows: readonly FileFlow[]): FlowModel {
  const calls = fileFlows.flatMap((f) => f.calls);
  const routes = fileFlows.flatMap((f) => f.routes);
  return { calls, routes, bindings: joinFlow(calls, routes) };
}

/**
 * Extract + assemble a flow model from a set of files. `null` extractions
 * (unparseable / engine unavailable) are skipped, never fatal.
 */
export async function extractFlowModel(
  filePaths: readonly string[],
  config?: NormalizeConfig,
): Promise<FlowModel> {
  const flows: FileFlow[] = [];
  for (const path of filePaths) {
    const flow = await extractFileFlow(path, config);
    if (flow) flows.push(flow);
  }
  return buildFlowModel(flows);
}

/** Summary counts for a model (drives the `flow` preview + acceptance checks). */
export interface FlowSummary {
  readonly calls: number;
  readonly routes: number;
  readonly resolved: number;
  readonly highConfidence: number;
  readonly unresolved: number;
}

export function summarize(model: FlowModel): FlowSummary {
  const resolved = model.bindings.filter((b) => b.route !== null).length;
  const highConfidence = model.bindings.filter((b) => b.confidence >= 1).length;
  return {
    calls: model.calls.length,
    routes: model.routes.length,
    resolved,
    highConfidence,
    unresolved: model.calls.length - resolved,
  };
}
