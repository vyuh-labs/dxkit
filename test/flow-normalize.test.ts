import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  normalizeMethod,
  bindingKey,
  type NormalizeConfig,
} from '../src/analyzers/flow/normalize';

// Host-helper config as it would arrive from `.dxkit/policy.json:flow`.
const cfg: NormalizeConfig = {
  stripUrlPrefixes: [
    '${Config.apiBase()}',
    '${Config.apiV2()}',
    '${Config.userSvc()}',
    '${apiUrl}',
  ],
};

describe('flow normalizePath', () => {
  it('strips quotes/backticks and yields a bare path', () => {
    expect(normalizePath("'/articles'")).toBe('/articles');
    expect(normalizePath('"/articles"')).toBe('/articles');
    expect(normalizePath('`/articles`')).toBe('/articles');
  });

  it('canonicalizes every param form to {var}', () => {
    expect(normalizePath('/articles/:slug')).toBe('/articles/{var}'); // Express / Rails
    expect(normalizePath('/articles/{id}')).toBe('/articles/{var}'); // OpenAPI / LoopBack
    expect(normalizePath('`/articles/${slug}`')).toBe('/articles/{var}'); // JS template
    expect(normalizePath('`/articles/${slug}/comments/${commentId}`')).toBe(
      '/articles/{var}/comments/{var}',
    );
  });

  it('strips configured host-helper prefixes (the per-app lever)', () => {
    expect(normalizePath('`${Config.apiBase()}/widgets/icons`', cfg)).toBe('/widgets/icons');
    expect(normalizePath('`${Config.userSvc()}/services/${id}`', cfg)).toBe('/services/{var}');
    // A dynamic base that is NOT a configured helper stays a {var} segment.
    expect(normalizePath('`${apiUrl}/distinct`', cfg)).toBe('/distinct');
  });

  it('drops the query string (params do not distinguish a route)', () => {
    expect(normalizePath('`/articles?${limit(10, page)}`')).toBe('/articles');
    expect(normalizePath('`${Config.apiBase()}/things?filter=${filter}`', cfg)).toBe('/things');
  });

  it('adds a leading slash for LoopBack decorators written without one', () => {
    expect(normalizePath("'jobs/run/execute'")).toBe('/jobs/run/execute');
  });

  it('drops a trailing slash and collapses accidental double slashes', () => {
    expect(normalizePath('/articles/')).toBe('/articles');
    expect(normalizePath('`${Config.apiBase()}//articles`', cfg)).toBe('/articles');
  });

  it('rejects external absolute URLs (not an internal route binding)', () => {
    expect(normalizePath('`http://localhost/api/reports/dashboards`')).toBeNull();
    expect(normalizePath('"https://api.realworld.show/api/articles"')).toBeNull();
    expect(normalizePath('`${authHost}://realm/token`')).toBeNull();
  });

  it('rejects empty / nullish input', () => {
    expect(normalizePath(null)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
    expect(normalizePath('')).toBeNull();
    expect(normalizePath('   ')).toBeNull();
  });

  it('a one-segment route normalizes to that segment', () => {
    expect(normalizePath("'url'")).toBe('/url'); // e.g. @get('url')
    expect(normalizePath("'users'")).toBe('/users');
  });

  it('an all-placeholder path normalizes to /{var} (valid but unmatchable — the join, not normalization, treats it as unresolved)', () => {
    // A pure-variable base (`${url}`) that is not a configured host helper
    // carries no static signal. It normalizes faithfully rather than being
    // dropped here; downstream it matches no concrete route and lands in the
    // unresolved tail (validated behavior — precision stayed 96% this way).
    expect(normalizePath('`${url}`')).toBe('/{var}');
    expect(normalizePath('`${base}/${id}`')).toBe('/{var}/{var}');
  });

  it('a client call and a server route reduce to the SAME key (the join)', () => {
    const client = normalizePath('`${Config.apiBase()}/articles/${slug}/favorite`', cfg);
    const server = normalizePath("'/articles/{id}/favorite'");
    const spec = normalizePath("'/articles/:slug/favorite'");
    expect(client).toBe('/articles/{var}/favorite');
    expect(server).toBe(client);
    expect(spec).toBe(client);
  });

  it('Django/Flask angle-bracket converters canonicalize like every other param form', () => {
    // Single-segment converters (<int:pk>, <slug:s>, bare <name>) → {var},
    // joining a client's `/users/${id}`.
    expect(normalizePath("'users/<int:pk>/'")).toBe('/users/{var}');
    expect(normalizePath("'/users/<slug:the_slug>'")).toBe('/users/{var}');
    expect(normalizePath("'/users/<pk>'")).toBe('/users/{var}');
    // The <path:...> converter consumes the REST of the path → catch-all.
    expect(normalizePath("'/files/<path:subpath>'")).toBe('/files/{*}');
  });
});

describe('flow normalizeMethod', () => {
  it('upper-cases standard verbs', () => {
    expect(normalizeMethod('get')).toBe('GET');
    expect(normalizeMethod('Post')).toBe('POST');
    expect(normalizeMethod('PATCH')).toBe('PATCH');
  });

  it('applies pack-declared aliases (LoopBack del → DELETE)', () => {
    expect(normalizeMethod('del', { del: 'DELETE' })).toBe('DELETE');
  });

  it('returns null for a token that is not an HTTP verb', () => {
    expect(normalizeMethod('subscribe')).toBeNull();
    expect(normalizeMethod('del')).toBeNull(); // without the alias, `del` is not a verb
  });
});

describe('flow bindingKey', () => {
  it('joins method + path into the canonical key', () => {
    expect(bindingKey('DELETE', '/articles/{var}/favorite')).toBe(
      'DELETE /articles/{var}/favorite',
    );
  });
});
