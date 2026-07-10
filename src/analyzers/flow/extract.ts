/**
 * Flow extraction — the AST pass that turns source into the two sides of an
 * HTTP integration: outbound client calls (CONSUMED) and inbound route
 * declarations (SERVED).
 *
 * It is the cross-cutting consumer of three seams and hardcodes none of them:
 *   - the canonical AST layer (`src/ast/`) for parsing — graphify-independent,
 *     and registered as its own concern, never folded into graphify's pass;
 *   - each pack's `httpFlow` descriptor (Rule 6) for WHICH constructs are HTTP
 *     — no `fetch`/`axios`/`@get` literal lives here;
 *   - the shared normalizer for canonical paths + verbs.
 *
 * Every source file is scanned for BOTH surfaces: a backend that serves routes
 * AND calls other services contributes to both lists (the consumer/provider
 * model — a participant is whatever its served/consumed sets make it). Role
 * assignment happens above this module, never inside it.
 *
 * Precision guard (validated): a member call with no declared receiver allowlist
 * (`axios.get`, `requests.get`, `agent.X.del`) only counts as a client call when
 * its first argument is a path-like literal — that filter keeps non-HTTP `.get`/
 * `.delete` (lodash, Maps) out while still catching app-specific wrappers.
 */

import { getLanguage } from '../../languages';
import type { HttpFlowSupport, LanguageId } from '../../languages/types';
import { parseFile, walk, type Node } from '../../ast/parse';
import { normalizeMethod, normalizePath, type HttpMethod, type NormalizeConfig } from './normalize';
import { deriveFileRoutePath, exportedMethodNames } from './file-routes';

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
  readonly method: HttpMethod;
  readonly path: string;
  readonly via: 'decorator' | 'router-call' | 'file-route' | 'spec';
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

const HTTP_VERB_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'del',
  'head',
  'options',
]);

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/** Text of a string/template-string node, else null (a dynamic argument). */
function literalText(node: Node | null): string | null {
  if (!node) return null;
  return node.type === 'string' || node.type === 'template_string' ? node.text : null;
}

/**
 * Does a raw literal look like a URL/path at the source level — i.e. could this
 * `.get(...)`/`.post(...)` plausibly be an HTTP call rather than a Map/cache/
 * lodash accessor? Used only for member calls with NO declared receiver
 * allowlist, where it is the precision guard: a leading `/`, a leading template
 * (`${host}/…`), an explicit scheme, or any embedded `/` qualifies; a bare token
 * like `'config-key'` does not. (Route decorators are exempt — a framework route
 * string is known to be a path even without a leading slash.)
 */
function looksLikeUrlLiteral(raw: string | null): boolean {
  if (raw == null) return false;
  let s = raw.trim();
  if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) s = s.slice(1, -1);
  return s.startsWith('/') || s.startsWith('${') || s.includes('://') || s.includes('/');
}

function firstNamedArg(callOrArgs: Node | null): Node | null {
  const args = callOrArgs?.childForFieldName('arguments') ?? null;
  if (!args) return null;
  for (const c of args.namedChildren) if (c) return c;
  return null;
}

/** Does a member-call receiver match one of the declared bases (e.g. `app`, or
 *  `this.app`)? */
function receiverMatchesBase(receiver: string, bases: readonly string[]): boolean {
  return bases.some((b) => receiver === b || receiver.endsWith(`.${b}`));
}

/** Pull `method: 'X'` out of a fetch options object (2nd arg), default GET. */
function fetchMethod(call: Node, hf: HttpFlowSupport): HttpMethod {
  const args = call.childForFieldName('arguments');
  const opts = args?.namedChildren?.[1] ?? null;
  if (opts && opts.type === 'object') {
    let verb: HttpMethod | null = null;
    walk(opts, (n) => {
      if (verb) return false;
      if (n.type === 'pair') {
        const key = n.childForFieldName('key');
        const val = n.childForFieldName('value');
        const keyName = key ? key.text.replace(/['"`]/g, '') : '';
        if (keyName === 'method') {
          const raw = literalText(val);
          if (raw) verb = normalizeMethod(raw.replace(/['"`]/g, ''), hf.methodAliases);
        }
      }
    });
    if (verb) return verb;
  }
  return 'GET';
}

/**
 * The handler name a route decorator is attached to (best-effort). Decorators
 * are siblings preceding the member in the class body, so the handler is the
 * decorator's next named sibling (skipping any stacked decorators); a nested
 * grammar shape is handled by an ancestor fallback.
 */
function decoratedHandlerName(decorator: Node): string | null {
  let sib: Node | null = decorator.nextNamedSibling;
  while (sib && sib.type === 'decorator') sib = sib.nextNamedSibling;
  const sibName = sib?.childForFieldName('name');
  if (sibName) return sibName.text;
  let cur: Node | null = decorator.parent;
  for (let i = 0; cur && i < 3; i++) {
    if (cur.type === 'method_definition' || cur.type === 'function_declaration') {
      const name = cur.childForFieldName('name');
      if (name) return name.text;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract both HTTP surfaces from one already-parsed tree using a pack's
 * httpFlow descriptor. Pure over its inputs.
 */
export function extractFromTree(
  root: Node,
  hf: HttpFlowSupport,
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
  const routeDecorators = new Set(hf.routeDecorators ?? []);
  const routerMethods = new Set(hf.routeRouterCallees?.methods ?? []);
  const routerBases = hf.routeRouterCallees?.bases ?? [];

  walk(root, (node) => {
    // ── decorator routes: @get('/x') ──
    if (node.type === 'decorator' && routeDecorators.size) {
      const call = node.namedChildren.find((c) => c?.type === 'call_expression') ?? null;
      const callee = call?.childForFieldName('function');
      const name = callee && callee.type === 'identifier' ? callee.text : '';
      if (call && routeDecorators.has(name)) {
        const path = normalizePath(literalText(firstNamedArg(call)), config);
        const method = normalizeMethod(name, hf.methodAliases);
        if (path && method) {
          routes.push({
            method,
            path,
            via: 'decorator',
            handler: decoratedHandlerName(node),
            file,
            line: line(node),
          });
        }
      }
      return; // a decorator's call is bookkeeping, not a client call
    }

    if (node.type !== 'call_expression') return;
    const callee = node.childForFieldName('function');
    if (!callee) return;

    // ── bare client call: fetch(url, opts) ──
    if (callee.type === 'identifier' && clientCallees.has(callee.text)) {
      const raw = literalText(firstNamedArg(node));
      if (raw != null) {
        calls.push({
          method: fetchMethod(node, hf),
          rawUrl: raw,
          path: normalizePath(raw, config),
          receiver: callee.text,
          file,
          line: line(node),
        });
      } else {
        // A known client with a dynamically-built URL — count it (coverage
        // honesty), don't silently drop it.
        dynamicCalls.push({ receiver: callee.text, file, line: line(node) });
      }
      return;
    }

    // ── member call: <recv>.<verb>(url|path, ...) ──
    if (callee.type === 'member_expression') {
      const prop = callee.childForFieldName('property');
      const obj = callee.childForFieldName('object');
      const verb = prop ? prop.text : '';
      const receiver = obj ? obj.text : '';
      if (!HTTP_VERB_METHODS.has(verb)) return;

      // router/app route declaration
      if (routerMethods.has(verb) && receiverMatchesBase(receiver, routerBases)) {
        const path = normalizePath(literalText(firstNamedArg(node)), config);
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

      // client call (bases optional). With no allowlist, require a path-like
      // literal first arg — the precision guard against non-HTTP .get/.delete.
      if (methodCallMethods.has(verb)) {
        const baseOk =
          !methodCallBases ||
          receiverMatchesBase(receiver, methodCallBases) ||
          methodCallBases.includes(receiver);
        if (!baseOk) return;
        const raw = literalText(firstNamedArg(node));
        // Unallowlisted receiver → require a URL-looking literal (precision guard).
        // That rejection is FILTERING (a non-HTTP map.get), not a blind spot,
        // so it is deliberately not counted as dynamic.
        if (!methodCallBases && !looksLikeUrlLiteral(raw)) return;
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
          // An ALLOWLISTED client receiver with a dynamic URL — a call flow
          // recognizes but cannot verify. Counted, not silently dropped.
          dynamicCalls.push({ receiver, file, line: line(node) });
        }
      }
    }
  });

  return { calls, routes, dynamicCalls };
}

/**
 * Extract both HTTP surfaces from one file on disk. Returns empty surfaces when
 * the language has no httpFlow descriptor, and `null` when the file can't be
 * parsed (engine/grammar unavailable or unreadable) — callers treat `null` as
 * "skip this file", never an error.
 */
export async function extractFileFlow(
  filePath: string,
  config?: NormalizeConfig,
  relPath?: string,
): Promise<FileFlow | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  const hf = httpFlowFor(parsed.languageId);
  if (!hf) return { calls: [], routes: [] };
  return extractFromTree(parsed.tree.rootNode, hf, filePath, config, relPath);
}

function httpFlowFor(languageId: LanguageId): HttpFlowSupport | undefined {
  return getLanguage(languageId)?.httpFlow;
}
