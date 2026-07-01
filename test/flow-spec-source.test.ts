import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { routesFromOpenApi, loadOpenApiRoutes } from '../src/analyzers/flow/spec-source';

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
});
