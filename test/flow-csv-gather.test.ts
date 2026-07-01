import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSource } from '../src/ast/parse';
import { extractFromTree } from '../src/analyzers/flow/extract';
import { buildFlowModel } from '../src/analyzers/flow/model';
import { callsCsv, routesCsv, mappingCsv, flowCsvFiles } from '../src/analyzers/flow/csv';
import { gatherFlowModel } from '../src/analyzers/flow/gather';
import { getLanguage } from '../src/languages';
import type { HttpFlowSupport } from '../src/languages/types';

const ts = getLanguage('typescript')!.httpFlow as HttpFlowSupport;

async function model(clientSrc: string, serverSrc: string) {
  const c = extractFromTree((await parseSource(clientSrc, 'typescript'))!.rootNode, ts, 'web/a.ts');
  const s = extractFromTree((await parseSource(serverSrc, 'typescript'))!.rootNode, ts, 'api/c.ts');
  return buildFlowModel([c, s]);
}

describe('flow CSV renderers', () => {
  it('renders calls, routes, and mapping with quoted headers + rows', async () => {
    const m = await model(
      "axios.get('/articles'); axios.get('/orphan');",
      "class C { @get('/articles') a() {} }",
    );
    const calls = callsCsv(m);
    expect(calls.split('\n')[0]).toBe('"method","path","raw_url","receiver","file","line"');
    expect(calls).toContain('"GET","/articles"');

    const routes = routesCsv(m);
    expect(routes).toContain('"GET","/articles","decorator","a"');

    const mapping = mappingCsv(m);
    expect(mapping).toContain('"GET","/articles"'); // the bound call
    expect(mapping).toContain('"no-route"'); // the /orphan call
  });

  it('flowCsvFiles yields the three parity files', async () => {
    const files = flowCsvFiles(await model("axios.get('/x');", ''));
    expect(Object.keys(files).sort()).toEqual([
      'api_calls.csv',
      'api_route_mapping.csv',
      'routes.csv',
    ]);
  });
});

describe('flow gather (walk + extract + spec union)', () => {
  it('scans roots, extracts both surfaces, and unions spec routes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dxkit-gather-'));
    const web = join(base, 'web');
    const api = join(base, 'api');
    mkdirSync(web);
    mkdirSync(api);
    // Frontend call + backend static route + a spec-only route.
    writeFileSync(join(web, 'a.ts'), "axios.get('/articles'); axios.get('/spec-only');");
    writeFileSync(join(api, 'c.ts'), "class C { @get('/articles') a() {} }");
    const spec = join(base, 'openapi.json');
    writeFileSync(
      spec,
      JSON.stringify({ paths: { '/spec-only': { get: { operationId: 'X.y' } } } }),
    );

    const m = await gatherFlowModel({ roots: [web, api], specs: [spec] });

    // static route + spec route both present (union)
    const routeKeys = m.routes.map((r) => `${r.method} ${r.path} ${r.via}`);
    expect(routeKeys).toContain('GET /articles decorator');
    expect(routeKeys).toContain('GET /spec-only spec');

    // both frontend calls now bind — one to the static route, one to the spec route
    const bound = m.bindings.filter((b) => b.route);
    expect(bound).toHaveLength(2);
    expect(m.bindings.find((b) => b.call.path === '/spec-only')?.route?.via).toBe('spec');
  });

  it('excludes test files via the canonical walker (Rule 4)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dxkit-gather-'));
    writeFileSync(join(base, 'real.ts'), "axios.get('/real');");
    writeFileSync(join(base, 'thing.test.ts'), "axios.get('/should-be-skipped');");
    const m = await gatherFlowModel({ roots: [base] });
    const paths = m.calls.map((c) => c.path);
    expect(paths).toContain('/real');
    expect(paths).not.toContain('/should-be-skipped');
  });
});
