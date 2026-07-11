/**
 * Builder-chain client recognition — the engine half of the SDK 0.2.0
 * `clientBuilderChains` descriptor: clients whose VERB and URL live on
 * DIFFERENT calls of one method chain.
 *
 *   webClient.get().uri("/x").retrieve()                      (Spring WebClient)
 *   HttpRequest.newBuilder().uri(URI.create("/x")).GET()      (java.net.http)
 *   new Request.Builder().url("…").get().build()              (OkHttp)
 *
 * The match anchors on the URL-bearing call (a member call named in
 * `urlCallees` whose argument is a string literal, possibly wrapped in an
 * `unwrapArgCallees` call like `URI.create(...)`), then scans the chain BOTH
 * ways for the verb — down the receiver links (verb before URL: WebClient)
 * and up the ancestor links (verb after URL: java.net.http, OkHttp). A chain
 * with a verb but a runtime-built URL is reported as a DYNAMIC call site
 * (coverage honesty); a URL-named call with no verb anywhere in its chain is
 * not HTTP evidence and stays silent. Grammar access goes through the shape
 * (`receiverNode` links the chain); pure over its inputs.
 */

import type { GrammarShape, ResolvedCall } from '../../ast/grammar-shape';
import type { Node } from '../../ast/parse';
import type { HttpFlowSupport } from '../../languages/types';
import { normalizeMethod, normalizePath, type HttpMethod, type NormalizeConfig } from './normalize';

type ChainSpec = NonNullable<HttpFlowSupport['clientBuilderChains']>[number];

/** How many chain links each direction inspects — real builder chains are
 *  3-6 calls; the bound keeps a degenerate tree cheap. */
const MAX_CHAIN_HOPS = 12;

export interface ChainMatch {
  readonly kind: 'call' | 'dynamic';
  readonly method: HttpMethod;
  readonly rawUrl: string | null;
  readonly path: string | null;
  readonly receiver: string;
}

/** Strip surrounding quotes/backticks off a literal's verbatim text. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && /^['"`]/.test(s) && s.endsWith(s[0])) return s.slice(1, -1);
  return s;
}

/** The URL literal of the anchor call: its first positional string, or the
 *  first positional string of an `unwrapArgCallees` wrapper (`URI.create`). */
function chainUrlRaw(node: Node, spec: ChainSpec, shape: GrammarShape): string | null {
  const arg = shape.firstArg(node);
  if (!arg) return null;
  const direct = shape.stringText(arg);
  if (direct != null) return direct;
  if (shape.callNodes.includes(arg.type)) {
    const inner = shape.resolveCall(arg);
    if (inner && (spec.unwrapArgCallees ?? []).includes(inner.name)) {
      const innerArg = shape.firstArg(arg);
      return innerArg ? shape.stringText(innerArg) : null;
    }
  }
  return null;
}

/** Read a verb off one chain call: its NAME (`get`, `GET`) or — for
 *  `methodArgCallees` (`method("POST")`) — its first string argument. */
function verbOf(
  call: Node,
  callee: ResolvedCall,
  spec: ChainSpec,
  shape: GrammarShape,
  aliases?: Readonly<Record<string, string>>,
): HttpMethod | null {
  if (spec.verbCallees.includes(callee.name)) return normalizeMethod(callee.name, aliases);
  if ((spec.methodArgCallees ?? []).includes(callee.name)) {
    const arg = shape.firstArg(call);
    const raw = arg ? shape.stringText(arg) : null;
    return raw != null ? normalizeMethod(unquote(raw), aliases) : null;
  }
  return null;
}

/** Scan the chain both ways from the URL anchor for a verb-bearing call. */
function findChainVerb(
  anchor: Node,
  spec: ChainSpec,
  shape: GrammarShape,
  aliases?: Readonly<Record<string, string>>,
): HttpMethod | null {
  // DOWN the receiver links — verb BEFORE the URL (webClient.get().uri(…)).
  let cur: Node | null = shape.receiverNode?.(anchor) ?? null;
  for (let hop = 0; cur && hop < MAX_CHAIN_HOPS; hop++) {
    if (!shape.callNodes.includes(cur.type)) break;
    const callee = shape.resolveCall(cur);
    if (callee) {
      const verb = verbOf(cur, callee, spec, shape, aliases);
      if (verb) return verb;
    }
    cur = shape.receiverNode?.(cur) ?? null;
  }
  // UP the ancestor links — verb AFTER the URL (….uri(x).GET(), ….url(x).get()).
  // Ancestors interpose wrapper nodes (member/navigation expressions), so the
  // walk hops raw parents and inspects the call nodes it passes.
  let up: Node | null = anchor.parent;
  for (let hop = 0; up && hop < MAX_CHAIN_HOPS * 2; hop++, up = up.parent) {
    if (!shape.callNodes.includes(up.type)) continue;
    const callee = shape.resolveCall(up);
    if (callee) {
      const verb = verbOf(up, callee, spec, shape, aliases);
      if (verb) return verb;
    }
  }
  return null;
}

/**
 * Match one member call against the pack's builder-chain specs. Returns a
 * concrete call, a dynamic site (verb found, URL runtime-built), or null
 * (not chain evidence — the caller falls through to the other client forms).
 */
export function matchChainCall(
  node: Node,
  callee: ResolvedCall,
  hf: HttpFlowSupport,
  shape: GrammarShape,
  config?: NormalizeConfig,
): ChainMatch | null {
  const chains = hf.clientBuilderChains ?? [];
  if (chains.length === 0 || !shape.receiverNode) return null;
  const receiver = callee.receiver.split(/[.([]/, 1)[0].trim() || callee.name;

  for (const spec of chains) {
    if (!spec.urlCallees.includes(callee.name)) continue;
    const verb = findChainVerb(node, spec, shape, hf.methodAliases);
    if (!verb) continue;
    const rawUrl = chainUrlRaw(node, spec, shape);
    if (rawUrl != null) {
      return { kind: 'call', method: verb, rawUrl, path: normalizePath(rawUrl, config), receiver };
    }
    // Verb-bearing chain with a runtime-built URL — recognized, unverifiable.
    return { kind: 'dynamic', method: verb, rawUrl: null, path: null, receiver };
  }
  return null;
}
