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

import {
  extractFileFlow,
  type ClientCall,
  type DynamicCallSite,
  type FileFlow,
  type RouteEndpoint,
} from './extract';
import {
  ANY_METHOD,
  catchAllStaticPrefix,
  isCatchAllPath,
  type NormalizeConfig,
} from './normalize';

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
export type BindingReason =
  | 'exact'
  | 'var-match'
  | 'catch-all'
  | 'placeholder-only'
  | 'no-route'
  | 'external';

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
  /** Recognized client call sites whose URL is dynamic — seen but not
   *  verifiable (the coverage-honesty channel; see extract.ts). */
  readonly dynamicCalls: readonly DynamicCallSite[];
  /** Disclosures from declared contract artifacts (`flow.sources`): unknown
   *  kinds, unreadable/unparseable files, dropped external URLs. Absent when
   *  no sources are declared or every declaration loaded cleanly — the
   *  fail-open channel, surfaced by the map and doctor, never fatal. */
  readonly sourceDisclosures?: readonly string[];
}

/** A path made up entirely of `{var}` segments carries no static signal. One
 *  source of truth (Rule 2) for both the join's confidence and the gate's
 *  confidence gating (a placeholder-only path is too generic to block on). */
export function isPlaceholderOnlyPath(path: string): boolean {
  return /^(\/\{var\})+$/.test(path);
}

/** A path whose FIRST segment is a placeholder carries no anchoring signal —
 *  `/{var}/users/login` could resolve under any top-level namespace, so a "no
 *  route serves it" verdict is too uncertain to block a build. Superset of
 *  `isPlaceholderOnlyPath` (all-dynamic is a special case of leading-dynamic). */
export function hasOpaqueLeadingSegment(path: string): boolean {
  return /^\/\{var\}(\/|$)/.test(path);
}

/**
 * The path-intrinsic confidence a CONSUMED binding carries — how much static
 * signal the path gives the gate to threshold a block on. A path with a literal
 * leading anchor is 1 (block-worthy when genuinely broken); a path with no
 * anchoring signal (all-placeholder, or a leading placeholder that could resolve
 * under any namespace) is 0.3, so a net-new break on it WARNS rather than
 * blocks. One source of truth (Rule 2) for the consumed contract's confidence.
 */
export function consumedPathConfidence(path: string): number {
  return hasOpaqueLeadingSegment(path) ? 0.3 : 1;
}

/**
 * Does a catch-all route's static prefix COVER a concrete call path? `/api`
 * covers `/api`, `/api/x`, `/api/x/y`; a root catch-all (`''`) covers anything.
 * The one prefix-covering predicate (Rule 2) shared by the join's
 * `bestCatchAllMatch` and the gate's `servedMatch`, so a call the join resolves
 * against a splat route is one the gate ALSO sees as served (the class-fix: the
 * gate did exact-key membership only, hard-blocking any call served by a
 * `[...slug]` / `/**` catch-all that doctor resolved cleanly).
 */
export function catchAllPrefixCovers(prefix: string, callPath: string): boolean {
  return prefix === '' || callPath === prefix || callPath.startsWith(prefix + '/');
}

/**
 * A served-side lookup the gate resolves a consumed binding against — exact
 * `(method, path)` keys plus the per-method catch-all static prefixes parsed out
 * of them. Built from the SAME served key set `servedKeySet` produces, so the
 * gate inherits the join's catch-all awareness without re-deriving routes.
 */
/**
 * Does a `{var}`-bearing route path cover a CONCRETE call path, segment-wise?
 * `/articles/{var}` covers `/articles/1` (a route param matches any one
 * segment); literals must match exactly, and a call's own `{var}` segment
 * only matches a route `{var}` (an unknown segment never satisfies a literal
 * claim). This is what lets artifact-declared calls — pact interactions, HAR
 * captures, .http examples, which always carry concrete example paths — bind
 * against parameterized routes; source-extracted calls rarely need it (their
 * dynamic segments already normalize to `{var}`, aligning on the exact key).
 * One predicate, shared by the join AND the gate matcher (Rule 2 parity).
 */
export function varRouteCovers(routePath: string, callPath: string): boolean {
  if (!routePath.includes('{var}')) return false;
  const rs = routePath.split('/');
  const cs = callPath.split('/');
  if (rs.length !== cs.length) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i] === '{var}') {
      if (cs[i].length === 0) return false;
      continue;
    }
    if (rs[i] !== cs[i]) return false;
  }
  return true;
}

export interface ServedMatcher {
  readonly exact: ReadonlySet<string>;
  readonly catchAllPrefixesByMethod: ReadonlyMap<string, readonly string[]>;
  /** Non-catch-all served paths containing `{var}`, by method — the
   *  segment-match candidates for concrete (artifact-borne) call paths. */
  readonly varPathsByMethod: ReadonlyMap<string, readonly string[]>;
}

/**
 * Build a {@link ServedMatcher} from served `${method} ${path}` keys. Catch-all
 * routes (`GET /api/{*}`) are recorded as their static prefix under the method,
 * so the gate can prefix-match a concrete call the way the join does.
 */
export function buildServedMatcher(servedKeys: Iterable<string>): ServedMatcher {
  const exact = new Set<string>();
  const catchAll = new Map<string, string[]>();
  const varPaths = new Map<string, string[]>();
  for (const key of servedKeys) {
    exact.add(key);
    const sp = key.indexOf(' ');
    if (sp <= 0) continue;
    const method = key.slice(0, sp);
    const routePath = key.slice(sp + 1);
    if (isCatchAllPath(routePath)) {
      const list = catchAll.get(method) ?? [];
      list.push(catchAllStaticPrefix(routePath));
      catchAll.set(method, list);
    } else if (routePath.includes('{var}')) {
      const list = varPaths.get(method) ?? [];
      list.push(routePath);
      varPaths.set(method, list);
    }
  }
  return { exact, catchAllPrefixesByMethod: catchAll, varPathsByMethod: varPaths };
}

/**
 * Does a consumed `(method, path)` resolve against the served set — exactly, OR
 * via a catch-all whose static prefix covers it? The single consumed→served
 * resolution predicate (Rule 2): the gate answers "is this served?" through the
 * same catch-all-aware logic the join uses, so gate and doctor agree on the same
 * commit. An all-placeholder path never prefix-matches a catch-all (no static
 * signal to align). A method-agnostic served route (`ANY /path` — Django
 * `path()`, Go `http.HandleFunc`) resolves a call with ANY verb on that path,
 * exactly as the join does: the routing layer genuinely accepts every method
 * there, dispatching (or 405ing) inside the handler.
 */
export function servedMatch(method: string, callPath: string, m: ServedMatcher): boolean {
  if (m.exact.has(`${method} ${callPath}`)) return true;
  if (m.exact.has(`${ANY_METHOD} ${callPath}`)) return true;
  if (isPlaceholderOnlyPath(callPath)) return false;
  const varPaths = [
    ...(m.varPathsByMethod.get(method) ?? []),
    ...(m.varPathsByMethod.get(ANY_METHOD) ?? []),
  ];
  if (varPaths.some((p) => varRouteCovers(p, callPath))) return true;
  const prefixes = [
    ...(m.catchAllPrefixesByMethod.get(method) ?? []),
    ...(m.catchAllPrefixesByMethod.get(ANY_METHOD) ?? []),
  ];
  return prefixes.some((p) => catchAllPrefixCovers(p, callPath));
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
  const varRoutesByMethod = new Map<HttpMethodKey, RouteEndpoint[]>();
  for (const r of routes) {
    routeIndex.set(`${r.method} ${r.path}`, r);
    if (isCatchAllPath(r.path)) {
      const list = catchAllsByMethod.get(r.method) ?? [];
      list.push({ route: r, prefix: catchAllStaticPrefix(r.path) });
      catchAllsByMethod.set(r.method, list);
    } else if (r.path.includes('{var}')) {
      const list = varRoutesByMethod.get(r.method) ?? [];
      list.push(r);
      varRoutesByMethod.set(r.method, list);
    }
  }

  return calls.map((call): FlowBinding => {
    if (call.path == null) return { call, route: null, confidence: 0, reason: 'external' };
    // A method-agnostic route (`ANY /path`) serves the path for every verb at
    // the routing layer, so it resolves any concrete method — the same rule
    // `servedMatch` applies (Rule 2 parity between join and gate).
    const route =
      routeIndex.get(`${call.method} ${call.path}`) ??
      routeIndex.get(`${ANY_METHOD} ${call.path}`) ??
      null;
    if (route) {
      if (isPlaceholderOnlyPath(call.path)) {
        return { call, route, confidence: 0.3, reason: 'placeholder-only' };
      }
      return { call, route, confidence: 1, reason: 'exact' };
    }
    const varRoute = bestVarMatch(call.path, [
      ...(varRoutesByMethod.get(call.method) ?? []),
      ...(varRoutesByMethod.get(ANY_METHOD) ?? []),
    ]);
    if (varRoute) return { call, route: varRoute, confidence: 0.9, reason: 'var-match' };
    const catchAll = bestCatchAllMatch(call.path, [
      ...(catchAllsByMethod.get(call.method) ?? []),
      ...(catchAllsByMethod.get(ANY_METHOD) ?? []),
    ]);
    if (catchAll) return { call, route: catchAll, confidence: 0.7, reason: 'catch-all' };
    return { call, route: null, confidence: 0, reason: 'no-route' };
  });
}

/** The most-specific `{var}` route covering a concrete call path — most
 *  literal segments wins (`/a/b/{var}` beats `/a/{var}/{var}`); ties break on
 *  declaration order. Not applied to an all-placeholder call (no signal). */
function bestVarMatch(callPath: string, candidates: RouteEndpoint[]): RouteEndpoint | null {
  if (candidates.length === 0 || isPlaceholderOnlyPath(callPath)) return null;
  let best: { route: RouteEndpoint; literals: number } | null = null;
  for (const r of candidates) {
    if (!varRouteCovers(r.path, callPath)) continue;
    const literals = r.path.split('/').filter((seg) => seg.length > 0 && seg !== '{var}').length;
    if (!best || literals > best.literals) best = { route: r, literals };
  }
  return best?.route ?? null;
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
    if (catchAllPrefixCovers(c.prefix, callPath) && (!best || c.prefix.length > best.prefix.length))
      best = c;
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
  const dynamicCalls = fileFlows.flatMap((f) => f.dynamicCalls ?? []);
  return { calls, routes, bindings: joinFlow(calls, routes), dynamicCalls };
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
