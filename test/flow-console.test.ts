import { describe, expect, it } from 'vitest';
import {
  buildFlowConsole,
  serializeDataIsland,
  type ConsoleEndpoint,
  type FlowConsoleInput,
} from '../src/analyzers/flow/console';

function endpoint(over: Partial<ConsoleEndpoint> = {}): ConsoleEndpoint {
  return {
    id: 'ep0',
    method: 'GET',
    path: '/articles/{var}',
    via: 'router-call',
    handler: 'getArticle',
    sourceFile: 'backend/routes.ts',
    line: 12,
    consumerCount: 2,
    consumerFiles: ['frontend/api.ts'],
    ...over,
  };
}

function input(over: Partial<FlowConsoleInput> = {}): FlowConsoleInput {
  return {
    repoName: 'demo',
    generatedAt: '2026-07-04T00:00:00.000Z',
    dxkitVersion: '2.25.0',
    scope: 'full',
    endpoints: [endpoint()],
    unconsumed: [],
    broken: [],
    totals: { endpoints: 1, bindings: 2 },
    visNetworkBundle: '',
    ...over,
  };
}

/** Pull the JSON data island out of the generated HTML. */
function parseIsland(html: string): Record<string, unknown> {
  const m = html.match(
    /<script id="dxkit-flow-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  expect(m, 'data island present').toBeTruthy();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

describe('buildFlowConsole', () => {
  it('emits a complete self-contained HTML document', () => {
    const html = buildFlowConsole(input());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // No external fetches — CSS + app JS are inline.
    expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it('embeds the model as a parseable JSON data island', () => {
    const data = parseIsland(buildFlowConsole(input()));
    expect((data.endpoints as unknown[]).length).toBe(1);
    expect((data.totals as { endpoints: number }).endpoints).toBe(1);
    expect((data.meta as { scope: string }).scope).toBe('full');
  });

  it('inlines the vis-network bundle when supplied and omits it otherwise', () => {
    const withVis = buildFlowConsole(input({ visNetworkBundle: 'window.vis={Network:1};' }));
    expect(withVis).toContain('window.vis={Network:1};');
    const withoutVis = buildFlowConsole(input({ visNetworkBundle: '' }));
    expect(withoutVis).not.toContain('window.vis=');
  });

  it('renders the request runner app (a browser-side, not dxkit-side, caller)', () => {
    const html = buildFlowConsole(input());
    expect(html).toContain('Send request');
    expect(html).toContain('Base URL');
    // The safety contract must be stated in the document.
    expect(html).toMatch(/never (committed|prod)/i);
  });

  it('discloses unverifiable (dynamic-URL) call sites in the header, silent when zero', () => {
    const withDynamic = buildFlowConsole(input({ dynamicCallSites: 3 }));
    expect(withDynamic).toContain('3 recognized call site(s) build their URL at runtime');
    const clean = buildFlowConsole(input({ dynamicCallSites: 0 }));
    expect(clean).not.toContain('build their URL at runtime');
    const absent = buildFlowConsole(input());
    expect(absent).not.toContain('build their URL at runtime');
  });

  it('shows the broken-integrations section only in diff scope', () => {
    expect(buildFlowConsole(input({ scope: 'full' }))).not.toContain('id="dx-broken"');
    const diff = buildFlowConsole(
      input({
        scope: 'diff',
        baseRef: 'main',
        diffFileCount: 3,
        endpoints: [],
        totals: { endpoints: 0, bindings: 0 },
      }),
    );
    expect(diff).toContain('id="dx-broken"');
    expect(diff).toContain('Net-new broken integrations');
  });

  it('carries the diff scope + base ref in the header and model', () => {
    const html = buildFlowConsole(
      input({ scope: 'diff', baseRef: 'origin/main', diffFileCount: 4 }),
    );
    expect(html).toMatch(/Scoped to this change/);
    expect(html).toContain('origin/main');
    const data = parseIsland(html);
    expect((data.meta as { baseRef: string }).baseRef).toBe('origin/main');
    expect((data.meta as { diffFileCount: number }).diffFileCount).toBe(4);
  });

  it('propagates a broken finding into the model', () => {
    const broken = endpoint({
      id: 'ep9',
      method: 'POST',
      path: '/widgets',
      via: 'call-site',
      handler: null,
      sourceFile: 'frontend/api.ts',
      consumerCount: 1,
      consumerFiles: ['frontend/api.ts'],
      affected: true,
      broken: { reason: 'no-route', verdict: 'block' },
    });
    const data = parseIsland(buildFlowConsole(input({ scope: 'diff', broken: [broken] })));
    const list = data.broken as Array<{ broken: { reason: string; verdict: string } }>;
    expect(list).toHaveLength(1);
    expect(list[0].broken.verdict).toBe('block');
  });

  it('a hostile file path cannot break out of the data island or inject markup', () => {
    const evil = endpoint({ sourceFile: 'x</script><img src=x onerror=alert(1)>.ts' });
    const html = buildFlowConsole(input({ endpoints: [evil] }));
    // The raw closing-tag sequence must not appear verbatim inside the island;
    // the data island still parses and preserves the original string.
    const island = html.match(
      /<script id="dxkit-flow-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(island).toBeTruthy();
    expect(island![1]).not.toContain('</script>');
    const data = JSON.parse(island![1]) as { endpoints: Array<{ sourceFile: string }> };
    expect(data.endpoints[0].sourceFile).toContain('onerror');
    // Only ONE real </script> closes the app script that follows the island.
  });
});

describe('serializeDataIsland', () => {
  it('escapes the characters that could break out of a <script> element', () => {
    const out = serializeDataIsland({ a: '</script>', b: '<b>&', c: 'x>y' });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(out).toContain('\\u003c'); // <
    expect(out).toContain('\\u003e'); // >
    expect(out).toContain('\\u0026'); // &
  });

  it('round-trips to the original object after unescaping via JSON.parse', () => {
    const obj = { path: '/a/{var}', note: 'a < b && c > d' };
    // The escaped \u00xx sequences are valid JSON escapes, so JSON.parse
    // recovers the original string.
    expect(JSON.parse(serializeDataIsland(obj))).toEqual(obj);
  });
});
