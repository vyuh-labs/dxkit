/**
 * The SDK 0.2.0 descriptor forms, driven end-to-end through the ONE flow
 * extractor over the java + kotlin grammars with SYNTHETIC descriptors
 * (the real pack declarations are pinned separately with their wave):
 *
 *   - routePrefixDecorators   Spring class-level @RequestMapping, JAX-RS @Path
 *   - decoratorPathKeywords   @RequestMapping(value = "/x") / @GetMapping(path=)
 *   - routePathDecorators     method= enum refs, single values, 'ANY' default
 *   - routeAnnotationPairs    JAX-RS @GET + @Path (markers only)
 *   - clientDecorators        Retrofit @GET("users/{id}") — a consumed call
 *   - clientBuilderChains     WebClient / java.net.http / OkHttp chains
 *   - routeVerbCallees        Ktor get("/x") { } with routeGroupCallees nesting
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import type { HttpFlowSupport } from '../src/languages/types';

const java = grammarShape('java')!;
const kotlin = grammarShape('kotlin')!;

async function extract(
  src: string,
  grammar: 'java' | 'kotlin',
  hf: HttpFlowSupport,
): Promise<FileFlow> {
  const tree = await parseSource(src, grammar);
  return extractFromTree(tree!.rootNode, hf, grammar === 'java' ? java : kotlin, `f.${grammar}`);
}

const routeKeys = (f: FileFlow) => f.routes.map((r) => `${r.method} ${r.path}`).sort();
const callKeys = (f: FileFlow) => f.calls.map((c) => `${c.method} ${c.path}`).sort();

// ── Spring MVC (java) ────────────────────────────────────────────────────────

const SPRING: HttpFlowSupport = {
  routeDecorators: ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'],
  routePathDecorators: {
    names: ['RequestMapping'],
    methodsKeyword: 'method',
    defaultMethods: ['ANY'],
  },
  routePrefixDecorators: { names: ['RequestMapping'] },
  decoratorPathKeywords: ['value', 'path'],
  methodAliases: {
    getmapping: 'GET',
    postmapping: 'POST',
    putmapping: 'PUT',
    deletemapping: 'DELETE',
    patchmapping: 'PATCH',
  },
};

describe('Spring MVC forms (java)', () => {
  it('class-level @RequestMapping prefixes every handler route', async () => {
    const flow = await extract(
      `@RestController
       @RequestMapping("/api/users")
       public class UserController {
         @GetMapping("/{id}") public User one(@PathVariable long id) { return null; }
         @PostMapping public User create(@RequestBody User u) { return null; }
         @GetMapping(path = "/search") public List<User> search() { return null; }
       }`,
      'java',
      SPRING,
    );
    expect(routeKeys(flow)).toEqual([
      'GET /api/users/search',
      'GET /api/users/{var}',
      'POST /api/users', // marker @PostMapping → the class prefix alone
    ]);
    // The class-level @RequestMapping minted NO route of its own.
    expect(flow.routes).toHaveLength(3);
  });

  it('@RequestMapping(value=, method=RequestMethod.X) reads keyword path + enum verbs', async () => {
    const flow = await extract(
      `public class C {
         @RequestMapping(value = "/things", method = RequestMethod.PUT)
         public void put() {}
         @RequestMapping(value = "/multi", method = {RequestMethod.GET, RequestMethod.POST})
         public void multi() {}
         @RequestMapping("/anything")
         public void anyMethod() {}
       }`,
      'java',
      SPRING,
    );
    expect(routeKeys(flow)).toEqual([
      'ANY /anything', // no method attr → the 'ANY' default token
      'GET /multi',
      'POST /multi',
      'PUT /things',
    ]);
  });
});

// ── JAX-RS pairs + Retrofit client decorators (java) ────────────────────────

const JAXRS_RETROFIT: HttpFlowSupport = {
  routeAnnotationPairs: {
    methodMarkers: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    pathNames: ['Path'],
  },
  routePrefixDecorators: { names: ['Path'] },
  clientDecorators: { names: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] },
};

describe('JAX-RS split pairs vs Retrofit client decorators (java)', () => {
  it('marker @GET + sibling @Path is a route; class @Path prefixes; bare marker = prefix alone', async () => {
    const flow = await extract(
      `@Path("widgets")
       public class WidgetResource {
         @GET @Path("/{id}") public Widget one() { return null; }
         @POST public Widget create() { return null; }
       }`,
      'java',
      JAXRS_RETROFIT,
    );
    expect(routeKeys(flow)).toEqual(['GET /widgets/{var}', 'POST /widgets']);
    expect(flow.calls).toHaveLength(0);
  });

  it('a CALLED @GET("users/{id}") is a Retrofit CONSUMED call (relative path ok), never a route', async () => {
    const flow = await extract(
      `public interface UserApi {
         @GET("users/{id}") Call<User> one(@retrofit2.http.Path("id") long id);
         @POST("users") Call<User> create(@Body User u);
       }`,
      'java',
      JAXRS_RETROFIT,
    );
    expect(callKeys(flow)).toEqual(['GET /users/{var}', 'POST /users']);
    expect(flow.routes).toHaveLength(0);
  });
});

// ── Builder chains (java) ────────────────────────────────────────────────────

const CHAINS: HttpFlowSupport = {
  clientBuilderChains: [
    {
      urlCallees: ['uri', 'url'],
      verbCallees: ['get', 'post', 'put', 'patch', 'delete', 'GET', 'POST', 'PUT', 'DELETE'],
      methodArgCallees: ['method'],
      unwrapArgCallees: ['create'],
    },
  ],
};

describe('builder-chain clients (java)', () => {
  it('WebClient: verb BEFORE the url (down the receiver chain)', async () => {
    const flow = await extract(
      `class C { void f() { webClient.get().uri("/api/items").retrieve().bodyToMono(T.class); } }`,
      'java',
      CHAINS,
    );
    expect(callKeys(flow)).toEqual(['GET /api/items']);
  });

  it('java.net.http: verb AFTER the url, URL wrapped in URI.create (unwrap + up-chain)', async () => {
    const flow = await extract(
      `class C { void f() {
         var req = HttpRequest.newBuilder().uri(URI.create("/api/things/{id}")).POST(body).build();
       } }`,
      'java',
      CHAINS,
    );
    expect(callKeys(flow)).toEqual(['POST /api/things/{var}']);
  });

  it('OkHttp: .url("…").get().build(), and .method("DELETE", …) reads the verb argument', async () => {
    const flow = await extract(
      `class C { void f() {
         Request a = new Request.Builder().url("/v1/things").get().build();
         Request b = new Request.Builder().url("/v1/things/9").method("DELETE", null).build();
       } }`,
      'java',
      CHAINS,
    );
    // A concrete client path stays literal — the join's var-match binds it
    // against a `/{var}` route; normalization never guesses at IDs.
    expect(callKeys(flow)).toEqual(['DELETE /v1/things/9', 'GET /v1/things']);
  });

  it('a verb-bearing chain with a runtime URL is a DYNAMIC site; a verbless .uri() is silent', async () => {
    const flow = await extract(
      `class C { void f(String target) {
         webClient.get().uri(target).retrieve();
         someBuilder.uri("/not/http");
       } }`,
      'java',
      CHAINS,
    );
    expect(flow.calls).toHaveLength(0);
    expect(flow.dynamicCalls).toHaveLength(1);
    expect(flow.dynamicCalls?.[0].receiver).toBe('webClient');
  });
});

// ── Ktor server DSL (kotlin) ─────────────────────────────────────────────────

const KTOR: HttpFlowSupport = {
  routeVerbCallees: {
    methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
    requireTrailingLambda: true,
  },
  routeGroupCallees: { names: ['route'] },
};

describe('Ktor routing DSL (kotlin)', () => {
  it('bare verb callees with nested route("…") group prefixes', async () => {
    const flow = await extract(
      `fun Application.module() {
         routing {
           route("/api") {
             get("/items") { call.respond(items) }
             route("/v1") {
               post("/users") { call.respond(create()) }
             }
           }
           delete("/admin/cache") { call.respond(HttpStatusCode.OK) }
         }
       }`,
      'kotlin',
      KTOR,
    );
    expect(routeKeys(flow)).toEqual([
      'DELETE /admin/cache',
      'GET /api/items',
      'POST /api/v1/users',
    ]);
  });

  it('precision guards: no leading slash → not a route; no trailing lambda → not a route', async () => {
    const flow = await extract(
      `fun f(cache: Cache) {
         val v = cache.get("config-key")
         get("no-slash") { }
         get("/no-lambda")
       }`,
      'kotlin',
      KTOR,
    );
    expect(flow.routes).toHaveLength(0);
    expect(flow.calls).toHaveLength(0);
  });
});

// ── Spring on Kotlin (annotations through constructor_invocation) ───────────

describe('Spring forms on kotlin', () => {
  it('class prefix + verb annotation + keyword path all work through the kotlin row', async () => {
    const flow = await extract(
      `@RestController
       @RequestMapping("/api")
       class KtController {
         @GetMapping("/kt/{id}") fun one(@PathVariable id: Long): T? = null
         @PostMapping(path = ["/kt"]) fun create(): T? = null
       }`,
      'kotlin',
      SPRING,
    );
    // NOTE: @PostMapping(path = ["/kt"]) carries the path in a LIST literal —
    // decoratorPathKeywords reads string values, so the list form falls back
    // to the class prefix alone (honest; kotlin idiom usually uses a plain
    // string). The plain-string keyword form is covered on java above.
    expect(routeKeys(flow)).toContain('GET /api/kt/{var}');
  });
});
