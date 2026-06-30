import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { extractFromTree, type FileFlow } from '../src/analyzers/flow/extract';
import { joinFlow, buildFlowModel, summarize } from '../src/analyzers/flow/model';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const ts = getLanguage('typescript')!.httpFlow as HttpFlowSupport;
const cfg = { stripUrlPrefixes: ['${Config.apiBase()}'] };

async function fileFlow(src: string, file: string): Promise<FileFlow> {
  const tree = await parseSource(src, 'typescript');
  return extractFromTree(tree!.rootNode, ts, file, cfg);
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
