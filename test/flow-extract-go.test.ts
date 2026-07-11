/**
 * The go pack's httpFlow declaration, pinned over the real grammar — the Go
 * analog of `flow-extract.test.ts` (TS) / `flow-extract-python.test.ts`. The
 * ADAPTER and the descriptor FORMS have their own tests; this file pins what
 * the PACK declares: stdlib + router-package coverage with its precision
 * choices.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const goFlow = getLanguage('go')!.httpFlow as HttpFlowSupport;
const goShape = grammarShape('go')!;

async function extract(body: string): Promise<FileFlow> {
  const tree = await parseSource(`package main\nfunc main() {\n${body}\n}`, 'go');
  return extractFromTree(tree!.rootNode, goFlow, goShape, 'sample.go');
}

const routeKeys = (flow: FileFlow): string[] =>
  flow.routes.map((r) => `${r.method} ${r.path}`).sort();

describe('go pack — declaration completeness', () => {
  it('declares httpFlow + a shaped grammar (flow-capable)', () => {
    const pack = getLanguage('go')!;
    expect(pack.httpFlow).toBeDefined();
    expect(pack.treeSitterGrammars?.['.go']).toBe('go');
    expect(grammarShape('go')).not.toBeNull();
  });
});

describe('go pack — served side', () => {
  it('stdlib registrars: HandleFunc/Handle as ANY, 1.22 verb patterns concrete', async () => {
    const flow = await extract(`
  http.HandleFunc("/health", healthHandler)
  mux.HandleFunc("GET /users/{id}", userHandler)
  mux.Handle("/metrics", promhttp.Handler())
`);
    expect(routeKeys(flow)).toEqual(['ANY /health', 'ANY /metrics', 'GET /users/{var}']);
  });

  it('router packages: chi/echo/gin/fiber verb methods on conventional receivers', async () => {
    const flow = await extract(`
  r.Get("/chi/{id}", chiHandler)
  e.GET("/echo/:id", echoHandler)
  router.POST("/gin", ginHandler)
  app.Get("/fiber", fiberHandler)
  s.router.Delete("/nested", h)
`);
    expect(routeKeys(flow)).toEqual([
      'DELETE /nested',
      'GET /chi/{var}',
      'GET /echo/{var}',
      'GET /fiber',
      'POST /gin',
    ]);
  });

  it('chained registrations (r.With(mw).Get) are ROUTES, never client calls', async () => {
    // chi idiom: middleware chained ahead of the verb method. The receiver
    // text is the whole chain — the chain HEAD (`r`) identifies the router.
    // Pre-fix this fell through to the client branch and a served route read
    // as a consumed call (found on a real chi codebase during validation).
    const flow = await extract(`
  r.With(paginate).Get("/articles/{slug}", getArticle)
  r.Route("/admin").Post("/users", createUser)
`);
    expect(routeKeys(flow)).toEqual(['GET /articles/{var}', 'POST /users']);
    expect(flow.calls).toHaveLength(0);
  });

  it('precision: cache clients and event registrations mint no routes', async () => {
    const flow = await extract(`
  val := r.Get(ctx, "cache/key/name")
  emitter.Handle("user-created", onCreated)
  bus.HandleFunc("topic-name", onTopic)
`);
    expect(flow.routes).toHaveLength(0);
  });
});

describe('go pack — consumed side', () => {
  it('http package is trusted; client wrappers pass the path guard', async () => {
    const flow = await extract(`
  resp, _ := http.Get(buildUrl())
  resp2, _ := http.Post("/api/things", "application/json", body)
  resp3, _ := client.Get("/api/items")
`);
    const keys = flow.calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toEqual(['GET /api/items', 'POST /api/things']);
    // http.Get with a runtime-built URL — recognized, unverifiable, DISCLOSED.
    expect(flow.dynamicCalls).toHaveLength(1);
    expect(flow.dynamicCalls?.[0].receiver).toBe('http');
  });

  it('http.NewRequest(WithContext) constructors bind or disclose', async () => {
    const flow = await extract(`
  req, _ := http.NewRequest("DELETE", "/api/items/9", nil)
  req2, _ := http.NewRequestWithContext(ctx, "PUT", url, nil)
`);
    expect(flow.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/items/9']);
    expect(flow.dynamicCalls).toHaveLength(1); // the ctx variant's runtime URL
  });

  it('an external absolute URL is recorded but unresolved (path null)', async () => {
    const { calls } = await extract(`resp, _ := http.Get("https://api.stripe.com/v1/charges")`);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBeNull();
  });

  it('the join property: a Go client call and a Go route reduce to one key', async () => {
    const flow = await extract(`
  mux.HandleFunc("GET /articles/{slug}/comments", commentsHandler)
  resp, _ := client.Get("/articles/some-slug/comments")
`);
    // The consumed literal keeps its concrete segment; the served 1.22
    // pattern canonicalizes {slug} → {var} — they meet through the join's
    // placeholder rules, pinned here at the key level for the exact form.
    expect(routeKeys(flow)).toEqual(['GET /articles/{var}/comments']);
    expect(flow.calls[0].path).toBe('/articles/some-slug/comments');
  });
});
