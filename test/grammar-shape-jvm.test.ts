/**
 * Java + Kotlin grammar-shape rows, verified against the bundled wasms.
 *
 * Java pins the FUSED-CALLEE factory (`method_invocation` carries
 * object/name/arguments on the call node; an annotation IS the invocation).
 * Kotlin pins the hand-written row for a ZERO-FIELD grammar (the bundled
 * kotlin wasm defines no grammar fields — every read navigates by child node
 * type/position). The descriptor-driven ENGINE forms these rows feed
 * (prefix/group/pair/chain extraction) are pinned in the flow-extract tests;
 * this file pins the syntax ACCESS layer.
 */

import { describe, it, expect } from 'vitest';
import { parseSource, walk, type Node } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree } from '../src/analyzers/flow/extract';
import type { HttpFlowSupport } from '../src/languages/types';

const java = grammarShape('java')!;
const kotlin = grammarShape('kotlin')!;

async function firstNode(
  src: string,
  grammar: string,
  type: string,
  where?: (n: Node) => boolean,
): Promise<Node | null> {
  const tree = await parseSource(src, grammar);
  let found: Node | null = null;
  walk(tree!.rootNode, (n) => {
    if (!found && n.type === type && (where === undefined || where(n))) found = n;
    return undefined;
  });
  return found;
}

describe('java grammar shape (fused-callee factory)', () => {
  it('registry has rows for java and kotlin', () => {
    expect(java).not.toBeNull();
    expect(kotlin).not.toBeNull();
  });

  it('resolves member and bare method invocations', async () => {
    const src = `class C { void f() { restTemplate.getForObject("/api/x", X.class); doIt(); } }`;
    const member = await firstNode(src, 'java', 'method_invocation', (n) =>
      n.text.startsWith('restTemplate'),
    );
    expect(java.resolveCall(member!)).toEqual({
      kind: 'member',
      name: 'getForObject',
      receiver: 'restTemplate',
    });
    const bare = await firstNode(src, 'java', 'method_invocation', (n) => n.text === 'doIt()');
    expect(java.resolveCall(bare!)).toEqual({ kind: 'bare', name: 'doIt', receiver: '' });
  });

  it('an annotation IS the invocation: decoratorCall returns the node, resolveCall names it', async () => {
    const src = `class C { @GetMapping("/users/{id}") User get(@PathVariable long id) { return null; } }`;
    const ann = await firstNode(src, 'java', 'annotation');
    expect(ann).not.toBeNull();
    expect(java.decoratorCall(ann!)).toBe(ann);
    expect(java.resolveCall(ann!)).toEqual({ kind: 'bare', name: 'GetMapping', receiver: '' });
    const first = java.firstArg(ann!);
    expect(java.stringText(first!)).toBe('"/users/{id}"');
  });

  it('a marker annotation resolves with no arguments (the split-pair form)', async () => {
    const src = `class C { @GET public String all() { return ""; } }`;
    const marker = await firstNode(src, 'java', 'marker_annotation');
    expect(java.resolveCall(marker!)).toEqual({ kind: 'bare', name: 'GET', receiver: '' });
    expect(java.firstArg(marker!)).toBeNull();
  });

  it('a scoped annotation name contributes its trailing segment', async () => {
    const src = `class C { @retrofit2.http.GET("users/{id}") String go() { return ""; } }`;
    const ann = await firstNode(src, 'java', 'annotation');
    expect(java.resolveCall(ann!)?.name).toBe('GET');
  });

  it('annotation keyword arguments read via optionValue; enum arrays via listStrings', async () => {
    const src = `class C {
      @RequestMapping(value = "/x", method = {RequestMethod.GET, RequestMethod.POST})
      String go() { return ""; }
    }`;
    const ann = await firstNode(src, 'java', 'annotation');
    const value = java.optionValue(ann!, 'value');
    expect(java.stringText(value!)).toBe('"/x"');
    const methods = java.optionValue(ann!, 'method');
    expect(java.listStrings(methods!)).toEqual(['GET', 'POST']);
    // Keyword args are not positional: no positional path on this annotation.
    expect(java.firstArg(ann!)).toBeNull();
  });

  it('receiverNode walks builder chains (webClient.get().uri(...))', async () => {
    const src = `class C { void f() { webClient.get().uri("/api/items").retrieve(); } }`;
    const uriCall = await firstNode(
      src,
      'java',
      'method_invocation',
      (n) => java.resolveCall(n)?.name === 'uri',
    );
    const recv = java.receiverNode!(uriCall!);
    expect(recv?.type).toBe('method_invocation');
    expect(java.resolveCall(recv!)?.name).toBe('get');
  });

  it('drives the existing member-call engine end-to-end (RestTemplate)', async () => {
    const hf: HttpFlowSupport = {
      clientMethodCallees: { methods: ['getForObject', 'postForObject'], bases: ['restTemplate'] },
      methodAliases: { getforobject: 'GET', postforobject: 'POST' },
    };
    const tree = await parseSource(
      `class C { void f() { restTemplate.getForObject("/api/things/{id}", T.class, id); } }`,
      'java',
    );
    const flow = extractFromTree(tree!.rootNode, hf, java, 'C.java');
    expect(flow.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/things/{var}']);
  });
});

describe('kotlin grammar shape (zero-field grammar, hand-written row)', () => {
  it('resolves member calls and reads string templates', async () => {
    const src = `fun f(client: HttpClient, id: Int) { client.get("/users/$id") }`;
    const call = await firstNode(
      src,
      'kotlin',
      'call_expression',
      (n) => kotlin.resolveCall(n)?.kind === 'member',
    );
    expect(kotlin.resolveCall(call!)).toEqual({ kind: 'member', name: 'get', receiver: 'client' });
    expect(kotlin.stringText(kotlin.firstArg(call!)!)).toBe('"/users/$id"');
  });

  it('the trailing-lambda outer node resolves null; the inner call resolves and sees the lambda', async () => {
    const src = `fun Route.api() { get("/items") { call.respond(items) } }`;
    const inner = await firstNode(
      src,
      'kotlin',
      'call_expression',
      (n) => kotlin.resolveCall(n)?.name === 'get',
    );
    expect(kotlin.resolveCall(inner!)).toEqual({ kind: 'bare', name: 'get', receiver: '' });
    expect(kotlin.hasTrailingLambda!(inner!)).toBe(true);
    // The OUTER node (callee = the inner call) has no callee form of its own,
    // and calleeCall links it to the inner call for ancestor walks.
    const outer = inner!.parent!;
    expect(outer.type).toBe('call_expression');
    expect(kotlin.resolveCall(outer)).toBeNull();
    expect(kotlin.calleeCall!(outer)?.id).toBe(inner!.id);
  });

  it('a plain call without a lambda reports hasTrailingLambda false', async () => {
    const src = `fun f() { get("/items") }`;
    const call = await firstNode(
      src,
      'kotlin',
      'call_expression',
      (n) => kotlin.resolveCall(n)?.name === 'get',
    );
    expect(kotlin.hasTrailingLambda!(call!)).toBe(false);
  });

  it('named arguments split from positional; optionValue reads them', async () => {
    const src = `fun f() { route(path = "/api", name = "api") { } }`;
    const call = await firstNode(
      src,
      'kotlin',
      'call_expression',
      (n) => kotlin.resolveCall(n)?.name === 'route',
    );
    expect(kotlin.firstArg(call!)).toBeNull(); // both args are named
    expect(kotlin.stringText(kotlin.optionValue(call!, 'path')!)).toBe('"/api"');
  });

  it('called annotations round-trip through decoratorCall/resolveCall/firstArg', async () => {
    const src = `class C { @GetMapping("/users/{id}") fun get(id: Long): User? = null }`;
    const ann = await firstNode(src, 'kotlin', 'annotation');
    const call = kotlin.decoratorCall(ann!);
    expect(call?.type).toBe('constructor_invocation');
    expect(kotlin.resolveCall(call!)).toEqual({ kind: 'bare', name: 'GetMapping', receiver: '' });
    expect(kotlin.stringText(kotlin.firstArg(call!)!)).toBe('"/users/{id}"');
  });

  it('marker annotations resolve too (@Serializable), including use-site targets', async () => {
    const src = `@Serializable data class User(@field:Column val name: String?)`;
    const classAnn = await firstNode(src, 'kotlin', 'annotation');
    const marker = kotlin.decoratorCall(classAnn!);
    expect(kotlin.resolveCall(marker!)?.name).toBe('Serializable');
    const fieldAnn = await firstNode(src, 'kotlin', 'annotation', (n) => n.text.includes('field:'));
    expect(kotlin.resolveCall(kotlin.decoratorCall(fieldAnn!)!)?.name).toBe('Column');
  });

  it('collection literals contribute strings verbatim and enum-ref tails', async () => {
    const src = `class C { @RequestMapping(value = ["/x"], method = [RequestMethod.GET]) fun go() {} }`;
    const ann = await firstNode(src, 'kotlin', 'annotation');
    const call = kotlin.decoratorCall(ann!)!;
    expect(kotlin.listStrings(kotlin.optionValue(call, 'value')!)).toEqual(['"/x"']);
    expect(kotlin.listStrings(kotlin.optionValue(call, 'method')!)).toEqual(['GET']);
  });

  it('receiverNode returns the receiver expression (chains included)', async () => {
    const src = `fun f() { webClient.get().uri("/x") }`;
    const uri = await firstNode(
      src,
      'kotlin',
      'call_expression',
      (n) => kotlin.resolveCall(n)?.name === 'uri',
    );
    const recv = kotlin.receiverNode!(uri!);
    expect(recv?.type).toBe('call_expression');
    expect(kotlin.resolveCall(recv!)?.name).toBe('get');
  });

  it('drives the existing member-call engine end-to-end (Ktor client + $id template)', async () => {
    const hf: HttpFlowSupport = {
      clientMethodCallees: { methods: ['get', 'post'], bases: ['client', 'httpClient'] },
    };
    const tree = await parseSource(
      `suspend fun f(client: HttpClient, id: Int) {
         client.get("/users/$id")
         client.post("/users") { setBody(u) }
       }`,
      'kotlin',
    );
    const flow = extractFromTree(tree!.rootNode, hf, kotlin, 'a.kt');
    const keys = flow.calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toEqual(['GET /users/{var}', 'POST /users']);
  });
});
