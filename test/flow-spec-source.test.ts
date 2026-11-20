import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { routesFromOpenApi, loadOpenApiRoutes } from '../src/analyzers/flow/spec-source';
import { openapiReader } from '../src/analyzers/flow/contract-sources/openapi';

const doc = {
  openapi: '3.0.0',
  paths: {
    '/articles': {
      get: { operationId: 'ArticleController.find' },
      post: { operationId: 'ArticleController.create' },
    },
    '/articles/{id}': {
      get: { operationId: 'ArticleController.findById' },
      delete: {},
      parameters: [{ name: 'id', in: 'path' }], // not a method — must be skipped
    },
    '/health': { get: {} },
  },
};

describe('spec-source — routesFromOpenApi', () => {
  it('produces served routes with normalized paths, methods, and handlers', () => {
    const routes = routesFromOpenApi(doc, 'openapi.json');
    const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual([
      'DELETE /articles/{var}',
      'GET /articles',
      'GET /articles/{var}',
      'GET /health',
      'POST /articles',
    ]);
    expect(routes.every((r) => r.via === 'spec')).toBe(true);
    expect(routes.find((r) => r.path === '/articles' && r.method === 'GET')?.handler).toBe(
      'ArticleController.find',
    );
  });

  it('skips non-method keys (parameters/summary/$ref siblings)', () => {
    const routes = routesFromOpenApi(doc, 'openapi.json');
    // The `parameters` array under /articles/{id} must not become a route.
    expect(routes.some((r) => r.method.toLowerCase().includes('param'))).toBe(false);
    expect(routes.filter((r) => r.path === '/articles/{var}')).toHaveLength(2); // get + delete only
  });

  it('a spec route and a client call reduce to the same join key', () => {
    // (spec) GET /articles/{var}  ==  (client) axios.get(`/articles/${id}`)
    const specRoute = routesFromOpenApi(doc, 'o.json').find(
      (r) => r.method === 'GET' && r.path === '/articles/{var}',
    );
    expect(specRoute).toBeDefined();
    expect(`${specRoute!.method} ${specRoute!.path}`).toBe('GET /articles/{var}');
  });
});

describe('spec-source — loadOpenApiRoutes', () => {
  it('reads + parses a JSON OpenAPI file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-spec-'));
    const file = join(dir, 'openapi.json');
    writeFileSync(file, JSON.stringify(doc));
    const routes = loadOpenApiRoutes(file);
    expect(routes.length).toBe(5);
    expect(routes.every((r) => r.via === 'spec')).toBe(true);
  });

  it('degrades to [] on a missing or invalid spec (never throws)', () => {
    expect(loadOpenApiRoutes('/no/such/spec.json')).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-spec-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json');
    expect(loadOpenApiRoutes(bad)).toEqual([]);
  });
  // A YAML spec used to parse as JSON, fail, and contribute zero routes with
  // no message: the served side silently lost every route it declared.
  const YAML_SPEC = [
    'openapi: 3.0.0',
    'info: { title: t, version: "1" }',
    'paths:',
    '  /api/orders:',
    '    get:',
    '      operationId: listOrders',
    "      responses: { '200': { description: ok } }",
    '  /api/orders/{id}:',
    '    parameters:',
    '      - { name: id, in: path, required: true, schema: { type: string } }',
    '    delete:',
    "      responses: { '204': { description: gone } }",
    '',
  ].join('\n');

  it('reads a YAML OpenAPI file (.yaml and .yml) into the same routes as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-spec-'));
    for (const name of ['openapi.yaml', 'openapi.yml']) {
      const file = join(dir, name);
      writeFileSync(file, YAML_SPEC);
      const routes = loadOpenApiRoutes(file);
      expect(routes.map((r) => `${r.method} ${r.path} ${r.handler ?? '-'}`)).toEqual([
        'GET /api/orders listOrders',
        'DELETE /api/orders/{var} -',
      ]);
      expect(routes.every((r) => r.via === 'spec' && r.file === file)).toBe(true);
    }
  });

  it('degrades to [] on an invalid YAML spec (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-spec-'));
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'paths:\n  /x: [unclosed\n');
    expect(loadOpenApiRoutes(bad)).toEqual([]);
  });

  it('the openapi contract source reads YAML and names the format in a parse error', () => {
    expect(openapiReader.sniff('api/openapi.yaml')).toBe(true);
    expect(openapiReader.sniff('swagger.yml')).toBe(true);
    const ok = openapiReader.parse(YAML_SPEC, 'openapi.yaml');
    expect(ok.errors).toEqual([]);
    expect(ok.served.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/orders',
      'DELETE /api/orders/{var}',
    ]);
    const bad = openapiReader.parse('paths: [unclosed', 'openapi.yaml');
    expect(bad.errors[0]).toContain('not valid YAML');
  });
});
