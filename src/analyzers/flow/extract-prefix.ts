/**
 * Ancestor route-PREFIX composition — the engine half of two SDK 0.2.0
 * descriptor forms:
 *
 *   - `routePrefixDecorators`: an annotation on an ENCLOSING declaration
 *     prefixes descendant routes (Spring class-level `@RequestMapping`,
 *     JAX-RS class-level `@Path`);
 *   - `routeGroupCallees`: a call whose first string argument prefixes the
 *     routes declared inside its body/lambda (Ktor `route("/api") { … }`).
 *
 * Both are ancestor WALKS over the parsed tree, grammar-agnostic through the
 * shape (Rule 6: WHICH names prefix comes from the pack descriptor; HOW to
 * read an annotation/call comes from the grammar shape; the join semantics
 * live here). Pure over their inputs.
 */

import type { GrammarShape } from '../../ast/grammar-shape';
import type { Node } from '../../ast/parse';
import type { HttpFlowSupport } from '../../languages/types';
import { normalizePath, type NormalizeConfig } from './normalize';

/** How many raw ancestor hops a prefix walk inspects. Generous: lambda and
 *  body nesting interposes several non-declaration nodes per logical level. */
const MAX_ANCESTOR_HOPS = 40;

/**
 * Join two NORMALIZED paths (each `/…`-headed, no trailing slash, or null).
 * Either side may be absent: a Spring `@GetMapping` marker route is its
 * class prefix alone; an unprefixed route is its own path alone.
 */
export function joinNormalizedPaths(prefix: string | null, own: string | null): string | null {
  if (prefix == null) return own;
  if (own == null) return prefix;
  return prefix + own;
}

/** String(s) carried by one argument node: a literal, or every string
 *  element of a list literal (`@GetMapping({"/a", "/b"})`, `path = ["/x"]` —
 *  Spring serves each entry). */
function argStrings(node: Node, shape: GrammarShape): string[] {
  const direct = shape.stringText(node);
  if (direct != null) return [direct];
  return shape.listStrings(node);
}

/**
 * The PATH texts a decorator declares: its first positional argument (string
 * or string list), else the first `decoratorPathKeywords` keyword that holds
 * one (`@RequestMapping(value = "/x")`). Multiple entries mean the handler
 * serves every one of them.
 */
export function decoratorPathsRaw(call: Node, shape: GrammarShape, hf: HttpFlowSupport): string[] {
  const first = shape.firstArg(call);
  if (first) {
    const strings = argStrings(first, shape);
    if (strings.length > 0) return strings;
  }
  for (const kw of hf.decoratorPathKeywords ?? []) {
    const v = shape.optionValue(call, kw);
    if (v) {
      const strings = argStrings(v, shape);
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

/** The single-path view of {@link decoratorPathsRaw} — prefix composition
 *  and pair siblings take the first declared path (a multi-path PREFIX is
 *  ambiguous; the first entry is the dominant convention). */
export function decoratorPathRaw(
  call: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
): string | null {
  return decoratorPathsRaw(call, shape, hf)[0] ?? null;
}

/** The declared NAME of the function/method enclosing `node` (nearest
 *  `functionNodes` ancestor), read through the grammar's `name` field with
 *  the field-less-grammar accessor as fallback. Null outside any. */
function enclosingFunctionName(node: Node, shape: GrammarShape): string | null {
  let cur: Node | null = node.parent;
  for (let hop = 0; cur && hop < MAX_ANCESTOR_HOPS; hop++, cur = cur.parent) {
    if (!shape.functionNodes.includes(cur.type)) continue;
    return cur.childForFieldName('name')?.text ?? shape.functionName?.(cur) ?? null;
  }
  return null;
}

/**
 * Substitute declared `routeTemplateTokens` in a raw decorator path —
 * ASP.NET's `[Route("[controller]/[action]")]`, where `[controller]` is the
 * enclosing class name minus its suffix and `[action]` the handler method's
 * name. Runs BEFORE `normalizePath` (whose `[…]` param rule would otherwise
 * silently turn a token into an over-matching `{var}`). `typeAnchor` is the
 * node whose enclosing TYPE answers type-sourced tokens (the decorator
 * carrying the path — for a class-level prefix, the class's own attribute);
 * `functionAnchor` answers function-sourced tokens and is always the ROUTE
 * decorator (so a class-level prefix containing `[action]` resolves to each
 * handler's own name). When a source cannot be resolved the path is DROPPED
 * (null) rather than emitted with a placeholder — a wrong prefix corrupts
 * every route under it. A raw path without any declared token passes
 * through untouched.
 */
export function resolveRouteTokens(
  raw: string | null,
  typeAnchor: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  functionAnchor?: Node,
): string | null {
  if (raw == null) return null;
  const specs = hf.routeTemplateTokens;
  if (!specs || specs.length === 0) return raw;
  let s = raw;
  for (const spec of specs) {
    if (!s.includes(spec.token)) continue;
    const name =
      spec.from === 'enclosingFunction'
        ? enclosingFunctionName(functionAnchor ?? typeAnchor, shape)
        : (shape.enclosingTypeName?.(typeAnchor) ?? null);
    if (name === null) return null;
    let sub = name;
    if (
      spec.stripSuffix !== undefined &&
      sub.endsWith(spec.stripSuffix) &&
      sub.length > spec.stripSuffix.length
    ) {
      sub = sub.slice(0, -spec.stripSuffix.length);
    }
    if (spec.lowercase === true) sub = sub.toLowerCase();
    s = s.split(spec.token).join(sub);
  }
  return s;
}

/**
 * Is `node` (transitively) inside a call to one of `names`? The precision
 * qualifier behind `routeVerbCallees.ancestorCallees` /
 * `routeResourceCallees.ancestorCallees` — Rails' routes.rb always sits
 * inside `routes.draw do … end`, while a request spec's bare `get '/x'`
 * does not. Ancestors link the same way the group-prefix walk does
 * (trailing-lambda outer nodes resolve through `calleeCall`).
 */
export function hasAncestorCallee(
  node: Node,
  names: readonly string[],
  shape: GrammarShape,
): boolean {
  const nameSet = new Set(names);
  let cur: Node | null = node.parent;
  for (let hop = 0; cur && hop < MAX_ANCESTOR_HOPS; hop++, cur = cur.parent) {
    if (!shape.callNodes.includes(cur.type)) continue;
    const inner = shape.calleeCall?.(cur) ?? cur;
    if (inner.id === node.id) continue;
    const callee = shape.resolveCall(inner);
    if (callee && nameSet.has(callee.name)) return true;
  }
  return false;
}

/** Decorator nodes attached to an ancestor DECLARATION node — its decorator-
 *  typed children plus those one container level down (Java/Kotlin wrap
 *  annotations in a `modifiers` child). Depth-limited to 2 so a sibling
 *  handler's own annotations (body → method → modifiers → …) never leak in. */
function shallowDecorators(node: Node, shape: GrammarShape): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (shape.decoratorNodes.includes(c.type)) out.push(c);
    else {
      for (const cc of c.namedChildren) {
        if (cc && shape.decoratorNodes.includes(cc.type)) out.push(cc);
      }
    }
  }
  return out;
}

/**
 * The combined NORMALIZED prefix the ancestor DECLARATIONS of a route
 * decorator contribute, outermost first — or null when none. The walk starts
 * ABOVE the handler's own declaration (the first `functionNodes` ancestor),
 * so an annotation on the handler itself (a method-level JAX-RS `@Path`,
 * which is the route's OWN path) is never read as its own prefix.
 */
export function collectDecoratorPrefix(
  decorator: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  config?: NormalizeConfig,
): string | null {
  const spec = hf.routePrefixDecorators;
  if (!spec || spec.names.length === 0) return null;
  const names = new Set(spec.names);

  const parts: string[] = [];
  let passedHandler = false;
  let cur: Node | null = decorator.parent;
  for (let hop = 0; cur && hop < MAX_ANCESTOR_HOPS; hop++, cur = cur.parent) {
    if (!passedHandler) {
      if (shape.functionNodes.includes(cur.type)) passedHandler = true;
      continue;
    }
    for (const d of shallowDecorators(cur, shape)) {
      const call = shape.decoratorCall(d);
      const callee = call ? shape.resolveCall(call) : null;
      if (!call || !callee || !names.has(callee.name)) continue;
      // Type tokens anchor on the PREFIX's own attribute (its enclosing
      // class); function tokens anchor on the ROUTE decorator, so a
      // class-level "[controller]/[action]" prefix yields each handler's
      // own path.
      const raw = resolveRouteTokens(decoratorPathRaw(call, shape, hf), d, shape, hf, decorator);
      const norm = normalizePath(raw, config);
      if (norm) parts.unshift(norm); // climbing inner→outer; outermost first
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * The combined NORMALIZED prefix the ancestor GROUP CALLS of a call-declared
 * route contribute (Ktor `route("/api") { route("/v1") { get("/x") { } } }`
 * → `/api/v1`), outermost first — or null when none. Ancestors are linked
 * through the shape's `calleeCall` (a trailing-lambda outer node's callee is
 * the group call itself).
 */
export function collectGroupPrefix(
  routeCall: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  config?: NormalizeConfig,
): string | null {
  const spec = hf.routeGroupCallees;
  if (!spec || spec.names.length === 0 || !shape.calleeCall) return null;
  const names = new Set(spec.names);

  const parts: string[] = [];
  let cur: Node | null = routeCall.parent;
  for (let hop = 0; cur && hop < MAX_ANCESTOR_HOPS; hop++, cur = cur.parent) {
    if (!shape.callNodes.includes(cur.type)) continue;
    // The group call is the trailing-lambda OUTER node's callee; a direct
    // resolve also counts for grammars whose group call carries its own body.
    const inner = shape.calleeCall(cur) ?? cur;
    if (inner.id === routeCall.id) continue;
    const callee = shape.resolveCall(inner);
    if (!callee || !names.has(callee.name)) continue;
    // A chain-link sibling is NOT nested: in axum's
    // `Router::new().route("/items", …).nest("/api", …)` the earlier .route
    // call sits inside .nest's RECEIVER subtree — group membership requires
    // living on the group call's ARGUMENT/body side, so a route reached
    // through the receiver is skipped.
    const recv = shape.receiverNode?.(inner);
    if (recv && recv.startIndex <= routeCall.startIndex && routeCall.endIndex <= recv.endIndex) {
      continue;
    }
    const first = shape.firstArg(inner);
    const norm = normalizePath(first ? shape.stringText(first) : null, config);
    if (norm) parts.unshift(norm);
  }
  return parts.length > 0 ? parts.join('') : null;
}
