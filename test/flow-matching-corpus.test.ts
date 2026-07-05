/**
 * Flow MATCHING golden corpus — the cross-framework net for route/call
 * resolution. It extends the normalize corpus (which validates path
 * canonicalization) to the JOIN (which decides whether a client call binds to a
 * served route), because that is where a whole CLASS of framework-specific
 * bugs lives: a route form dxkit doesn't model correctly makes every call
 * against it look unresolved.
 *
 * Two tables, both framework-labelled so a new language pack (M6: Python /
 * Go / Java / Ruby flow) adds ROWS rather than new matching code:
 *
 *   1. CATCH_ALL_FORMS — each framework's catch-all / splat route literal must
 *      normalize to the shared `/{prefix}/{*}` marker. If a pack introduces a
 *      new splat syntax, it adds a row here and inherits prefix-matching for
 *      free (the join is framework-agnostic).
 *   2. JOIN_CASES — (client call, served routes) → the expected binding. Pins
 *      catch-all prefix-matching, exact-wins-over-splat, longest-prefix-wins,
 *      method scoping, and the no-over-match guard.
 *
 * A regression in either fails CI — the same discipline as
 * `recipe-playbook.test.ts` for pack contributions, applied to flow precision.
 */

import { describe, it, expect } from 'vitest';
import { normalizePath } from '../src/analyzers/flow/normalize';
import { joinFlow } from '../src/analyzers/flow/model';
import type { ClientCall, RouteEndpoint } from '../src/analyzers/flow/extract';
import type { HttpMethod } from '../src/analyzers/flow/normalize';

// ── 1. Catch-all route forms across frameworks → the canonical /{*} marker ──

const CATCH_ALL_FORMS: Array<{ framework: string; raw: string; expected: string }> = [
  { framework: 'Next.js App Router', raw: '/api/[...slug]', expected: '/api/{*}' },
  { framework: 'Next.js optional catch-all', raw: '/api/[[...slug]]', expected: '/api/{*}' },
  { framework: 'Express splat', raw: '/api/*', expected: '/api/{*}' },
  { framework: 'Spring ant-matcher', raw: '/api/**', expected: '/api/{*}' },
  { framework: 'Rails glob', raw: '/api/*path', expected: '/api/{*}' },
  {
    framework: 'FastAPI/Starlette path-converter',
    raw: '/api/{file_path:path}',
    expected: '/api/{*}',
  },
  {
    framework: 'nested catch-all keeps its static prefix',
    raw: '/api/v2/[...rest]',
    expected: '/api/v2/{*}',
  },
];

describe('flow matching corpus — catch-all route forms normalize to {*}', () => {
  for (const { framework, raw, expected } of CATCH_ALL_FORMS) {
    it(`${framework}: ${raw} → ${expected}`, () => {
      expect(normalizePath(raw)).toBe(expected);
    });
  }

  it('a single dynamic segment stays {var} (NOT a catch-all)', () => {
    expect(normalizePath('/api/[id]')).toBe('/api/{var}'); // note: brackets are file-route form
    expect(normalizePath('/api/:id')).toBe('/api/{var}');
    expect(normalizePath('/api/{id}')).toBe('/api/{var}');
  });
});

// ── 2. Join cases: (client call, served routes) → expected binding ──

function call(method: HttpMethod, path: string): ClientCall {
  return { method, rawUrl: path, path, receiver: 'fetch', file: 'web/x.ts', line: 1 };
}
function route(method: HttpMethod, path: string): RouteEndpoint {
  return { method, path, via: 'file-route', handler: null, file: 'api/r.ts', line: 1 };
}

interface JoinCase {
  readonly name: string;
  readonly call: ClientCall;
  readonly routes: RouteEndpoint[];
  readonly boundPath: string | null; // expected route path, or null for unresolved
  readonly reason: string;
}

const JOIN_CASES: JoinCase[] = [
  {
    name: 'catch-all serves a one-segment tail',
    call: call('POST', '/api/form-submissions'),
    routes: [route('POST', '/api/{*}')],
    boundPath: '/api/{*}',
    reason: 'catch-all',
  },
  {
    name: 'catch-all serves a deeper tail',
    call: call('GET', '/api/users/me'),
    routes: [route('GET', '/api/{*}')],
    boundPath: '/api/{*}',
    reason: 'catch-all',
  },
  {
    name: 'catch-all does NOT match a different prefix (no over-match)',
    call: call('GET', '/other/thing'),
    routes: [route('GET', '/api/{*}')],
    boundPath: null,
    reason: 'no-route',
  },
  {
    name: 'an exact literal route wins over a covering catch-all',
    call: call('GET', '/api/users'),
    routes: [route('GET', '/api/{*}'), route('GET', '/api/users')],
    boundPath: '/api/users',
    reason: 'exact',
  },
  {
    name: 'the longest-prefix catch-all wins',
    call: call('GET', '/api/v2/widgets'),
    routes: [route('GET', '/api/{*}'), route('GET', '/api/v2/{*}')],
    boundPath: '/api/v2/{*}',
    reason: 'catch-all',
  },
  {
    name: 'catch-all is method-scoped (POST splat does not serve a GET call)',
    call: call('GET', '/api/x'),
    routes: [route('POST', '/api/{*}')],
    boundPath: null,
    reason: 'no-route',
  },
  {
    name: 'a root catch-all serves any path',
    call: call('DELETE', '/anything/at/all'),
    routes: [route('DELETE', '/{*}')],
    boundPath: '/{*}',
    reason: 'catch-all',
  },
];

describe('flow matching corpus — join resolution', () => {
  for (const c of JOIN_CASES) {
    it(c.name, () => {
      const [binding] = joinFlow([c.call], c.routes);
      expect(binding.reason).toBe(c.reason);
      expect(binding.route?.path ?? null).toBe(c.boundPath);
    });
  }

  it('a catch-all match resolves (route != null) at sub-exact confidence', () => {
    const [b] = joinFlow([call('POST', '/api/form-submissions')], [route('POST', '/api/{*}')]);
    expect(b.route).not.toBeNull();
    expect(b.confidence).toBeGreaterThan(0);
    expect(b.confidence).toBeLessThan(1); // a splat is a real bind, but not exact-literal
  });
});
