/**
 * Flow extraction — the AST pass that turns source into the two sides of an
 * HTTP integration: outbound client calls (CONSUMED) and inbound route
 * declarations (SERVED).
 *
 * It is the cross-cutting consumer of four seams and hardcodes none of them:
 *   - the canonical AST layer (`src/ast/`) for parsing — graphify-independent,
 *     and registered as its own concern, never folded into graphify's pass;
 *   - the per-grammar shape table (`src/ast/grammar-shape.ts`) for HOW to read
 *     a call / member / string / decorator from this grammar's tree — no
 *     `call_expression` / `attribute` node name lives here, so the one
 *     extractor walks any grammar and a new language adds flow with ZERO
 *     extractor edits;
 *   - each pack's `httpFlow` descriptor (Rule 6) for WHICH constructs are HTTP
 *     — no `fetch`/`axios`/`@get` literal lives here;
 *   - the shared normalizer for canonical paths + verbs.
 *
 * Every source file is scanned for BOTH surfaces: a backend that serves routes
 * AND calls other services contributes to both lists (the consumer/provider
 * model — a participant is whatever its served/consumed sets make it). Role
 * assignment happens above this module, never inside it.
 *
 * Precision guard (validated): a member call on an UNTRUSTED receiver (one not
 * in the descriptor's `bases`) only counts as a client call when its first
 * argument is a path-like literal — that filter keeps non-HTTP `.get`/`.delete`
 * (lodash, Maps, dict.get) out while still catching app-specific wrappers.
 * A TRUSTED receiver (`requests`, `httpx` — always HTTP by construction) skips
 * the guard, so its dynamic-URL calls are COUNTED as unverifiable rather than
 * silently dropped (coverage honesty).
 */

import { getLanguage } from '../../languages';
import type { HttpFlowSupport, LanguageId } from '../../languages/types';
import { parseFile, walk, type Node } from '../../ast/parse';
import { grammarShape, type GrammarShape, type ResolvedCall } from '../../ast/grammar-shape';
import {
  ANY_METHOD,
  normalizeMethod,
  normalizePath,
  type HttpMethod,
  type NormalizeConfig,
  type ServedMethod,
} from './normalize';
import { mergeHttpFlow } from './dialects';
import { deriveFileRoutePath, exportedMethodNames } from './file-routes';
import { extractDecoratorFlow } from './extract-decorators';
import { collectGroupPrefix, joinNormalizedPaths } from './extract-prefix';
import { matchChainCall } from './extract-chains';

/** An outbound HTTP call found in source (the consumed side). */
export interface ClientCall {
  readonly method: HttpMethod;
  readonly rawUrl: string;
  /** Normalized path, or `null` when the URL is dynamic/external (unresolved). */
  readonly path: string | null;
  readonly receiver: string;
  readonly file: string;
  readonly line: number;
}

/** An inbound route a service serves (the served side). `via` records how it
 *  was discovered: a source decorator, an Express-style route call, a
 *  file-convention route handler (Next.js App Router / SvelteKit — the URL is
 *  derived from the file's location), or an ingested OpenAPI/spec document
 *  (preferred when available). */
export interface RouteEndpoint {
  /** A concrete verb, or `ANY` for a method-agnostic declaration (a routing
   *  layer that binds a path for every method — Django `path()`, Go
   *  `http.HandleFunc`). See `ANY_METHOD` in `normalize.ts`. */
  readonly method: ServedMethod;
  readonly path: string;
  /** The four static-extraction provenances are the closed core; a declared
   *  contract artifact contributes its registry kind ('openapi', 'postman',
   *  'pact', 'http', 'har', a synthetic test kind) — the `(string & {})`
   *  keeps those open (registry-driven) while preserving completion on the
   *  core literals. Consumers treat `via` as display provenance; the one
   *  semantic reader is the spec-preference dedup in `model.ts`. */
  readonly via: 'decorator' | 'router-call' | 'file-route' | 'spec' | (string & {});
  readonly handler: string | null;
  readonly file: string;
  readonly line: number;
}

/** A RECOGNIZED client call site whose URL is built dynamically — the extractor
 *  saw `fetch(...)` / an allowlisted `api.get(...)` but the first argument is
 *  not a literal, so there is nothing to join. Counted (never silently
 *  dropped): these are the calls flow admits it cannot verify. The precision
 *  guard's rejections (a non-HTTP `map.get(key)`) are NOT in this set — that
 *  is filtering working, not a blind spot. */
export interface DynamicCallSite {
  readonly receiver: string;
  readonly file: string;
  readonly line: number;
}

/** Both HTTP surfaces extracted from one file. */
export interface FileFlow {
  readonly calls: ClientCall[];
  readonly routes: RouteEndpoint[];
  /** Recognized-but-unextractable call sites (see {@link DynamicCallSite}). */
  readonly dynamicCalls?: DynamicCallSite[];
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * Does a raw literal look like a URL/path at the source level — i.e. could this
 * `.get(...)`/`.post(...)` plausibly be an HTTP call rather than a Map/cache/
 * lodash accessor? Used only for member calls on UNTRUSTED receivers, where it
 * is the precision guard: a leading `/`, a leading template (`${host}/…`), an
 * explicit scheme, or any embedded `/` qualifies; a bare token like
 * `'config-key'` does not. (Route decorators are exempt — a framework route
 * string is known to be a path even without a leading slash.)
 */
function looksLikeUrlLiteral(raw: string | null): boolean {
  if (raw == null) return false;
  let s = raw.trim();
  if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) s = s.slice(1, -1);
  return s.startsWith('/') || s.startsWith('${') || s.includes('://') || s.includes('/');
}

/** Does a member-call receiver match one of the declared bases (e.g. `app`, or
 *  `this.app`)? */
function receiverMatchesBase(receiver: string, bases: readonly string[]): boolean {
  return bases.some((b) => receiver === b || receiver.endsWith(`.${b}`));
}

/**
 * Does a CHAINED receiver's head identifier match a base? Router registration
 * is frequently chained through middleware helpers — chi's
 * `r.With(paginate).Get("/", h)`, `r.Route("/x").Get(...)` — where the
 * receiver TEXT is the whole chain expression. The chain head (`r`) is what
 * identifies the router; without this, a chained registration falls through
 * to the client branch and a served route reads as a consumed call.
 */
function receiverHeadMatchesBase(receiver: string, bases: readonly string[]): boolean {
  const head = receiver.split(/[.([]/, 1)[0].trim();
  return head.length > 0 && bases.includes(head);
}

/** Pull `method: 'X'` out of a fetch-style options argument, default GET. */
function fetchMethod(call: Node, shape: GrammarShape, hf: HttpFlowSupport): HttpMethod {
  const value = shape.optionValue(call, 'method');
  const raw = value ? shape.stringText(value) : null;
  if (raw) {
    const verb = normalizeMethod(raw.replace(/['"`]/g, ''), hf.methodAliases);
    if (verb) return verb;
  }
  return 'GET';
}

/**
 * Extract both HTTP surfaces from one already-parsed tree using a pack's
 * httpFlow descriptor (WHAT is HTTP) and the grammar's shape (HOW to read the
 * tree). Pure over its inputs.
 */
export function extractFromTree(
  root: Node,
  hf: HttpFlowSupport,
  shape: GrammarShape,
  file: string,
  config?: NormalizeConfig,
  relPath?: string,
): FileFlow {
  const calls: ClientCall[] = [];
  const routes: RouteEndpoint[] = [];
  const dynamicCalls: DynamicCallSite[] = [];

  // ── file-convention routes (Next.js App Router / SvelteKit) ──
  // The served URL is derived from the handler file's LOCATION, so this needs
  // the repo-relative path (`relPath`), falling back to `file` when the caller
  // has only the scanned path. Additive to the in-source walk below: a route
  // handler can also make outbound calls, and both surfaces are recorded.
  if (hf.fileRoutes) {
    const routePath = deriveFileRoutePath(relPath ?? file, hf.fileRoutes, config);
    if (routePath) {
      for (const { name, line: exportLine } of exportedMethodNames(
        root,
        hf.fileRoutes.methodExports,
      )) {
        const method = normalizeMethod(name, hf.methodAliases);
        if (method) {
          routes.push({
            method,
            path: routePath,
            via: 'file-route',
            handler: name,
            file,
            line: exportLine,
          });
        }
      }
    }
  }

  const clientCallees = new Set(hf.clientCallees ?? []);
  const methodCallMethods = new Set(hf.clientMethodCallees?.methods ?? []);
  const methodCallBases = hf.clientMethodCallees?.bases;
  const routerMethods = new Set(hf.routeRouterCallees?.methods ?? []);
  const routerBases = hf.routeRouterCallees?.bases ?? [];
  const routeCalleeNames = new Set(hf.routeCallees?.names ?? []);
  const routeCalleeMemberNames = new Set(hf.routeCallees?.memberNames ?? []);
  const routeCalleeExcludes = new Set(hf.routeCallees?.excludeArgCallees ?? []);
  const routeCalleeMethodPrefix = hf.routeCallees?.methodPrefixInPath === true;
  const requestCallees = hf.clientRequestCallees;
  const requestCalleeNames = new Set(requestCallees?.names ?? []);

  const literalText = (node: Node | null): string | null => (node ? shape.stringText(node) : null);

  /** Strip surrounding quotes/backticks off a literal's verbatim text. */
  const unquote = (raw: string): string => {
    const s = raw.trim();
    if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) return s.slice(1, -1);
    return s;
  };

  walk(root, (node) => {
    // ── decorator flow: routes (@get('/x'), @app.route(...), JAX-RS pairs)
    //    and decorator-declared client calls (Retrofit @GET("users/{id}")) ──
    if (shape.decoratorNodes.includes(node.type)) {
      const dec = extractDecoratorFlow(node, shape, hf, file, line(node), config);
      routes.push(...dec.routes);
      calls.push(...dec.calls);
      // A decorator's invocation is a declaration, never a call site — skip
      // the subtree so `@app.get('/x')`'s inner member call isn't double-read
      // as an outbound `app.get(...)`.
      return false;
    }

    if (!shape.callNodes.includes(node.type)) return;
    const callee = shape.resolveCall(node);
    if (!callee) return;

    // ── bare VERB route callee: Ktor `get("/x") { … }` — the callee IS the
    //    verb, the first argument is the path (leading `/` required), the
    //    handler is a trailing lambda. Ancestor `route("/api") { … }` groups
    //    prefix the path (extract-prefix.ts).
    const verbCallees = hf.routeVerbCallees;
    if (callee.kind === 'bare' && verbCallees && verbCallees.methods.includes(callee.name)) {
      const raw = literalText(shape.firstArg(node));
      const lambdaOk =
        verbCallees.requireTrailingLambda !== true ||
        (shape.hasTrailingLambda !== undefined && shape.hasTrailingLambda(node));
      if (raw != null && unquote(raw).startsWith('/') && lambdaOk) {
        const own = normalizePath(raw, config);
        const path = joinNormalizedPaths(collectGroupPrefix(node, shape, hf, config), own);
        const method = normalizeMethod(callee.name, hf.methodAliases);
        if (path && method) {
          routes.push({ method, path, via: 'router-call', handler: null, file, line: line(node) });
          return;
        }
      }
      // Not route-shaped (no slashed literal / no lambda) — fall through to
      // the client branches: `get(...)` may still be a declared client callee.
    }

    // ── verb-less route callee: Django `path('users/<int:pk>/', view)`,
    //    Go `http.HandleFunc("/x", h)` / `mux.HandleFunc("GET /users/{id}", h)` ──
    // Method-agnostic at the routing layer → emitted as an `ANY` route (the
    // join/gate resolve any verb against it), unless `methodPrefixInPath`
    // reads a concrete verb off the pattern head (Go 1.22 mux). Guards: a
    // string-literal first arg, a present second arg (the handler), and no
    // argument that is a call to an excluded name (`include(...)` mounts a
    // sub-conf — its first arg is a PREFIX, not a served route). A MEMBER
    // match (`.Handle(...)` sits on any receiver) additionally requires the
    // pattern to begin with `/` — every Go pattern does, and the guard keeps
    // generic `.Handle('event', fn)` registrations out.
    const routeCalleeMatch =
      (callee.kind === 'bare' && routeCalleeNames.has(callee.name)) ||
      (callee.kind === 'member' && routeCalleeMemberNames.has(callee.name));
    if (routeCalleeMatch) {
      const args = shape.positionalArgs(node);
      const raw = args[0] ? shape.stringText(args[0]) : null;
      const excluded = args.some((a) => {
        if (!shape.callNodes.includes(a.type)) return false;
        const inner = shape.resolveCall(a);
        return inner !== null && routeCalleeExcludes.has(inner.name);
      });
      if (raw != null && args.length >= 2 && !excluded) {
        // Method-prefix pattern: `"GET /users/{id}"` → a concrete verb route.
        let method: HttpMethod | typeof ANY_METHOD = ANY_METHOD;
        let pattern = unquote(raw);
        if (routeCalleeMethodPrefix) {
          const sp = pattern.indexOf(' ');
          if (sp > 0) {
            const verb = normalizeMethod(pattern.slice(0, sp), hf.methodAliases);
            if (verb) {
              method = verb;
              pattern = pattern.slice(sp + 1).trim();
            }
          }
        }
        if (callee.kind === 'member' && !pattern.startsWith('/')) return;
        const path = normalizePath(pattern, config);
        if (path) {
          const handlerText = args[1]?.text ?? '';
          routes.push({
            method,
            path,
            via: 'router-call',
            handler: /^\S+$/.test(handlerText) ? handlerText : null,
            file,
            line: line(node),
          });
        }
      }
      return;
    }

    // ── request-constructor client: http.NewRequest("GET", url, body) ──
    // The METHOD is a positional string argument and the URL the next one.
    // `NewRequestWithContext(ctx, "GET", url, …)` shifts both right, so the
    // rule is positional-shape-independent: the first argument whose text is a
    // verb literal is the method; its successor is the URL. These constructors
    // are HTTP by definition, so a runtime-built URL (the common case) is
    // COUNTED as a dynamic call site, never silently dropped.
    if (
      requestCallees &&
      requestCalleeNames.has(callee.name) &&
      (callee.kind === 'bare' ||
        requestCallees.bases === undefined ||
        receiverMatchesBase(callee.receiver, requestCallees.bases) ||
        requestCallees.bases.includes(callee.receiver))
    ) {
      const receiver = callee.kind === 'member' ? callee.receiver : callee.name;
      const args = shape.positionalArgs(node);
      let method: HttpMethod | null = null;
      let urlArg: Node | null = null;
      for (let i = 0; i < args.length; i++) {
        const text = shape.stringText(args[i]);
        if (text == null) continue;
        const verb = normalizeMethod(unquote(text), hf.methodAliases);
        if (verb) {
          method = verb;
          urlArg = args[i + 1] ?? null;
        }
        break; // the first string argument decides — verb or not
      }
      const rawUrl = urlArg ? shape.stringText(urlArg) : null;
      if (method && rawUrl != null) {
        calls.push({
          method,
          rawUrl,
          path: normalizePath(rawUrl, config),
          receiver,
          file,
          line: line(node),
        });
      } else {
        // Unreadable method or runtime-built URL — recognized, unverifiable.
        dynamicCalls.push({ receiver, file, line: line(node) });
      }
      return;
    }

    // ── bare client call: fetch(url, opts) ──
    if (callee.kind === 'bare' && clientCallees.has(callee.name)) {
      const raw = literalText(shape.firstArg(node));
      if (raw != null) {
        calls.push({
          method: fetchMethod(node, shape, hf),
          rawUrl: raw,
          path: normalizePath(raw, config),
          receiver: callee.name,
          file,
          line: line(node),
        });
      } else {
        // A known client with a dynamically-built URL — count it (coverage
        // honesty), don't silently drop it.
        dynamicCalls.push({ receiver: callee.name, file, line: line(node) });
      }
      return;
    }

    // ── member call: <recv>.<verb>(url|path, ...) ──
    if (callee.kind === 'member') {
      const verb = callee.name;
      const receiver = callee.receiver;

      // builder-chain client: the verb and URL live on DIFFERENT calls of one
      // chain (WebClient .get().uri(), java.net.http .uri().GET(), OkHttp
      // .url().get()). Anchored on the URL-bearing call; see extract-chains.
      const chain = matchChainCall(node, callee, hf, shape, config);
      if (chain) {
        if (chain.kind === 'call' && chain.rawUrl != null) {
          calls.push({
            method: chain.method,
            rawUrl: chain.rawUrl,
            path: chain.path,
            receiver: chain.receiver,
            file,
            line: line(node),
          });
        } else {
          dynamicCalls.push({ receiver: chain.receiver, file, line: line(node) });
        }
        return;
      }

      // router/app route declaration. A route DECLARATION always carries a
      // handler after the path (`app.get('/x', h)`), so a 1-argument
      // `.Get('/slashed/key')` on a router-named receiver (a cache client
      // named `r`, an HTTP wrapper named `app`) falls through to the CLIENT
      // branch below instead of minting a phantom route.
      if (
        routerMethods.has(verb) &&
        (receiverMatchesBase(receiver, routerBases) ||
          receiverHeadMatchesBase(receiver, routerBases)) &&
        shape.positionalArgs(node).length >= 2
      ) {
        const path = normalizePath(literalText(shape.firstArg(node)), config);
        const method = normalizeMethod(verb, hf.methodAliases);
        if (path && method) {
          routes.push({
            method,
            path,
            via: 'router-call',
            handler: receiver,
            file,
            line: line(node),
          });
        }
        return;
      }

      // client call. A TRUSTED receiver (declared in `bases` — `requests`,
      // `httpx`: HTTP by construction) needs no URL-shaped literal, and its
      // dynamic-URL calls are counted as unverifiable. An UNTRUSTED receiver
      // must pass the path-like-literal precision guard — that is what admits
      // app-specific wrappers (`api.get('/x')`) while keeping non-HTTP
      // `.get`/`.delete` (lodash, Maps, dict.get) out.
      if (methodCallMethods.has(verb)) {
        const trusted =
          methodCallBases !== undefined &&
          (receiverMatchesBase(receiver, methodCallBases) || methodCallBases.includes(receiver));
        const raw = literalText(shape.firstArg(node));
        if (!trusted && !looksLikeUrlLiteral(raw)) return;
        const method = normalizeMethod(verb, hf.methodAliases);
        if (raw != null && method) {
          calls.push({
            method,
            rawUrl: raw,
            path: normalizePath(raw, config),
            receiver,
            file,
            line: line(node),
          });
        } else if (raw == null && method) {
          // A TRUSTED client receiver with a dynamic URL — a call flow
          // recognizes but cannot verify. Counted, not silently dropped.
          // (Only reachable when trusted: the guard already returned above.)
          dynamicCalls.push({ receiver, file, line: line(node) });
        }
      }
    }
  });

  return { calls, routes, dynamicCalls };
}

/**
 * Extract both HTTP surfaces from one file on disk. Returns empty surfaces when
 * the language has no httpFlow descriptor or its grammar has no shape row, and
 * `null` when the file can't be parsed (engine/grammar unavailable or
 * unreadable) — callers treat `null` as "skip this file", never an error.
 */
export async function extractFileFlow(
  filePath: string,
  config?: NormalizeConfig,
  relPath?: string,
  /**
   * Plugin dialect overlay, indexed by pack id (`dialectsByPack`). The
   * file's pack descriptor and its dialects fold through `mergeHttpFlow`
   * (additive-only) before extraction — one extractor, widened tables.
   */
  dialects?: ReadonlyMap<string, HttpFlowSupport[]>,
): Promise<FileFlow | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  const hf = mergeHttpFlow(httpFlowFor(parsed.languageId), dialects?.get(parsed.languageId) ?? []);
  const shape = grammarShape(parsed.grammar);
  if (!hf || !shape) return { calls: [], routes: [] };
  return extractFromTree(parsed.tree.rootNode, hf, shape, filePath, config, relPath);
}

function httpFlowFor(languageId: LanguageId): HttpFlowSupport | undefined {
  return getLanguage(languageId)?.httpFlow;
}

export type { GrammarShape, ResolvedCall };
