import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import {
  joinFlow,
  buildFlowModel,
  summarize,
  buildServedMatcher,
  servedMatch,
  consumedPathConfidence,
  hasOpaqueLeadingSegment,
  catchAllPrefixCovers,
} from '../src/analyzers/flow/model';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const ts = getLanguage('typescript')!.httpFlow as HttpFlowSupport;
const tsShape = grammarShape('typescript')!;
const cfg = { stripUrlPrefixes: ['${Config.apiBase()}'] };

async function fileFlow(src: string, file: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'typescript');
  return extractFromTree(tree!.rootNode, ts, tsShape, file, cfg);
}

describe('flow join', () => {
  it('binds a client call to a real route at full confidence', async () => {
    const client = await fileFlow('axios.get(`${Config.apiBase()}/articles/${id}`);', 'web/a.ts');
    const server = await fileFlow("class C { @get('/articles/{id}') f() {} }", 'api/c.ts');
    const bindings = joinFlow(client.calls, server.routes);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].reason).toBe('exact');
    expect(bindings[0].confidence).toBe(1);
    expect(bindings[0].route?.handler).toBe('f');
  });

  it('marks a call to a non-existent route as no-route (unresolved)', async () => {
    const client = await fileFlow("axios.get('/missing');", 'web/a.ts');
    const bindings = joinFlow(client.calls, []);
    expect(bindings[0].reason).toBe('no-route');
    expect(bindings[0].confidence).toBe(0);
    expect(bindings[0].route).toBeNull();
  });

  it('marks an external/absolute-URL call as external (path null)', async () => {
    const client = await fileFlow("axios.get('http://other.example/v1/x');", 'web/a.ts');
    const bindings = joinFlow(client.calls, []);
    expect(bindings[0].reason).toBe('external');
    expect(bindings[0].call.path).toBeNull();
  });

  it('downgrades an all-placeholder match to low confidence', async () => {
    const client = await fileFlow('http.get(`${base}`);', 'web/a.ts'); // -> /{var}
    // a catch-all-ish route that also reduces to /{var}
    const bindings = joinFlow(client.calls, [
      {
        method: 'GET',
        path: '/{var}',
        via: 'router-call',
        handler: null,
        file: 'api/c.ts',
        line: 1,
      },
    ]);
    expect(bindings[0].reason).toBe('placeholder-only');
    expect(bindings[0].confidence).toBeLessThan(1);
    expect(bindings[0].route).not.toBeNull();
  });
});

describe('flow model + summary', () => {
  it('assembles calls + routes + bindings and summarizes', async () => {
    const web = await fileFlow(
      `axios.get('/articles'); axios.post('/articles'); axios.get('/orphan');`,
      'web/a.ts',
    );
    const api = await fileFlow(
      "class C { @get('/articles') a(){} @post('/articles') b(){} }",
      'api/c.ts',
    );
    const model = buildFlowModel([web, api]);
    const s = summarize(model);
    expect(s.calls).toBe(3);
    expect(s.routes).toBe(2);
    expect(s.resolved).toBe(2); // two of three calls bind; /orphan does not
    expect(s.highConfidence).toBe(2);
    expect(s.unresolved).toBe(1);
  });
});

// The served matcher the GATE resolves against, sharing the join's
// catch-all-aware covering predicate (Rule 2).
describe('served matcher (gate ↔ join parity)', () => {
  it('resolves an exact key', () => {
    const m = buildServedMatcher(['GET /articles']);
    expect(servedMatch('GET', '/articles', m)).toBe(true);
    expect(servedMatch('GET', '/other', m)).toBe(false);
    expect(servedMatch('POST', '/articles', m)).toBe(false); // method-scoped
  });

  it('prefix-matches a concrete call under a catch-all', () => {
    const m = buildServedMatcher(['POST /api/{*}']);
    expect(servedMatch('POST', '/api', m)).toBe(true);
    expect(servedMatch('POST', '/api/users/login', m)).toBe(true);
    expect(servedMatch('POST', '/apix', m)).toBe(false); // not a prefix boundary
  });

  it('a root catch-all covers anything of its method', () => {
    const m = buildServedMatcher(['GET /{*}']);
    expect(servedMatch('GET', '/anything/at/all', m)).toBe(true);
    expect(servedMatch('POST', '/anything', m)).toBe(false);
  });

  it('an all-placeholder call never prefix-matches a catch-all (no static signal)', () => {
    const m = buildServedMatcher(['GET /{*}']);
    expect(servedMatch('GET', '/{var}', m)).toBe(false);
  });

  it('the covering predicate is the join and gate shared primitive', () => {
    expect(catchAllPrefixCovers('/api', '/api/x')).toBe(true);
    expect(catchAllPrefixCovers('/api', '/api')).toBe(true);
    expect(catchAllPrefixCovers('', '/anything')).toBe(true);
    expect(catchAllPrefixCovers('/api', '/apix')).toBe(false);
  });
});

describe('consumed path confidence (opaque leading segment)', () => {
  it('a literal-anchored path is full confidence', () => {
    expect(consumedPathConfidence('/api/users/login')).toBe(1);
    expect(consumedPathConfidence('/api/{var}')).toBe(1); // literal anchor, trailing var
  });

  it('a leading placeholder is low confidence (warn, not block)', () => {
    expect(hasOpaqueLeadingSegment('/{var}/users/login')).toBe(true);
    expect(consumedPathConfidence('/{var}/users/login')).toBe(0.3);
  });

  it('all-placeholder is a special case of leading-placeholder', () => {
    expect(hasOpaqueLeadingSegment('/{var}')).toBe(true);
    expect(consumedPathConfidence('/{var}')).toBe(0.3);
    expect(consumedPathConfidence('/{var}/{var}')).toBe(0.3);
  });
});
