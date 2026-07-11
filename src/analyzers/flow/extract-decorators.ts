/**
 * Decorator-flow recognition — the decorator-declared route AND client forms,
 * split from `extract.ts` as one cohesive sub-concern (each form is a
 * decorator node carrying an invocation):
 *
 *   - BARE verb decorators        `@get('/x')`               (LoopBack/NestJS;
 *                                 Spring `@GetMapping` — JVM annotations
 *                                 resolve as bare calls)
 *   - MEMBER verb decorators      `@app.get('/x')`            (FastAPI/Sanic)
 *   - PATH decorators + methods   `@app.route('/x', methods=['GET', 'POST'])`
 *                                 (Flask); `@RequestMapping(value = "/x",
 *                                 method = RequestMethod.GET)` (Spring)
 *   - SPLIT verb/path pairs       `@GET` + `@Path('/x')`      (JAX-RS)
 *   - CLIENT decorators           `@GET("users/{id}")`        (Retrofit — a
 *                                 CONSUMED call, never a route)
 *
 * Decorator routes are prefixed by ancestor `routePrefixDecorators`
 * (Spring/JAX-RS class-level paths — see `extract-prefix.ts`). Grammar access
 * goes through the shape (Rule 6 stays intact: WHICH decorator names matter
 * comes from the pack's descriptor; HOW to read a decorator node comes from
 * the grammar shape; the SEMANTICS live here). Pure over its inputs —
 * `extract.ts` calls this once per decorator node during its walk and owns
 * everything else.
 */

import type { GrammarShape } from '../../ast/grammar-shape';
import type { Node } from '../../ast/parse';
import type { HttpFlowSupport } from '../../languages/types';
import {
  ANY_METHOD,
  normalizeMethod,
  normalizePath,
  type NormalizeConfig,
  type ServedMethod,
} from './normalize';
import type { ClientCall, RouteEndpoint } from './extract';
import {
  collectDecoratorPrefix,
  decoratorPathRaw,
  decoratorPathsRaw,
  joinNormalizedPaths,
} from './extract-prefix';

/** Both surfaces one decorator can declare (a route OR a Retrofit-style
 *  consumed call — never both). */
export interface DecoratorFlow {
  readonly routes: RouteEndpoint[];
  readonly calls: ClientCall[];
}

/**
 * The handler name a route decorator is attached to (best-effort). Decorators
 * are siblings preceding the definition, so the handler is the decorator's
 * next named sibling (skipping any stacked decorators); a nested grammar shape
 * is handled by an ancestor fallback over the shape's definition node types.
 */
function decoratedHandlerName(decorator: Node, shape: GrammarShape): string | null {
  let sib: Node | null = decorator.nextNamedSibling;
  while (sib && shape.decoratorNodes.includes(sib.type)) sib = sib.nextNamedSibling;
  const sibName = sib?.childForFieldName('name');
  if (sibName) return sibName.text;
  let cur: Node | null = decorator.parent;
  for (let i = 0; cur && i < 3; i++) {
    if (shape.functionNodes.includes(cur.type)) {
      // Field-less grammars (kotlin) answer through the shape accessor.
      const name = cur.childForFieldName('name')?.text ?? shape.functionName?.(cur) ?? null;
      if (name) return name;
    }
    cur = cur.parent;
  }
  return null;
}

/** Does a member-call receiver match one of the declared bases? (Local copy of
 *  the exact-or-`.suffix` rule — the member-decorator form is the only
 *  consumer on this side of the split.) */
function receiverMatchesBase(receiver: string, bases: readonly string[]): boolean {
  return bases.some((b) => receiver === b || receiver.endsWith(`.${b}`));
}

/**
 * The route paths of a member/path decorator — its declared path strings
 * (positional, list, or a `decoratorPathKeywords` keyword), each REQUIRED to
 * begin with `/` once unquoted. FastAPI/Flask/Sanic/Spring mandate the
 * leading slash, and requiring it is the precision guard that keeps
 * look-alike member decorators (`@mock.patch('pkg.attr')`) from minting
 * phantom routes. (Bare `routeDecorators` keep their historical exemption —
 * LoopBack allows `@post('zen/x')` — and JAX-RS pair paths are exempt too.)
 */
function slashedDecoratorPaths(
  call: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  config?: NormalizeConfig,
): string[] {
  const out: string[] = [];
  for (const raw of decoratorPathsRaw(call, shape, hf)) {
    let s = raw.trim();
    if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) s = s.slice(1, -1);
    if (!s.startsWith('/')) continue;
    const norm = normalizePath(raw, config);
    if (norm) out.push(norm);
  }
  return out;
}

/** Join every declared own-path with the ancestor prefix, deduplicated;
 *  no own path at all → the prefix alone (a marker @PostMapping serves its
 *  class path). */
function prefixedPaths(prefix: string | null, owns: readonly (string | null)[]): string[] {
  const source = owns.filter((o): o is string => o !== null);
  const joined = (source.length > 0 ? source : [null]).map((own) =>
    joinNormalizedPaths(prefix, own),
  );
  return [...new Set(joined.filter((p): p is string => p !== null))];
}

/** A single method token off a non-list keyword value (`method =
 *  RequestMethod.GET` — the dotted tail) or a plain string. */
function singleMethodToken(value: Node, shape: GrammarShape): string | null {
  const text = shape.stringText(value);
  if (text != null) return text.replace(/['"`]/g, '');
  const t = value.text.trim();
  if (/^[A-Za-z_][\w.]*$/.test(t)) {
    const parts = t.split('.');
    return parts[parts.length - 1];
  }
  return null;
}

/** The declared methods of a path-first decorator (`methods=['GET','POST']`,
 *  `method = {RequestMethod.GET}`), read from its keyword argument; absent →
 *  the descriptor's defaults, where the `'ANY'` token means the
 *  method-agnostic route (a bare Spring `@RequestMapping` serves every verb). */
function pathDecoratorMethods(
  call: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  spec: NonNullable<HttpFlowSupport['routePathDecorators']>,
): ServedMethod[] {
  const value = shape.optionValue(call, spec.methodsKeyword);
  let tokens = value ? shape.listStrings(value).map((s) => s.replace(/['"`]/g, '')) : [];
  if (tokens.length === 0 && value) {
    const single = singleMethodToken(value, shape);
    if (single) tokens = [single];
  }
  const source = tokens.length > 0 ? tokens : spec.defaultMethods;
  return source
    .map((t) => (t === ANY_METHOD ? ANY_METHOD : normalizeMethod(t, hf.methodAliases)))
    .filter((m): m is ServedMethod => m !== null);
}

/** Is this decorator attached to a FUNCTION/METHOD declaration (vs a class)?
 *  Same bounded climb as the handler-name fallback: the handler declaration
 *  sits within a hop or two (decorator → [modifiers] → method). */
function isAttachedToFunction(decorator: Node, shape: GrammarShape): boolean {
  let cur: Node | null = decorator.parent;
  for (let i = 0; cur && i < 4; i++) {
    if (shape.functionNodes.includes(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

/** Decorators co-attached to the same declaration (stacked siblings, or
 *  siblings inside a shared container like Java/Kotlin `modifiers`). */
function coAttachedDecorators(decorator: Node, shape: GrammarShape): Node[] {
  const parent = decorator.parent;
  if (!parent) return [];
  const out: Node[] = [];
  for (const c of parent.namedChildren) {
    if (c && c.id !== decorator.id && shape.decoratorNodes.includes(c.type)) out.push(c);
  }
  return out;
}

/** The normalized path a JAX-RS-style pair takes from its SIBLING `@Path`
 *  decorator (no leading-slash requirement — `@Path("widgets")` is legal). */
function siblingPairPath(
  decorator: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  pathNames: readonly string[],
  config?: NormalizeConfig,
): string | null {
  for (const sib of coAttachedDecorators(decorator, shape)) {
    const call = shape.decoratorCall(sib);
    const callee = call ? shape.resolveCall(call) : null;
    if (!call || !callee || !pathNames.includes(callee.name)) continue;
    const norm = normalizePath(decoratorPathRaw(call, shape, hf), config);
    if (norm) return norm;
  }
  return null;
}

/**
 * The flow one decorator node declares: routes (usually 0 or 1; a Flask
 * `methods=['GET','POST']` yields one per verb) and/or a Retrofit-style
 * consumed call. The caller skips the decorator's subtree afterwards — its
 * inner invocation is a declaration, never an outbound call site.
 */
export function extractDecoratorFlow(
  decorator: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  file: string,
  line: number,
  config?: NormalizeConfig,
): DecoratorFlow {
  const call = shape.decoratorCall(decorator);
  const callee = call ? shape.resolveCall(call) : null;
  if (!call || !callee) return { routes: [], calls: [] };

  const base = {
    via: 'decorator' as const,
    handler: decoratedHandlerName(decorator, shape),
    file,
    line,
  };
  /** Ancestor class-level prefix, computed lazily (most decorators miss). */
  const prefix = (): string | null => collectDecoratorPrefix(decorator, shape, hf, config);

  // A PREFIX-bearing annotation on a non-function declaration (Spring's
  // class-level @RequestMapping, JAX-RS's class-level @Path) is consumed by
  // its descendants' prefix walks — it must never mint a route of its own,
  // even when its name also appears in a route form (@RequestMapping is BOTH
  // the class prefix and a method-level routePathDecorators name).
  if (
    (hf.routePrefixDecorators?.names ?? []).includes(callee.name) &&
    !isAttachedToFunction(decorator, shape)
  ) {
    return { routes: [], calls: [] };
  }

  // CLIENT decorator: Retrofit @GET("users/{id}") — a CALLED decorator with a
  // string path declares a CONSUMED call. Checked before the pair form: the
  // called-vs-marker asymmetry is what disambiguates Retrofit from JAX-RS
  // when one pack declares the same names on both sides.
  const client = hf.clientDecorators;
  if (client && callee.kind === 'bare' && client.names.includes(callee.name)) {
    const raw = decoratorPathRaw(call, shape, hf);
    const method = normalizeMethod(callee.name, hf.methodAliases);
    if (raw != null && method) {
      // Relative paths are the norm (joined against a runtime base URL) — no
      // leading-slash guard; normalizePath adds the slash.
      return {
        routes: [],
        calls: [
          {
            method,
            rawUrl: raw,
            path: normalizePath(raw, config),
            receiver: callee.name,
            file,
            line,
          },
        ],
      };
    }
  }

  // SPLIT verb/path pair: a MARKER (argument-less) verb annotation takes its
  // path from a sibling @Path — or from the class-level prefix alone.
  const pairs = hf.routeAnnotationPairs;
  if (
    pairs &&
    callee.kind === 'bare' &&
    pairs.methodMarkers.includes(callee.name) &&
    shape.firstArg(call) === null
  ) {
    const method = normalizeMethod(callee.name, hf.methodAliases);
    const own = siblingPairPath(decorator, shape, hf, pairs.pathNames, config);
    const path = joinNormalizedPaths(prefix(), own);
    return { routes: path && method ? [{ method, path, ...base }] : [], calls: [] };
  }

  // BARE verb decorator: @get('/x'), Spring @GetMapping("/x") /
  // @GetMapping(path = "/y") / @GetMapping({"/a", "/b"}) (one route per
  // entry) / marker @GetMapping (class prefix alone).
  if (callee.kind === 'bare' && (hf.routeDecorators ?? []).includes(callee.name)) {
    const owns = decoratorPathsRaw(call, shape, hf).map((raw) => normalizePath(raw, config));
    const paths = prefixedPaths(prefix(), owns);
    const method = normalizeMethod(callee.name, hf.methodAliases);
    return { routes: method ? paths.map((path) => ({ method, path, ...base })) : [], calls: [] };
  }

  // MEMBER verb decorator: FastAPI @app.get('/x').
  const member = hf.routeMemberDecorators;
  if (
    callee.kind === 'member' &&
    member &&
    member.methods.includes(callee.name) &&
    (member.bases === undefined || receiverMatchesBase(callee.receiver, member.bases))
  ) {
    const paths = prefixedPaths(prefix(), slashedDecoratorPaths(call, shape, hf, config));
    const method = normalizeMethod(callee.name, hf.methodAliases);
    return { routes: method ? paths.map((path) => ({ method, path, ...base })) : [], calls: [] };
  }

  // PATH-first decorator with a methods keyword: Flask @app.route(...),
  // Spring @RequestMapping(...). The leading-slash precision guard applies
  // to the MEMBER form only (Flask's @app.route — where a look-alike
  // @mock.patch('pkg.attr') must not mint a route); a BARE-resolved
  // annotation (Spring @RequestMapping(path = "{id}")) legally declares a
  // slash-less path RELATIVE to its class prefix.
  const pathSpec = hf.routePathDecorators;
  if (pathSpec && pathSpec.names.includes(callee.name)) {
    const owns =
      callee.kind === 'member'
        ? slashedDecoratorPaths(call, shape, hf, config)
        : decoratorPathsRaw(call, shape, hf).map((raw) => normalizePath(raw, config));
    const paths = prefixedPaths(prefix(), owns);
    const methods = pathDecoratorMethods(call, shape, hf, pathSpec);
    return {
      routes: paths.flatMap((path) => methods.map((method) => ({ method, path, ...base }))),
      calls: [],
    };
  }

  return { routes: [], calls: [] };
}

/** Back-compat shim for the original routes-only entry point (tests + any
 *  external caller): the route half of {@link extractDecoratorFlow}. */
export function extractDecoratorRoutes(
  decorator: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  file: string,
  line: number,
  config?: NormalizeConfig,
): RouteEndpoint[] {
  return extractDecoratorFlow(decorator, shape, hf, file, line, config).routes;
}
