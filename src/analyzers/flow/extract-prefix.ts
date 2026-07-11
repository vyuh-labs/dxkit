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

/**
 * The PATH text a prefix-bearing decorator/call declares: its first
 * positional string argument, else the first `decoratorPathKeywords` keyword
 * that holds a string (`@RequestMapping(value = "/x")`).
 */
export function decoratorPathRaw(
  call: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
): string | null {
  const first = shape.firstArg(call);
  const raw = first ? shape.stringText(first) : null;
  if (raw != null) return raw;
  for (const kw of hf.decoratorPathKeywords ?? []) {
    const v = shape.optionValue(call, kw);
    const text = v ? shape.stringText(v) : null;
    if (text != null) return text;
  }
  return null;
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
      const norm = normalizePath(decoratorPathRaw(call, shape, hf), config);
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
    const first = shape.firstArg(inner);
    const norm = normalizePath(first ? shape.stringText(first) : null, config);
    if (norm) parts.unshift(norm);
  }
  return parts.length > 0 ? parts.join('') : null;
}
