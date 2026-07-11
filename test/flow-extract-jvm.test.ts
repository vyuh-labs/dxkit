/**
 * The java + kotlin packs' httpFlow declarations, pinned over the real
 * grammars — the JVM analog of `flow-extract-go.test.ts`. The ADAPTER and
 * the descriptor FORMS have their own tests (`grammar-shape-jvm`,
 * `flow-extract-jvm-forms`); this file pins what the PACKS declare:
 * Spring/JAX-RS/Retrofit/RestTemplate/chains on java, Ktor/Spring/client on
 * kotlin, with their precision choices.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const javaFlow = getLanguage('java')!.httpFlow as HttpFlowSupport;
const kotlinFlow = getLanguage('kotlin')!.httpFlow as HttpFlowSupport;

async function extractJava(src: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'java');
  return extractFromTree(tree!.rootNode, javaFlow, grammarShape('java')!, 's.java');
}
async function extractKotlin(src: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'kotlin');
  return extractFromTree(tree!.rootNode, kotlinFlow, grammarShape('kotlin')!, 's.kt');
}

const routeKeys = (f: FileFlow) => f.routes.map((r) => `${r.method} ${r.path}`).sort();
const callKeys = (f: FileFlow) => f.calls.map((c) => `${c.method} ${c.path}`).sort();

describe('jvm packs — declaration completeness', () => {
  it('both packs declare httpFlow + modelSchema + a shaped grammar', () => {
    for (const id of ['java', 'kotlin'] as const) {
      const pack = getLanguage(id)!;
      expect(pack.httpFlow, `${id} httpFlow`).toBeDefined();
      expect(pack.modelSchema, `${id} modelSchema`).toBeDefined();
      expect(grammarShape(id), `${id} shape row`).not.toBeNull();
    }
    expect(getLanguage('java')!.treeSitterGrammars?.['.java']).toBe('java');
    expect(getLanguage('kotlin')!.treeSitterGrammars?.['.kt']).toBe('kotlin');
    // .kts is deliberately unmapped — Gradle scripts are noise, not flow.
    expect(getLanguage('kotlin')!.treeSitterGrammars?.['.kts']).toBeUndefined();
  });
});

describe('java pack — served + consumed', () => {
  it('the RestTemplate verb-method family maps through the pack aliases', async () => {
    const flow = await extractJava(`class C { void f() {
      restTemplate.getForEntity("/api/a", A.class);
      restTemplate.postForLocation("/api/b", b);
      restTemplate.headForHeaders("/api/c");
      restTemplate.delete("/api/d/{id}", id);
    } }`);
    expect(callKeys(flow)).toEqual([
      'DELETE /api/d/{var}',
      'GET /api/a',
      'HEAD /api/c',
      'POST /api/b',
    ]);
  });

  it('a JPA repository .delete(entity) on an untrusted receiver is NOT a client call', async () => {
    const flow = await extractJava(
      `class S { void f() { userRepository.delete(user); cache.put("k", v); } }`,
    );
    expect(flow.calls).toHaveLength(0);
    expect(flow.dynamicCalls ?? []).toHaveLength(0);
  });

  it('@mock-style look-alikes cannot mint Spring routes (leading-slash + attachment guards)', async () => {
    const flow = await extractJava(`class T {
      @GetMapping niladicMarkerOnPlainClassMethodWithoutPrefix() { return null; }
    }`);
    // A marker @GetMapping with NO class prefix and no own path → no route.
    expect(flow.routes).toHaveLength(0);
  });
});

describe('kotlin pack — served + consumed', () => {
  it('Ktor DSL + Ktor client coexist: bare verbs are routes, member verbs are calls', async () => {
    const flow = await extractKotlin(`
      fun Route.api(client: HttpClient) {
        get("/things/{id}") {
          val remote = client.get("/upstream/things")
          call.respond(remote)
        }
      }
    `);
    expect(routeKeys(flow)).toEqual(['GET /things/{var}']);
    expect(callKeys(flow)).toEqual(['GET /upstream/things']);
  });

  it('client.request { method = … } is deliberately undeclared (no silent verb-less drop)', () => {
    expect(kotlinFlow.clientMethodCallees?.methods).not.toContain('request');
  });

  it('Spring annotations on kotlin reach the same routes as java', async () => {
    const flow = await extractKotlin(`
      @RestController
      @RequestMapping("/api/users")
      class UserController {
        @GetMapping("/{id}") fun one(@PathVariable id: Long): User? = null
        @DeleteMapping("/{id}") fun del(@PathVariable id: Long) {}
      }
    `);
    expect(routeKeys(flow)).toEqual(['DELETE /api/users/{var}', 'GET /api/users/{var}']);
  });

  it('Retrofit interfaces on kotlin declare consumed calls', async () => {
    const flow = await extractKotlin(`
      interface UserApi {
        @GET("users/{id}") suspend fun one(@Path("id") id: Long): User
      }
    `);
    expect(callKeys(flow)).toEqual(['GET /users/{var}']);
    expect(flow.routes).toHaveLength(0);
  });
});
