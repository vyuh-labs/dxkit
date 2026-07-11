/**
 * The python pack's httpFlow declaration, pinned over the real grammar — the
 * Python analog of `flow-extract.test.ts` (TS). The ADAPTER and the three
 * declarative route FORMS have their own tests; this file pins what the PACK
 * declares: which frameworks' shapes it covers, with which precision choices.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const py = getLanguage('python')!.httpFlow as HttpFlowSupport;
const pyShape = grammarShape('python')!;

async function extract(src: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'python');
  return extractFromTree(tree!.rootNode, py, pyShape, 'sample.py');
}

describe('python pack — declaration completeness', () => {
  it('declares httpFlow + a shaped grammar (flow-capable)', () => {
    const pack = getLanguage('python')!;
    expect(pack.httpFlow).toBeDefined();
    expect(pack.treeSitterGrammars?.['.py']).toBe('python');
    expect(grammarShape('python')).not.toBeNull();
  });
});

describe('python pack — consumed side', () => {
  it('requests/httpx are trusted; wrappers pass the path guard; dict.get is out', async () => {
    const flow = await extract(`
import requests, httpx

def f(url, item_id, cfg):
    requests.get(f"/api/items/{item_id}")
    httpx.delete("/api/items/9")
    session.post("/api/wrapped")
    requests.patch(url)
    cfg.get("timeout")
`);
    const keys = flow.calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toEqual(['DELETE /api/items/9', 'GET /api/items/{var}', 'POST /api/wrapped']);
    expect(flow.dynamicCalls).toHaveLength(1); // requests.patch(url) — disclosed
    expect(flow.dynamicCalls?.[0].receiver).toBe('requests');
  });

  it('an external absolute URL is recorded but unresolved (path null)', async () => {
    const { calls } = await extract(`requests.get("https://api.stripe.com/v1/charges")`);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBeNull();
  });
});

describe('python pack — served side (FastAPI / Flask / Django)', () => {
  it('covers all three framework shapes in one file set', async () => {
    const flow = await extract(`
@app.get("/items/{item_id}")
def read_item(item_id):
    return {}

@router.put("/items/{item_id}")
def replace_item(item_id):
    return {}

@flask_app.route("/legacy", methods=["POST"])
def legacy():
    return ""

urlpatterns = [path("reports/<int:pk>/", views.report_detail)]
`);
    const keys = flow.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual([
      'ANY /reports/{var}',
      'GET /items/{var}',
      'POST /legacy',
      'PUT /items/{var}',
    ]);
  });

  it('precision: mock.patch / include() / bare route() calls mint no routes', async () => {
    const flow = await extract(`
@mock.patch("requests.get")
def test_x(m):
    pass

urlpatterns = [path("api/", include("api.urls"))]
result = route("/not-a-decorator", handler)
`);
    expect(flow.routes).toHaveLength(0);
    expect(flow.calls).toHaveLength(0);
  });

  it('the join property: a client call and a FastAPI route reduce to one key', async () => {
    const client = await extract(`requests.get(f"/articles/{slug}/comments")`);
    const server = await extract(`
@app.get("/articles/{slug}/comments")
def comments(slug):
    return []
`);
    const ck = `${client.calls[0].method} ${client.calls[0].path}`;
    const sk = `${server.routes[0].method} ${server.routes[0].path}`;
    expect(ck).toBe('GET /articles/{var}/comments');
    expect(sk).toBe(ck);
  });
});
