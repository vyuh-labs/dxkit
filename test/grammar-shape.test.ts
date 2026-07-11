/**
 * Grammar-shape adapter — the per-grammar syntax-access layer that lets the ONE
 * flow extractor (`extractFromTree`) walk any tree-sitter grammar.
 *
 * These tests drive the extractor over the PYTHON grammar with a synthetic
 * descriptor, proving the extractor carries no TS-grammar node names: the same
 * semantics (client calls, precision guard, dynamic counting, decorator skip)
 * hold on a grammar whose call/member/string node types are all different.
 * The real python pack's descriptor is pinned separately (its own wave); this
 * file pins the ADAPTER.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape, shapedGrammars } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import type { HttpFlowSupport } from '../src/languages/types';

const py = grammarShape('python')!;
const js = grammarShape('typescript')!;

/** A synthetic Python-ish descriptor — requests/httpx trusted, verbs lowercase. */
const PY_DESCRIPTOR: HttpFlowSupport = {
  clientMethodCallees: {
    methods: ['get', 'post', 'put', 'patch', 'delete'],
    bases: ['requests', 'httpx'],
  },
};

async function extractPy(src: string, hf: HttpFlowSupport = PY_DESCRIPTOR): Promise<FileFlow> {
  const tree = await parseSource(src, 'python');
  return extractFromTree(tree!.rootNode, hf, py, 'sample.py');
}

describe('grammar shape — registry', () => {
  it('has rows for the JS family and python', () => {
    for (const g of ['typescript', 'tsx', 'javascript', 'python']) {
      expect(grammarShape(g), g).not.toBeNull();
      expect(shapedGrammars()).toContain(g);
    }
  });

  it('returns null (never throws) for an unshaped grammar', () => {
    expect(grammarShape('cobol')).toBeNull();
  });

  it('the JS family shares one shape object (one row, three names)', () => {
    expect(grammarShape('typescript')).toBe(grammarShape('tsx'));
    expect(grammarShape('typescript')).toBe(grammarShape('javascript'));
  });
});

describe('grammar shape — python syntax access', () => {
  it('resolves member calls and reads plain + f-string literals', async () => {
    const { calls } = await extractPy(`
import requests
def f(slug):
    requests.get("/api/articles")
    httpx.post(f"/api/articles/{slug}")
`);
    const keys = calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toEqual(['GET /api/articles', 'POST /api/articles/{var}']);
  });

  it('trusted bases count dynamic URLs; untrusted receivers need the URL guard', async () => {
    const flow = await extractPy(`
def f(url, key):
    requests.get(url)
    session.delete("/api/items/3")
    config.get("retry-count")
    d.get(key)
`);
    // requests.* is trusted → its dynamic call is COUNTED, not dropped.
    expect(flow.dynamicCalls).toHaveLength(1);
    expect(flow.dynamicCalls?.[0].receiver).toBe('requests');
    // session.* is untrusted but path-like → counted as a call (wrapper case).
    // config.get / d.get carry no path signal → filtered, not counted anywhere.
    expect(flow.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/items/3']);
  });

  it('keyword arguments are not mistaken for the positional URL argument', async () => {
    const { calls } = await extractPy(`
def f():
    requests.get(timeout=5, url="/computed-elsewhere")
    httpx.post("/api/things", json={"a": 1})
`);
    // First call has NO positional arg → dynamic for a trusted base, not a
    // binding on "timeout=5"; second binds on the string, not the json kwarg.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/things']);
  });

  it('a decorator subtree is never double-read as a client call', async () => {
    // `@app.get("/items")` contains a member call that LOOKS like a client
    // call (`app.get` with a path literal) — the decorator branch must skip
    // the subtree, so the consumed side stays empty.
    const flow = await extractPy(`
@app.get("/items")
def read_items():
    return []
`);
    expect(flow.calls).toHaveLength(0);
  });

  it('python string prefixes (f/r/rb) are stripped before URL normalization', async () => {
    const { calls } = await extractPy(`
def f(x):
    requests.get(r"/raw/path")
    requests.get(rb"/bytes/path")
`);
    const paths = calls.map((c) => c.path).sort();
    expect(paths).toEqual(['/bytes/path', '/raw/path']);
  });
});

describe('grammar shape — semantics parity across grammars', () => {
  it('the identical descriptor semantics hold on the JS grammar', async () => {
    // Same descriptor, same code shape, different grammar — the extractor's
    // semantics (trusted dynamic counting + untrusted guard) must agree.
    const tree = await parseSource(
      `
      requests.get(url);
      session.delete('/api/items/3');
      config.get('retry-count');
    `,
      'typescript',
    );
    const flow = extractFromTree(tree!.rootNode, PY_DESCRIPTOR, js, 'sample.ts');
    expect(flow.dynamicCalls).toHaveLength(1);
    expect(flow.dynamicCalls?.[0].receiver).toBe('requests');
    expect(flow.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/items/3']);
  });
});
