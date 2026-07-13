/**
 * The holistic map's intra-repo model: dxkit's OWN tree-sitter call graph
 * (deeper than graphify — measured 3.3x more callees/fn, framework calls
 * included) JOINED to the HTTP contract layer. Pure; graphify-free.
 *
 * Graph source = `gatherFunctionSignatures` (`FunctionSignature{file,name,line,
 * callees:Set<name>}`). Callees are NAMES, so this module resolves each callee
 * name to an in-repo definition (file-preferred, to break the cross-file
 * collision a bare name hits); a name with no in-repo def is an EXTERNAL leaf
 * (framework/stdlib) — exactly the edges graphify drops. Routes/calls (already
 * from dxkit's flow extractor) anchor to the function that serves/makes them.
 */
import * as path from 'path';
import { buildServedMatcher, servedMatch } from '../analyzers/flow/model';
import { frontendConsumerCount } from '../analyzers/flow/diagnose';
import type { FunctionSignature } from '../analyzers/duplication/signatures';
import type { FlowModel } from '../analyzers/flow/model';
import type { RouteEndpoint, ClientCall } from '../analyzers/flow/extract';
import type { EpistemicLabel } from '../evidence/conventions';

/** A function in the resolved intra-repo graph. */
export interface FnNode {
  readonly id: string; // `${file}#${name}#${line}`
  readonly file: string;
  readonly name: string;
  readonly line: number;
  /** In-repo callees resolved to their FnNode ids (the traversable edges). */
  readonly internalCallees: readonly string[];
  /** Callee names with no in-repo def — framework/stdlib (graphify drops these). */
  readonly externalCallees: readonly string[];
  /** Total callee breadth (internal + external) — the "depth" signal. */
  readonly fanout: number;
}

/** A served route anchored to its handler function (when resolvable). */
export interface RouteAnchor {
  readonly route: RouteEndpoint;
  readonly handlerId: string | null;
}

/** A client call anchored to its caller function (when resolvable). */
export interface CallAnchor {
  readonly call: ClientCall;
  readonly callerId: string | null;
}

export interface IntraRepoModel {
  readonly repo: string;
  readonly fns: readonly FnNode[];
  readonly fnById: ReadonlyMap<string, FnNode>;
  readonly routes: readonly RouteAnchor[];
  readonly calls: readonly CallAnchor[];
  /** Canonical consumers-visible signal (co-located UI bindings) — the ONE
   *  computation shared with `diagnoseFlow`, not a describe-local heuristic. */
  readonly frontendConsumers: number;
  readonly stats: {
    readonly functions: number;
    readonly meanFanout: number;
    readonly internalEdges: number;
    readonly externalCalls: number;
  };
}

const fnId = (s: { file: string; name: string; line: number }): string =>
  `${s.file}#${s.name}#${s.line}`;

/** Enclosing signature for a source location: nearest decl at-or-above `line`
 *  in the same file (the same heuristic the graph's enclosingNodeIdFor uses). */
function enclosingFn(
  byFile: Map<string, FunctionSignature[]>,
  file: string,
  line: number,
): FunctionSignature | undefined {
  const inFile = byFile.get(file);
  if (!inFile) return undefined;
  let best: FunctionSignature | undefined;
  for (const s of inFile) {
    if (s.line > line) continue;
    if (!best || s.line > best.line) best = s;
  }
  return best;
}

/** Signature by NAME within a file (route → handler); parens-insensitive. */
function fnByName(
  byFile: Map<string, FunctionSignature[]>,
  file: string,
  name: string,
): FunctionSignature | undefined {
  const want = name.replace(/\(\)$/, '');
  return byFile.get(file)?.find((s) => s.name === want);
}

/** Normalize a flow-model file path to the repo-relative POSIX form the
 *  signatures use (the flow extractor emits absolute paths; signatures emit
 *  repo-relative). A relative path is passed through. */
function relFile(root: string, file: string): string {
  const r = path.isAbsolute(file) ? path.relative(root, file) : file;
  return r.split(path.sep).join('/');
}

/**
 * Build the joined intra-repo model. `repo` labels the cluster (for the
 * cross-repo layer); `root` normalizes the flow model's absolute paths to the
 * signatures' repo-relative form. Pure — no I/O; the caller gathers `sigs` +
 * `flow`.
 */
export function buildIntraRepoModel(
  repo: string,
  root: string,
  sigs: readonly FunctionSignature[],
  flow: FlowModel,
): IntraRepoModel {
  // Index signatures by file (for enclosing/name resolution) and by callee
  // name (for name→def resolution of internal edges).
  const byFile = new Map<string, FunctionSignature[]>();
  const byName = new Map<string, FunctionSignature[]>();
  for (const s of sigs) {
    (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
    (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)!).push(s);
  }

  // Resolve each signature's callees → in-repo defs (file-preferred) vs external.
  let internalEdges = 0;
  let externalCalls = 0;
  const fns: FnNode[] = sigs.map((s) => {
    const internal: string[] = [];
    const external: string[] = [];
    for (const callee of s.callees) {
      const defs = byName.get(callee);
      if (!defs || defs.length === 0) {
        external.push(callee);
        continue;
      }
      // Prefer a def in the SAME file, else the first (a real def exists in-repo).
      const target = defs.find((d) => d.file === s.file) ?? defs[0];
      internal.push(fnId(target));
    }
    internalEdges += internal.length;
    externalCalls += external.length;
    return {
      id: fnId(s),
      file: s.file,
      name: s.name,
      line: s.line,
      internalCallees: internal,
      externalCallees: external,
      fanout: s.callees.size,
    };
  });
  const fnById = new Map(fns.map((f) => [f.id, f]));

  // Anchor routes → handler fn, calls → caller fn (paths normalized to the
  // repo-relative form the signatures use).
  const routes: RouteAnchor[] = flow.routes.map((route) => {
    const file = relFile(root, route.file);
    const sig =
      (route.handler ? fnByName(byFile, file, route.handler) : undefined) ??
      enclosingFn(byFile, file, route.line);
    return { route, handlerId: sig ? fnId(sig) : null };
  });
  const calls: CallAnchor[] = flow.calls.map((call) => {
    const sig = enclosingFn(byFile, relFile(root, call.file), call.line);
    return { call, callerId: sig ? fnId(sig) : null };
  });

  const meanFanout = fns.length ? fns.reduce((a, f) => a + f.fanout, 0) / fns.length : 0;

  return {
    repo,
    fns,
    fnById,
    routes,
    calls,
    frontendConsumers: frontendConsumerCount(flow),
    stats: {
      functions: fns.length,
      meanFanout: Number(meanFanout.toFixed(2)),
      internalEdges,
      externalCalls,
    },
  };
}

// ─── Cross-repo mesh → the render graph ──────────────────────────────────────

/** A node in the holistic render graph. Lanes drive the left→right layout. */
export interface HNode {
  readonly id: string;
  readonly repo: string;
  readonly lane: 'caller' | 'route' | 'handler';
  readonly kind: 'call' | 'route' | 'handler';
  readonly label: string;
  readonly seam?: 'broken' | 'dead';
  /** route node → its handler node id (the expand anchor). */
  readonly handlerId?: string;
  /** handler node → its drill id (key into `HolisticGraph.fns`) for expansion. */
  readonly drillId?: string;
  /** route node → the drill ids of the (same-repo) functions that call it. */
  readonly callerDrillIds?: readonly string[];
  /** handler node → its callee breadth (the depth badge). */
  readonly fanout?: number;
  readonly title: string;
}

export interface HEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'binding' | 'serves' | 'cross-repo';
  readonly label: EpistemicLabel;
  readonly crossRepo?: boolean;
}

/** One function in the drill-down graph: its in-repo callees (drill ids you can
 *  expand further) and its external/library leaves. Lets the map reveal the real
 *  internal call path hop by hop, interactively. */
export interface FnDrill {
  readonly name: string;
  readonly repo: string;
  /** Drill ids of in-repo callees (keys into `HolisticGraph.fns`). */
  readonly internal: readonly string[];
  /** Library/framework callee names (no in-repo def — leaves of the path). */
  readonly external: readonly string[];
  readonly fanout: number;
}

export interface HolisticGraph {
  readonly repos: readonly string[];
  readonly nodes: readonly HNode[];
  readonly edges: readonly HEdge[];
  /** The bounded call-graph reachable from handlers, for progressive drill-down.
   *  Keyed by drill id (`${repo}::${fnId}`); handler nodes carry their `drillId`. */
  readonly fns: Readonly<Record<string, FnDrill>>;
  /** Mesh-wide totals (route/call nodes merge, so count these separately). */
  readonly counts: { readonly routes: number; readonly calls: number };
  readonly seams: {
    readonly brokenCalls: number;
    readonly deadRoutes: number;
    readonly crossRepoEdges: number;
  };
  readonly depth: {
    readonly functions: number;
    readonly meanFanout: number;
    readonly internalCalls: number;
    readonly externalCalls: number;
  };
  readonly notes: readonly string[];
}

const routeKey = (method: string, path: string): string => `${method} ${path}`;
const nid = (repo: string, kind: string, k: string): string => `${repo}::${kind}::${k}`;

/** True when a path has at least one literal (non-placeholder) character — a
 *  real anchor to resolve against. `/api/{id}` → true; `/{var}:{var}` → false. */
const hasLiteralAnchor = (path: string): boolean =>
  /[a-zA-Z0-9]/.test(path.replace(/\{[^}]*\}/g, ''));

/** A served route across the whole mesh, with its owning repo + a matcher that
 *  resolves a call path to it (exact / var / catch-all). */
interface ServedRef {
  readonly repo: string;
  readonly route: RouteEndpoint;
  readonly nodeId: string;
  readonly handlerNodeId: string | null;
  readonly matcher: ReturnType<typeof buildServedMatcher>;
}

/**
 * Assemble the holistic render graph from per-repo intra models. Resolves every
 * client call against the WHOLE mesh's served routes: a match in the caller's
 * own repo is an intra binding, a match in another repo is a cross-repo edge, no
 * match is a broken seam. A route no call anywhere consumes is dead. Pure.
 */
export function buildHolisticGraph(models: readonly IntraRepoModel[]): HolisticGraph {
  const nodes: HNode[] = [];
  const edges: HEdge[] = [];
  const repos = models.map((m) => m.repo);
  const drillId = (repo: string, fid: string): string => `${repo}::${fid}`;

  // 1. Route + handler nodes; one served-ref (with matcher) per route.
  const served: ServedRef[] = [];
  const consumed = new Set<string>(); // route nodeIds a call resolves to
  for (const m of models) {
    for (const ra of m.routes) {
      const key = routeKey(ra.route.method, ra.route.path);
      const rNodeId = nid(m.repo, 'route', key);
      const handler = ra.handlerId ? m.fnById.get(ra.handlerId) : undefined;
      // A handler node IS its function node in the code graph — share the id
      // (`d:${drillId}`) so intra fn→fn edges connect to it seamlessly.
      const hNodeId = handler ? `d:${drillId(m.repo, handler.id)}` : null;
      nodes.push({
        id: rNodeId,
        repo: m.repo,
        lane: 'route',
        kind: 'route',
        label: `${ra.route.method} ${ra.route.path}`,
        handlerId: hNodeId ?? undefined,
        title: `served · via ${ra.route.via}${handler ? ` · ${handler.name}()` : ''}`,
      });
      if (handler && hNodeId) {
        nodes.push({
          id: hNodeId,
          repo: m.repo,
          lane: 'handler',
          kind: 'handler',
          label: `${handler.name}()`,
          drillId: drillId(m.repo, handler.id),
          fanout: handler.fanout,
          title: `${handler.name}() · ${handler.fanout} call(s): ${handler.internalCallees.length} internal, ${handler.externalCallees.length} library`,
        });
        edges.push({ from: rNodeId, to: hNodeId, kind: 'serves', label: 'observed' });
      }
      served.push({
        repo: m.repo,
        route: ra.route,
        nodeId: rNodeId,
        handlerNodeId: hNodeId,
        matcher: buildServedMatcher([key]),
      });
    }
  }

  // 2. Call nodes; resolve each against the mesh.
  let brokenCalls = 0;
  let crossRepoEdges = 0;
  let callCount = 0;
  // Visibility gate (load-bearing honesty): a route is "dead" only if the
  // CONSUMER side is actually visible (a co-located UI, or a workspace mesh);
  // a call is "broken" only if the SERVER side is visible. A standalone backend
  // whose frontend lives in another repo must NOT report all its routes dead,
  // and a standalone SPA whose API is elsewhere must NOT report all its calls
  // broken — those are the tool lying, not a finding.
  const multiRepo = models.length > 1;
  // Consumers-visible = the canonical `frontendConsumers` signal (co-located UI),
  // shared with diagnoseFlow — NOT a describe-local heuristic (Rule 2).
  const consumersVisible = multiRepo || models.some((m) => m.frontendConsumers > 0);
  const serversVisible = multiRepo || served.length > 0;
  // Callers of each (same-repo) route — attached to the route node so an intra
  // binding is ONE endpoint node (the frontend/backend two-ends collapse), not a
  // confusing pair of identically-labelled call+route nodes. A separate call
  // node survives only where it carries signal: a broken call or a cross-repo
  // call (where the two nodes really are in different repos).
  const callersByRoute = new Map<string, Set<string>>();
  const recordCaller = (routeNodeId: string, callerDid: string | undefined) => {
    if (!callerDid) return;
    if (!callersByRoute.has(routeNodeId)) callersByRoute.set(routeNodeId, new Set());
    callersByRoute.get(routeNodeId)!.add(callerDid);
  };
  for (const m of models) {
    for (const ca of m.calls) {
      const call = ca.call;
      // A call is only a meaningful endpoint if its path has a LITERAL anchor —
      // at least one real (non-placeholder) segment. A path that is all `{var}`
      // + punctuation (`/{var}:{var}`, `/{var} {var}`, `/{var}@{var}`) resolves
      // to nothing and is almost always flow over-extraction noise (a
      // `pkg@version` spec, a template literal parsed as a URL), so it must not
      // litter the map with `GET /{var}` nodes.
      if (call.path === null || !hasLiteralAnchor(call.path)) continue;
      callCount++;
      const cNodeId = nid(m.repo, 'call', `${call.method} ${call.path}#${call.file}:${call.line}`);
      const callerDid = ca.callerId ? drillId(m.repo, ca.callerId) : undefined;
      const own = served.find(
        (s) => s.repo === m.repo && servedMatch(call.method, call.path!, s.matcher),
      );
      const hit =
        own ??
        served.find((s) => s.repo !== m.repo && servedMatch(call.method, call.path!, s.matcher));
      if (!hit) {
        // Only a "broken" seam when a server side is visible to break against.
        const broken = serversVisible;
        if (broken) brokenCalls++;
        nodes.push({
          id: cNodeId,
          repo: m.repo,
          lane: 'caller',
          kind: 'call',
          label: `${call.method} ${call.path}`,
          drillId: callerDid,
          ...(broken ? { seam: 'broken' as const } : {}),
          title: broken
            ? `client call · reaches no served route · ${call.file.split('/').slice(-1)[0]}:${call.line}`
            : `outbound call · target served outside this repo · ${call.file.split('/').slice(-1)[0]}:${call.line}`,
        });
        continue;
      }
      consumed.add(hit.nodeId);
      if (hit.repo !== m.repo) {
        // cross-repo: keep both nodes + the crossing edge (the meaningful pair).
        crossRepoEdges++;
        const label: EpistemicLabel =
          routeKey(hit.route.method, hit.route.path) === `${call.method} ${call.path}`
            ? 'observed'
            : 'inferred';
        nodes.push({
          id: cNodeId,
          repo: m.repo,
          lane: 'caller',
          kind: 'call',
          label: `${call.method} ${call.path}`,
          drillId: callerDid,
          title: `client call · cross-repo → ${hit.repo} · ${call.file.split('/').slice(-1)[0]}:${call.line}`,
        });
        edges.push({ from: cNodeId, to: hit.nodeId, kind: 'cross-repo', label, crossRepo: true });
      } else {
        // intra: MERGE into the one endpoint node; record the caller fn.
        recordCaller(hit.nodeId, callerDid);
      }
    }
  }

  // 3. Dead routes: served, consumed by no call anywhere in the mesh.
  // Only mint "dead" when the consumer side is visible (else an unconsumed
  // route just means its caller lives in another repo — not a finding).
  let deadRoutes = 0;
  const dead = new Set<string>();
  if (consumersVisible) {
    for (const s of served) {
      if (!consumed.has(s.nodeId)) {
        deadRoutes++;
        dead.add(s.nodeId);
      }
    }
  }
  const finalNodes = nodes.map((n) => {
    const callers = callersByRoute.get(n.id);
    const withCallers = callers && callers.size ? { ...n, callerDrillIds: [...callers] } : n;
    return dead.has(n.id) ? { ...withCallers, seam: 'dead' as const } : withCallers;
  });

  // 4. Code graph: the WHOLE resolved intra-repo call graph (every function +
  // its in-repo callees), keyed by drill id (`${repo}::${fnId}`). This is the
  // graphify layer — the map renders it (seam-focused by default, the full graph
  // on demand) and drills it hop by hop. Bounded so a huge monorepo stays a
  // shippable offline file; the truncation is disclosed.
  const fns: Record<string, FnDrill> = {};
  const GLOBAL_CAP = 3500;
  const notes: string[] = [];
  let truncated = 0;
  for (const m of models) {
    for (const fn of m.fns) {
      if (Object.keys(fns).length >= GLOBAL_CAP) {
        truncated++;
        continue;
      }
      fns[drillId(m.repo, fn.id)] = {
        name: fn.name,
        repo: m.repo,
        internal: fn.internalCallees.map((id) => drillId(m.repo, id)),
        external: fn.externalCallees,
        fanout: fn.fanout,
      };
    }
  }
  if (truncated > 0) {
    notes.push(`Code graph capped at ${GLOBAL_CAP} functions; ${truncated} more not shown.`);
  }
  // Actionable disclosure when a tier is missing (why the seams look sparse).
  if (!serversVisible && callCount > 0) {
    notes.push(
      `${callCount} call${callCount === 1 ? '' : 's'} target APIs served outside this repo — add a .dxkit/workspace.json pointing at the backend to resolve them.`,
    );
  } else if (!consumersVisible && served.length > 0) {
    notes.push(
      `Consumers aren't in this repo — add a workspace pointing at the calling app to detect dead routes and broken calls.`,
    );
  }

  const functions = models.reduce((a, m) => a + m.stats.functions, 0);
  const externalCalls = models.reduce((a, m) => a + m.stats.externalCalls, 0);
  const internalCalls = models.reduce((a, m) => a + m.stats.internalEdges, 0);
  const meanFanout = functions
    ? Number(
        (
          models.reduce((a, m) => a + m.stats.meanFanout * m.stats.functions, 0) / functions
        ).toFixed(2),
      )
    : 0;

  return {
    repos,
    nodes: finalNodes,
    edges,
    fns,
    counts: { routes: served.length, calls: callCount },
    seams: { brokenCalls, deadRoutes, crossRepoEdges },
    depth: { functions, meanFanout, internalCalls, externalCalls },
    notes,
  };
}
