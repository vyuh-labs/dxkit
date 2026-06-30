import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const ts = getLanguage('typescript')!.httpFlow as HttpFlowSupport;
const cfg = { stripUrlPrefixes: ['${Config.apiBase()}'] };

async function extract(src: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'typescript');
  return extractFromTree(tree!.rootNode, ts, 'sample.ts', cfg);
}

describe('flow extract — client calls (consumed side)', () => {
  it('extracts axios + fetch + wrapper calls with method and normalized path', async () => {
    const { calls } = await extract(`
      axios.get('/articles');
      fetch('/users/login', { method: 'POST' });
      requests.put(\`/articles/\${slug}\`);
      axios.get(\`\${Config.apiBase()}/tags\`);
    `);
    const keys = calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toContain('GET /articles');
    expect(keys).toContain('POST /users/login'); // fetch method read from options
    expect(keys).toContain('PUT /articles/{var}'); // template param canonicalized
    expect(keys).toContain('GET /tags'); // host-helper stripped
  });

  it('precision guard: non-HTTP .get/.delete with non-path args are NOT calls', async () => {
    const { calls } = await extract(`
      cache.get('config-key');
      store.delete(id);
      _.get(obj, 'a.b.c');
      map.get(key);
      new Map().get('x');
    `);
    expect(calls).toHaveLength(0);
  });

  it('a dynamic URL is recorded but left unresolved (path null)', async () => {
    const { calls } = await extract('http.get(`${base}/x`);');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/{var}/x');
  });
});

describe('flow extract — routes (served side)', () => {
  it('extracts decorator routes (LoopBack/NestJS) incl. the del → DELETE alias', async () => {
    const { routes } = await extract(`
      class C {
        @get('/articles/{id}') find() {}
        @post('/articles') create() {}
        @del('/articles/{id}') remove() {}
      }
    `);
    const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(['DELETE /articles/{var}', 'GET /articles/{var}', 'POST /articles']);
    expect(routes.find((r) => r.method === 'GET')?.handler).toBe('find'); // handler name resolved
  });

  it('extracts Express router/app route declarations', async () => {
    const { routes } = await extract(`
      router.post('/login', handler);
      app.get('/health', h);
    `);
    const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(['GET /health', 'POST /login']);
    expect(routes.every((r) => r.via === 'router-call')).toBe(true);
  });

  it('does not treat a client call as a route', async () => {
    const { routes, calls } = await extract("axios.get('/articles');");
    expect(routes).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

describe('flow extract — the join property', () => {
  it('a client call and a route reduce to the same key', async () => {
    const client = await extract('axios.delete(`${Config.apiBase()}/articles/${slug}/favorite`);');
    const server = await extract("class C { @del('/articles/{id}/favorite') f() {} }");
    const ck = `${client.calls[0].method} ${client.calls[0].path}`;
    const sk = `${server.routes[0].method} ${server.routes[0].path}`;
    expect(ck).toBe('DELETE /articles/{var}/favorite');
    expect(sk).toBe(ck);
  });
});
