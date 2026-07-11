/**
 * Declarative route forms — the three descriptor shapes that cover frameworks
 * whose route declarations are not bare decorators or router member-calls:
 *
 *   - routeMemberDecorators: FastAPI `@app.get('/x')` (member-callee verb)
 *   - routePathDecorators:   Flask `@app.route('/x', methods=['GET','POST'])`
 *   - routeCallees:          Django `path('users/<int:pk>/', view)` → ANY
 *
 * Exercised over the PYTHON grammar with SYNTHETIC descriptors: this file pins
 * the extractor's semantics for the forms; the real python pack's declaration
 * is pinned separately (its own wave). Also pins the precision guards each
 * form ships with — the leading-slash rule that keeps `@mock.patch('pkg.attr')`
 * out, and the include()/arity guards that keep Django prefix mounts out.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import type { HttpFlowSupport } from '../src/languages/types';

const py = grammarShape('python')!;

async function extractPy(src: string, hf: HttpFlowSupport): Promise<FileFlow> {
  const tree = await parseSource(src, 'python');
  return extractFromTree(tree!.rootNode, hf, py, 'sample.py');
}

const routeKeys = (flow: FileFlow): string[] =>
  flow.routes.map((r) => `${r.method} ${r.path}`).sort();

describe('routeMemberDecorators — member-callee verb decorators (FastAPI shape)', () => {
  const hf: HttpFlowSupport = {
    routeMemberDecorators: { methods: ['get', 'post', 'put', 'patch', 'delete'] },
  };

  it('extracts @recv.verb(path) with params canonicalized and handler resolved', async () => {
    const flow = await extractPy(
      `
@app.get("/items/{item_id}")
def read_item(item_id):
    return {}

@router.post("/users")
async def create_user():
    return {}
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['GET /items/{var}', 'POST /users']);
    expect(flow.routes.find((r) => r.method === 'GET')?.handler).toBe('read_item');
    expect(flow.routes.every((r) => r.via === 'decorator')).toBe(true);
  });

  it('leading-slash guard: a look-alike member decorator mints no route', async () => {
    // `patch` is a verb name AND unittest.mock's ubiquitous decorator — its
    // argument is a dotted target, never a slashed path.
    const flow = await extractPy(
      `
@mock.patch("requests.get")
def test_x(m):
    pass
`,
      hf,
    );
    expect(flow.routes).toHaveLength(0);
    expect(flow.calls).toHaveLength(0); // and its subtree is not a client call
  });

  it('bases, when declared, restrict which receivers count', async () => {
    const restricted: HttpFlowSupport = {
      routeMemberDecorators: { methods: ['get'], bases: ['app'] },
    };
    const flow = await extractPy(
      `
@app.get("/yes")
def a():
    pass

@other.get("/no")
def b():
    pass
`,
      restricted,
    );
    expect(routeKeys(flow)).toEqual(['GET /yes']);
  });
});

describe('routePathDecorators — path-first decorators with a methods keyword (Flask shape)', () => {
  const hf: HttpFlowSupport = {
    routePathDecorators: { names: ['route'], methodsKeyword: 'methods', defaultMethods: ['GET'] },
  };

  it('reads the methods list and emits one route per verb', async () => {
    const flow = await extractPy(
      `
@app.route("/legacy", methods=["GET", "POST"])
def legacy():
    return ""
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['GET /legacy', 'POST /legacy']);
    expect(flow.routes[0].handler).toBe('legacy');
  });

  it('falls back to defaultMethods when the keyword is absent (Flask default: GET)', async () => {
    const flow = await extractPy(
      `
@app.route("/plain")
def plain():
    return ""
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['GET /plain']);
  });

  it('Flask converters canonicalize: <int:pk> → {var}, <path:rest> → catch-all', async () => {
    const flow = await extractPy(
      `
@app.route("/users/<int:user_id>")
def user(user_id):
    return ""

@app.route("/files/<path:subpath>")
def files(subpath):
    return ""
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['GET /files/{*}', 'GET /users/{var}']);
  });

  it('a same-named non-route call is not a route (decorator context required)', async () => {
    const flow = await extractPy(`result = route("/not-a-decorator", thing)`, hf);
    expect(flow.routes).toHaveLength(0);
  });
});

describe('routeCallees — verb-less route declarations (Django urls.py shape)', () => {
  const hf: HttpFlowSupport = {
    routeCallees: { names: ['path'], excludeArgCallees: ['include'] },
  };

  it('emits ANY routes with Django converters canonicalized', async () => {
    const flow = await extractPy(
      `
urlpatterns = [
    path("users/", views.user_list),
    path("users/<int:pk>/", views.user_detail),
]
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['ANY /users', 'ANY /users/{var}']);
    expect(flow.routes[0].via).toBe('router-call');
    expect(flow.routes.map((r) => r.handler)).toEqual(['views.user_list', 'views.user_detail']);
  });

  it('an include() mount is a PREFIX, not a route — skipped', async () => {
    const flow = await extractPy(
      `
urlpatterns = [
    path("api/", include("api.urls")),
    path("health/", views.health),
]
`,
      hf,
    );
    expect(routeKeys(flow)).toEqual(['ANY /health']);
  });

  it('arity guard: a path(...) with no handler argument mints no route', async () => {
    const flow = await extractPy(`p = path("just/a/string")`, hf);
    expect(flow.routes).toHaveLength(0);
  });

  it('a non-literal first argument mints no route', async () => {
    const flow = await extractPy(`urlpatterns = [path(prefix_var, views.x)]`, hf);
    expect(flow.routes).toHaveLength(0);
  });
});
