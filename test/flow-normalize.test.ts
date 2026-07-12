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

  it('the ROOT route: a slash-headed "/" is a real endpoint; a synthetic "/" is not', () => {
    // @GetMapping("/"), app.get('/'), @app.get("/") all declare the root.
    expect(normalizePath('"/"')).toBe('/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('"//"')).toBe('/');
    // A query-only relative URL or a fully-stripped host helper reduces to
    // "/" only synthetically — still not a route.
    expect(normalizePath('"?page=2"')).toBeNull();
    expect(normalizePath('`${Config.apiBase()}`', cfg)).toBeNull();
  });

  it('canonicalizes Ruby string interpolation (#{…}) to {var}', () => {
    expect(normalizePath('"/items/#{id}"')).toBe('/items/{var}');
    expect(normalizePath('"/users/#{user.id}/posts/#{post_id}"')).toBe('/users/{var}/posts/{var}');
    // A fully dynamic base stays faithful (the join treats it as unresolved).
    expect(normalizePath('"#{base_url}/items"')).toBe('/{var}/items');
  });

  it('canonicalizes Kotlin brace-less template vars ($id) to {var}', () => {
    expect(normalizePath('"/users/$id"')).toBe('/users/{var}');
    expect(normalizePath('"/users/$id/posts/$postId"')).toBe('/users/{var}/posts/{var}');
    // Braced and brace-less forms coexist without a stray token.
    expect(normalizePath('"/users/${user.id}/tags/$tag"')).toBe('/users/{var}/tags/{var}');
    // A bare `$` with no identifier head is untouched (Go's `{$}` rule is 6a's).
    expect(normalizePath('/exact/{$}')).toBe('/exact');
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

  it('Go 1.22 pattern forms canonicalize: {rest...} → catch-all, {$} is not a segment', () => {
    expect(normalizePath("'/files/{p...}'")).toBe('/files/{*}');
    expect(normalizePath("'/items/{id}'")).toBe('/items/{var}');
    // `{$}` means "match exactly here" — it is a matching directive, not a
    // path segment, so it must not survive as a phantom {var}.
    expect(normalizePath("'/items/{$}'")).toBe('/items');
  });

  it('Rust tail-match forms canonicalize to the catch-all', () => {
    // actix {key}* and {tail:.*} both serve everything under their prefix;
    // Rocket's <path..> is the segments-tail form. All three are prefix
    // matchers — a single-segment {var} would under-match them.
    expect(normalizePath('"/file/{s3_key}*"')).toBe('/file/{*}');
    expect(normalizePath('"/static/{tail:.*}"')).toBe('/static/{*}');
    expect(normalizePath('"/page/<path..>"')).toBe('/page/{*}');
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

describe('the rewriteUrl hook (rung-4 urlNormalizer seam)', () => {
  it('a rewritten URL flows through the whole canonical pipeline', () => {
    const rewriteUrl = (u: string): string | null =>
      u.startsWith('internal://svc') ? u.slice('internal://svc'.length) : null;
    expect(normalizePath("'internal://svc/users/:id'", { rewriteUrl })).toBe('/users/{var}');
  });

  it('null means no opinion — standard handling continues on the original', () => {
    expect(normalizePath("'/plain/path'", { rewriteUrl: () => null })).toBe('/plain/path');
  });

  it('a throwing hook is a no-opinion, never a crash', () => {
    const rewriteUrl = (): string | null => {
      throw new Error('boom');
    };
    expect(normalizePath("'/still/works'", { rewriteUrl })).toBe('/still/works');
  });

  it('the hook cannot bypass normalization — an external rewrite still drops', () => {
    expect(normalizePath("'/x'", { rewriteUrl: () => 'https://evil.example.com/x' })).toBeNull();
  });

  it('composes with stripUrlPrefixes (hook first, then prefixes)', () => {
    expect(
      normalizePath('`${tenantBase()}/orders/${id}`', {
        rewriteUrl: (u) =>
          u.startsWith('${tenantBase()}') ? u.replace('${tenantBase()}', '') : null,
      }),
    ).toBe('/orders/{var}');
  });
});
