/**
 * Decorator-route recognition — the three decorator-declared route forms,
 * split from `extract.ts` as one cohesive sub-concern (each form is a
 * decorator node carrying an invocation that declares a route):
 *
 *   - BARE verb decorators        `@get('/x')`                (LoopBack/NestJS)
 *   - MEMBER verb decorators      `@app.get('/x')`            (FastAPI/Sanic)
 *   - PATH decorators + methods   `@app.route('/x', methods=['GET','POST'])`
 *                                                             (Flask)
 *
 * Grammar access goes through the shape (Rule 6 stays intact: WHICH decorator
 * names are routes comes from the pack's descriptor; HOW to read a decorator
 * node comes from the grammar shape; the route SEMANTICS live here). Pure
 * over its inputs — `extract.ts` calls this once per decorator node during
 * its walk and owns everything else.
 */

import type { GrammarShape } from '../../ast/grammar-shape';
import type { Node } from '../../ast/parse';
import type { HttpFlowSupport } from '../../languages/types';
import { normalizeMethod, normalizePath, type HttpMethod, type NormalizeConfig } from './normalize';
import type { RouteEndpoint } from './extract';

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
      const name = cur.childForFieldName('name');
      if (name) return name.text;
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
 * The route path of a member/path decorator — its first string argument,
 * REQUIRED to begin with `/` once unquoted. FastAPI/Flask/Sanic mandate the
 * leading slash, and requiring it is the precision guard that keeps look-alike
 * member decorators (`@mock.patch('pkg.attr')`) from minting phantom routes.
 * (Bare `routeDecorators` keep their historical exemption — LoopBack allows
 * `@post('zen/x')`.)
 */
function slashedDecoratorPath(
  call: Node,
  shape: GrammarShape,
  config?: NormalizeConfig,
): string | null {
  const first = shape.firstArg(call);
  const raw = first ? shape.stringText(first) : null;
  if (raw == null) return null;
  let s = raw.trim();
  if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) s = s.slice(1, -1);
  if (!s.startsWith('/')) return null;
  return normalizePath(raw, config);
}

/** The declared methods of a path-first decorator (`methods=['GET','POST']`),
 *  read from its keyword argument; absent → the descriptor's defaults. */
function pathDecoratorMethods(
  call: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  spec: NonNullable<HttpFlowSupport['routePathDecorators']>,
): HttpMethod[] {
  const value = shape.optionValue(call, spec.methodsKeyword);
  const tokens = value ? shape.listStrings(value).map((s) => s.replace(/['"`]/g, '')) : [];
  const source = tokens.length > 0 ? tokens : spec.defaultMethods;
  return source
    .map((t) => normalizeMethod(t, hf.methodAliases))
    .filter((m): m is HttpMethod => m !== null);
}

/**
 * The routes one decorator node declares (usually 0 or 1; a Flask
 * `methods=['GET','POST']` yields one per verb). The caller skips the
 * decorator's subtree afterwards — its inner call is a route declaration,
 * never a client call.
 */
export function extractDecoratorRoutes(
  decorator: Node,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  file: string,
  line: number,
  config?: NormalizeConfig,
): RouteEndpoint[] {
  const call = shape.decoratorCall(decorator);
  const callee = call ? shape.resolveCall(call) : null;
  if (!call || !callee) return [];

  const base = {
    via: 'decorator' as const,
    handler: decoratedHandlerName(decorator, shape),
    file,
    line,
  };

  // BARE verb decorator: @get('/x').
  if (callee.kind === 'bare' && (hf.routeDecorators ?? []).includes(callee.name)) {
    const first = shape.firstArg(call);
    const path = normalizePath(first ? shape.stringText(first) : null, config);
    const method = normalizeMethod(callee.name, hf.methodAliases);
    return path && method ? [{ method, path, ...base }] : [];
  }

  // MEMBER verb decorator: FastAPI @app.get('/x').
  const member = hf.routeMemberDecorators;
  if (
    callee.kind === 'member' &&
    member &&
    member.methods.includes(callee.name) &&
    (member.bases === undefined || receiverMatchesBase(callee.receiver, member.bases))
  ) {
    const path = slashedDecoratorPath(call, shape, config);
    const method = normalizeMethod(callee.name, hf.methodAliases);
    return path && method ? [{ method, path, ...base }] : [];
  }

  // PATH-first decorator with a methods keyword: Flask @app.route(...).
  const pathSpec = hf.routePathDecorators;
  if (pathSpec && pathSpec.names.includes(callee.name)) {
    const path = slashedDecoratorPath(call, shape, config);
    if (!path) return [];
    return pathDecoratorMethods(call, shape, hf, pathSpec).map((method) => ({
      method,
      path,
      ...base,
    }));
  }

  return [];
}
