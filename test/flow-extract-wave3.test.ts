/**
 * Wave-3 flow-extract forms: the descriptor-driven ENGINE features C#, Ruby,
 * and Rust exercise — the enclosing-type token ([controller]), the
 * verb-callee qualifier set (Rails/Sinatra precision), the resource
 * expansion, the pair/path double-mint guard, and the group-prefix
 * chain-link exclusion (axum). Inline descriptors mirror what the packs
 * declare; the pack declarations themselves are pinned by the fixture
 * matrix.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree } from '../src/analyzers/flow/extract';
import type { HttpFlowSupport } from '../src/languages/types';

async function extract(src: string, grammar: string, hf: HttpFlowSupport) {
  const tree = await parseSource(src, grammar);
  return extractFromTree(tree!.rootNode, hf, grammarShape(grammar)!, 'test-file');
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

// ── C# ───────────────────────────────────────────────────────────────────────

const CSHARP_HF: HttpFlowSupport = {
  routeDecorators: ['HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch'],
  routePrefixDecorators: { names: ['Route'] },
  routePathDecorators: { names: ['Route'], methodsKeyword: 'method', defaultMethods: ['ANY'] },
  routeAnnotationPairs: {
    methodMarkers: ['HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch'],
    pathNames: ['Route'],
  },
  decoratorPathKeywords: ['template'],
  routeTokenFromEnclosingType: [
    { token: '[controller]', stripSuffix: 'Controller', lowercase: true },
  ],
  routeRouterCallees: {
    methods: ['MapGet', 'MapPost', 'MapPut', 'MapDelete', 'MapPatch'],
    bases: ['app'],
  },
  clientMethodCallees: {
    methods: ['GetAsync', 'PostAsync', 'GetFromJsonAsync', 'PostAsJsonAsync'],
    bases: ['client', '_client', 'httpClient', '_httpClient'],
  },
  methodAliases: {
    httpget: 'GET',
    httppost: 'POST',
    httpput: 'PUT',
    httpdelete: 'DELETE',
    httppatch: 'PATCH',
    mapget: 'GET',
    mappost: 'POST',
    mapput: 'PUT',
    mapdelete: 'DELETE',
    mappatch: 'PATCH',
    getasync: 'GET',
    postasync: 'POST',
    getfromjsonasync: 'GET',
    postasjsonasync: 'POST',
  },
};

describe('c_sharp attribute routing (the [controller] token)', () => {
  it('substitutes the enclosing type name — never an over-matching {var}', async () => {
    const src = `
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
    [HttpGet] public string All() => "";
    [HttpGet("{id}")] public string Get(int id) => "";
    [HttpPost] public string Create() => "";
}`;
    const { routes } = await extract(src, 'c_sharp', CSHARP_HF);
    expect(routes.map(key).sort()).toEqual([
      'GET /api/orders',
      'GET /api/orders/{var}',
      'POST /api/orders',
    ]);
  });

  it('a method-level [Route] + verb marker mints ONE route (the pair owns it)', async () => {
    const src = `
[Route("api/[controller]")]
public class VetsController {
    [HttpGet] [Route("all")] public string All() => "";
}`;
    const { routes } = await extract(src, 'c_sharp', CSHARP_HF);
    expect(routes.map(key)).toEqual(['GET /api/vets/all']);
  });

  it('a standalone method-level [Route] serves every verb (ANY)', async () => {
    const src = `
[Route("api/[controller]")]
public class LegacyController {
    [Route("old")] public string Old() => "";
}`;
    const { routes } = await extract(src, 'c_sharp', CSHARP_HF);
    expect(routes.map(key)).toEqual(['ANY /api/legacy/old']);
  });

  it('minimal APIs route through MapGet/MapPost on app', async () => {
    const src = `
class P { static void Main() {
    app.MapGet("/items/{id}", GetItem);
    app.MapPost("/items", CreateItem);
} }`;
    const { routes } = await extract(src, 'c_sharp', CSHARP_HF);
    expect(routes.map(key).sort()).toEqual(['GET /items/{var}', 'POST /items']);
  });

  it('HttpClient calls extract with interpolated URLs; trusted dynamic URLs are counted', async () => {
    const src = `
class S { async Task M() {
    await client.GetFromJsonAsync<Order>($"/orders/{id}");
    await _http.PostAsync("/orders", body);
    await client.GetAsync(BuildUrl());
} }`;
    const hf: HttpFlowSupport = {
      ...CSHARP_HF,
      clientMethodCallees: {
        methods: ['GetAsync', 'PostAsync', 'GetFromJsonAsync'],
        bases: ['client', '_http'],
      },
    };
    const { calls, dynamicCalls } = await extract(src, 'c_sharp', hf);
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /orders/{var}',
      'POST /orders',
    ]);
    expect(dynamicCalls).toHaveLength(1);
  });

  it('an unresolvable [controller] token DROPS the path rather than guessing', async () => {
    // No enclosing class — file-scoped attribute soup; the route must not
    // surface as /api/{var}.
    const src = `class C { [HttpGet("api/[controller]/x")] void M() {} }`;
    const hfNoToken: HttpFlowSupport = { ...CSHARP_HF, routeTokenFromEnclosingType: undefined };
    const withToken = await extract(src, 'c_sharp', CSHARP_HF);
    // Token declared → substituted from the enclosing class C (no suffix to strip).
    expect(withToken.routes.map(key)).toEqual(['GET /api/c/x']);
    // Token NOT declared → the normalizer's bracket rule fires: the exact
    // over-matching hazard the descriptor exists to prevent.
    const without = await extract(src, 'c_sharp', hfNoToken);
    expect(without.routes.map(key)).toEqual(['GET /api/{var}/x']);
  });
});

// ── Ruby ─────────────────────────────────────────────────────────────────────

const RUBY_HF: HttpFlowSupport = {
  routeVerbCallees: {
    methods: ['get', 'post', 'put', 'patch', 'delete', 'match'],
    requireTrailingLambda: true,
    handlerKeywords: ['to'],
    ancestorCallees: ['draw', 'namespace', 'scope', 'resources', 'resource'],
    methodsKeyword: 'via',
  },
  routeGroupCallees: { names: ['namespace', 'scope'] },
  routeResourceCallees: {
    names: ['resources'],
    singularNames: ['resource'],
    ancestorCallees: ['draw', 'namespace', 'scope'],
  },
  clientMethodCallees: {
    methods: ['get', 'post', 'put', 'patch', 'delete'],
    bases: ['HTTParty', 'Faraday'],
  },
};

describe('ruby routes.rb (verb qualifiers, groups, resources)', () => {
  it('draw-block routes qualify; a bare request-spec get does not', async () => {
    const src = `
Rails.application.routes.draw do
  get '/users/:id', to: 'users#show'
  get '/health' => 'status#health'
end
get '/spec-only'
`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key).sort()).toEqual(['GET /health', 'GET /users/{var}']);
  });

  it('namespace groups prefix their routes (symbol arguments)', async () => {
    const src = `
Rails.application.routes.draw do
  namespace :api do
    get '/articles', to: 'articles#index'
  end
  scope '/admin' do
    post '/jobs', to: 'jobs#create'
  end
end`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key).sort()).toEqual(['GET /api/articles', 'POST /admin/jobs']);
  });

  it('Sinatra verb + block qualifies via the trailing lambda', async () => {
    const src = `get '/items' do\n  "items"\nend`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key)).toEqual(['GET /items']);
  });

  it('match reads its verbs from via:, including the all → ANY token', async () => {
    const src = `
Rails.application.routes.draw do
  match '/legacy', to: 'l#x', via: [:get, :post]
  match '/everything', to: 'l#y', via: :all
end`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key).sort()).toEqual([
      'ANY /everything',
      'GET /legacy',
      'POST /legacy',
    ]);
  });

  it('resources expands to the RESTful set, filtered by only:/except:', async () => {
    const src = `
Rails.application.routes.draw do
  resources :articles, only: [:index, :show]
  namespace :api do
    resources :comments, except: [:new, :edit]
  end
  resource :profile, only: [:show, :update]
end`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key).sort()).toEqual([
      'DELETE /api/comments/{var}',
      'GET /api/comments',
      'GET /api/comments/{var}',
      'GET /articles',
      'GET /articles/{var}',
      'GET /profile',
      'PATCH /api/comments/{var}',
      'PATCH /profile',
      'POST /api/comments',
      'PUT /api/comments/{var}',
      'PUT /profile',
    ]);
  });

  it('a nested resources block is skipped, never minted with a wrong path', async () => {
    const src = `
Rails.application.routes.draw do
  resources :articles, only: [:index] do
    resources :comments
  end
end`;
    const { routes } = await extract(src, 'ruby', RUBY_HF);
    expect(routes.map(key)).toEqual(['GET /articles']);
  });

  it('client calls: trusted constant receivers + wrapper heuristic + #{…} interpolation', async () => {
    const src = `
resp = HTTParty.get("/api/items/#{id}")
conn.post('/api/orders')
cache.get('config-key')
`;
    const { calls } = await extract(src, 'ruby', RUBY_HF);
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/items/{var}',
      'POST /api/orders',
    ]);
  });
});

// ── Rust ─────────────────────────────────────────────────────────────────────

const RUST_HF: HttpFlowSupport = {
  routeDecorators: ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'],
  routeCallees: { memberNames: ['route'] },
  routeGroupCallees: { names: ['nest'] },
  clientMethodCallees: {
    methods: ['get', 'post', 'put', 'patch', 'delete', 'head'],
    bases: ['client', 'reqwest'],
  },
};

describe('rust routing (attributes, axum route/nest, reqwest)', () => {
  it('actix/rocket attribute routes extract, bare and scoped', async () => {
    const src = `
#[get("/hello/<name>")]
fn hello() -> String { String::new() }

#[actix_web::post("/orders")]
async fn create() -> String { String::new() }`;
    const { routes } = await extract(src, 'rust', RUST_HF);
    expect(routes.map(key).sort()).toEqual(['GET /hello/{var}', 'POST /orders']);
    expect(routes.find((r) => r.path === '/hello/{var}')?.handler).toBe('hello');
  });

  it('axum .route(...) mints ANY routes; .nest prefixes ONLY its argument side', async () => {
    const src = `
fn app() -> Router {
    Router::new()
        .route("/items", get(list).post(create))
        .nest("/api", Router::new().route("/users/{id}", get(get_user)))
}`;
    const { routes } = await extract(src, 'rust', RUST_HF);
    // /items is a chain-link SIBLING of .nest — it must NOT inherit /api.
    expect(routes.map(key).sort()).toEqual(['ANY /api/users/{var}', 'ANY /items']);
  });

  it('reqwest clients: member and scoped forms; format! URLs count as dynamic', async () => {
    const src = `
async fn m() {
    let a = client.get("/api/items").send().await;
    let b = reqwest::get("/api/status").await;
    let c = client.post(format!("/api/items/{}", id)).send().await;
}`;
    const { calls, dynamicCalls } = await extract(src, 'rust', RUST_HF);
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/items',
      'GET /api/status',
    ]);
    expect(dynamicCalls).toHaveLength(1);
  });
});
