/**
 * Verb-named route callees + the resource expansion — the engine half of
 * `routeVerbCallees` / `routeResourceCallees`, split from `extract.ts` as
 * one cohesive sub-concern (Ktor/Sinatra/Rails verb calls and the Rails
 * RESTful expansion table). The qualifier-set semantics that keep
 * non-routing look-alikes out (a request spec's bare `get '/x'`) live here;
 * `extract.ts` owns the walk and calls in.
 */

import type { GrammarShape, ResolvedCall } from '../../ast/grammar-shape';
import type { Node } from '../../ast/parse';
import type { HttpFlowSupport } from '../../languages/types';
import {
  ANY_METHOD,
  normalizeMethod,
  normalizePath,
  type NormalizeConfig,
  type ServedMethod,
} from './normalize';
import { collectGroupPrefix, hasAncestorCallee, joinNormalizedPaths } from './extract-prefix';
import type { RouteEndpoint } from './extract';

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/** Strip surrounding quotes/backticks off a literal's verbatim text. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) return s.slice(1, -1);
  return s;
}

type VerbCalleeSpec = NonNullable<HttpFlowSupport['routeVerbCallees']>;

/**
 * Does a verb-named route call pass its declared QUALIFIER SET? When one or
 * more qualifiers are declared, at least one must hold — that is what keeps
 * a bare `get '/x'` in a request spec (no handler block, no `to:`, not
 * inside `draw`) from minting a route while Sinatra blocks, Rails `to:`
 * bindings, and routes.rb ancestry all qualify. No declared qualifier →
 * qualified (the slash-literal guard alone, the pre-3.6 behavior).
 */
function verbCalleeQualifies(call: Node, shape: GrammarShape, spec: VerbCalleeSpec): boolean {
  const lambdaDeclared = spec.requireTrailingLambda === true;
  const keywordsDeclared = (spec.handlerKeywords?.length ?? 0) > 0;
  const ancestorsDeclared = (spec.ancestorCallees?.length ?? 0) > 0;
  if (!lambdaDeclared && !keywordsDeclared && !ancestorsDeclared) return true;
  if (lambdaDeclared && shape.hasTrailingLambda !== undefined && shape.hasTrailingLambda(call)) {
    return true;
  }
  if (
    keywordsDeclared &&
    spec.handlerKeywords!.some((kw) => shape.optionValue(call, kw) !== null)
  ) {
    return true;
  }
  if (ancestorsDeclared && hasAncestorCallee(call, spec.ancestorCallees!, shape)) return true;
  return false;
}

/**
 * The served methods a verb-named route call declares: the callee's own name
 * when it IS a verb (`get`), else the explicit `methodsKeyword` list
 * (Rails' `match '/x', via: [:get, :post]`), where the token `all` reads as
 * the method-agnostic ANY. A non-verb callee with no readable keyword verbs
 * declares nothing.
 */
function verbCalleeMethods(
  call: Node,
  calleeName: string,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  spec: VerbCalleeSpec,
): ServedMethod[] {
  const own = normalizeMethod(calleeName, hf.methodAliases);
  if (own) return [own];
  if (spec.methodsKeyword === undefined) return [];
  const value = shape.optionValue(call, spec.methodsKeyword);
  if (!value) return [];
  let tokens = shape.listStrings(value).map((s) => s.replace(/['"`]/g, ''));
  if (tokens.length === 0) {
    const single = shape.stringText(value);
    if (single != null) tokens = [single.replace(/['"`]/g, '')];
  }
  return tokens
    .map((t) => (t.toLowerCase() === 'all' ? ANY_METHOD : normalizeMethod(t, hf.methodAliases)))
    .filter((m): m is ServedMethod => m !== null);
}

/** One RESTful action of the framework resource-expansion contract. The
 *  suffix joins the resource base (`/articles`); singular resources
 *  (`resource :profile`) have no index and no `/{var}` id segment. */
const RESOURCE_ACTIONS: ReadonlyArray<{
  action: string;
  method: ServedMethod;
  plural: string;
  singular: string | null;
}> = [
  { action: 'index', method: 'GET', plural: '', singular: null },
  { action: 'create', method: 'POST', plural: '', singular: '' },
  { action: 'new', method: 'GET', plural: '/new', singular: '/new' },
  { action: 'edit', method: 'GET', plural: '/{var}/edit', singular: '/edit' },
  { action: 'show', method: 'GET', plural: '/{var}', singular: '' },
  { action: 'update', method: 'PATCH', plural: '/{var}', singular: '' },
  { action: 'update', method: 'PUT', plural: '/{var}', singular: '' },
  { action: 'destroy', method: 'DELETE', plural: '/{var}', singular: '' },
];

/** The `only:` / `except:`-filtered expansion rows of one resource call. */
function resourceActions(
  call: Node,
  shape: GrammarShape,
  singular: boolean,
): Array<{ method: ServedMethod; suffix: string }> {
  const readList = (kw: string): Set<string> | null => {
    const v = shape.optionValue(call, kw);
    if (!v) return null;
    let tokens = shape.listStrings(v).map((s) => s.replace(/['"`]/g, ''));
    if (tokens.length === 0) {
      const single = shape.stringText(v);
      if (single != null) tokens = [single.replace(/['"`]/g, '')];
    }
    return new Set(tokens);
  };
  const only = readList('only');
  const except = readList('except');
  return RESOURCE_ACTIONS.filter((a) => {
    if (singular && a.singular === null) return false;
    if (only && !only.has(a.action)) return false;
    if (except !== null && except.has(a.action)) return false;
    return true;
  }).map((a) => ({ method: a.method, suffix: singular ? a.singular! : a.plural }));
}

/**
 * The routes a bare VERB-named callee declares (Ktor `get("/x") { … }`,
 * Sinatra `get '/x' do`, Rails `get '/x', to: '…'`), or null when this call
 * is NOT a route declaration — a matched verb callee without a slashed
 * literal / qualifier falls through to the client branches (`get(...)` may
 * still be a declared client callee), which is why null and the empty array
 * are different answers here.
 */
export function verbCalleeRoutes(
  node: Node,
  callee: ResolvedCall,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  file: string,
  config?: NormalizeConfig,
): RouteEndpoint[] | null {
  const spec = hf.routeVerbCallees;
  if (!spec || callee.kind !== 'bare' || !spec.methods.includes(callee.name)) return null;
  const first = shape.firstArg(node);
  const raw = first ? shape.stringText(first) : null;
  if (raw == null || !unquote(raw).startsWith('/') || !verbCalleeQualifies(node, shape, spec)) {
    return null;
  }
  const own = normalizePath(raw, config);
  const path = joinNormalizedPaths(collectGroupPrefix(node, shape, hf, config), own);
  const methods = verbCalleeMethods(node, callee.name, shape, hf, spec);
  if (!path || methods.length === 0) return null;
  return methods.map((method) => ({
    method,
    path,
    via: 'router-call' as const,
    handler: null,
    file,
    line: line(node),
  }));
}

/**
 * The routes a RESOURCE-expansion callee declares (Rails
 * `resources :articles` / `resource :profile` — one call expands to the
 * framework's fixed RESTful set, filtered by only:/except:), or null when
 * this call is not a qualifying resource declaration. A recognized resource
 * inside another resource's block returns the EMPTY array (handled, mints
 * nothing): its paths would need the parent's id segment, and a wrong path
 * is worse than a missing one — disclosed in docs.
 */
export function resourceRoutes(
  node: Node,
  callee: ResolvedCall,
  shape: GrammarShape,
  hf: HttpFlowSupport,
  file: string,
  config?: NormalizeConfig,
): RouteEndpoint[] | null {
  const spec = hf.routeResourceCallees;
  if (!spec || callee.kind !== 'bare') return null;
  const singularNames = spec.singularNames ?? [];
  const isPlural = spec.names.includes(callee.name);
  const isSingular = singularNames.includes(callee.name);
  if (!isPlural && !isSingular) return null;

  const first = shape.firstArg(node);
  const raw = first ? shape.stringText(first) : null;
  const nameToken = raw == null ? null : unquote(raw);
  const guardOk =
    (spec.ancestorCallees?.length ?? 0) === 0 ||
    hasAncestorCallee(node, spec.ancestorCallees!, shape);
  if (!nameToken || nameToken.length === 0 || nameToken.includes('/') || !guardOk) return null;

  if (hasAncestorCallee(node, [...spec.names, ...singularNames], shape)) return [];
  const base = normalizePath('/' + nameToken, config);
  if (!base) return [];
  const prefix = collectGroupPrefix(node, shape, hf, config);
  const out: RouteEndpoint[] = [];
  for (const { method, suffix } of resourceActions(node, shape, isSingular)) {
    const path = joinNormalizedPaths(prefix, base + suffix);
    if (path) {
      out.push({ method, path, via: 'router-call', handler: null, file, line: line(node) });
    }
  }
  return out;
}
