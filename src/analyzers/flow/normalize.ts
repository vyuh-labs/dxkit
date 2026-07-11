/**
 * URL / route-path normalization — the canonical, pure transform that lets a
 * frontend client call and a backend route declaration JOIN even though they
 * are written differently. It is the precision-critical core of the flow
 * feature: this algorithm was validated at 96% precision (vs ~84% for a regex
 * approach) on a real axios → LoopBack stack — the win comes from being
 * structural rather than regex-mangled.
 *
 * The contract: turn a raw URL/route literal into a canonical path string in
 * which path parameters are erased to `{var}` and host/prefix noise is gone,
 * so `axios.get(`${Config.apiBase()}/articles/${slug}`)` (client) and
 * `@get('/articles/{id}')` (server) both reduce to `/articles/{var}` and
 * match. Method normalization (`del` → `DELETE`) lives here too.
 *
 * Two inputs are deliberately NOT baked in as language facts (CLAUDE.md
 * Rule 6 boundary):
 *   - **Host helpers** (`${Config.apiBase()}`, `${apiUrl}`) are per-APP, not
 *     per-language — they arrive via `NormalizeConfig.stripUrlPrefixes`
 *     (sourced from `.dxkit/policy.json:flow.stripUrlPrefixes`).
 *   - **Param-form canonicalization** (`:id`, `{id}`, `${x}` → `{var}`) is
 *     uniform across frameworks, so it lives here rather than in a per-pack
 *     descriptor.
 *
 * Pure: no I/O, deterministic over its inputs. Identity-bearing (a binding's
 * Rule 9 fingerprint is computed from the normalized path), so changes here
 * are a normalization-scheme change — treat with the same care as a
 * fingerprint-scheme bump.
 */

/** Canonical HTTP verbs the flow feature recognizes. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * The method-agnostic marker for a SERVED route declared without a verb.
 * Several routing layers genuinely bind a path to a handler for EVERY method —
 * Django's `path('users/', view)`, Go's `http.HandleFunc("/x", h)`, Rails'
 * `match` — and dispatch (or 405) by method INSIDE the handler. Flow models the
 * routing layer, so such a declaration is one `ANY` route: a consumed call with
 * any verb on that path resolves against it (see `servedMatch` / `joinFlow` in
 * `model.ts`). Only served routes ever carry it — a client call always has a
 * concrete verb. On the wire (`served.json`) it serializes as the method string
 * `"ANY"`, additive on schema v1.
 */
export const ANY_METHOD = 'ANY';

/** A served route's method: a concrete verb, or the method-agnostic marker. */
export type ServedMethod = HttpMethod | typeof ANY_METHOD;

/** Per-app normalization inputs (not language facts — see module header). */
export interface NormalizeConfig {
  /**
   * Host-helper / base-URL prefixes to strip before matching, so a client
   * call's absolute-ish URL reduces to the bare route path. Each entry is a
   * literal substring removed wherever it appears at the head of the URL —
   * e.g. `['${Config.apiBase()}', '${apiUrl}']`. Sourced from
   * `.dxkit/policy.json:flow.stripUrlPrefixes`; `flow init` auto-suggests the
   * dominant host-helper found across client calls.
   */
  stripUrlPrefixes?: readonly string[];
}

const PLACEHOLDER = '{var}';

/**
 * The canonical CATCH-ALL / splat marker — a trailing wildcard that serves
 * every path under its static prefix (Next.js `[...slug]`, Express `/*`, Spring
 * `/**`, Rails `/*path`, FastAPI/Starlette `{p:path}` all reduce to this). It is
 * distinct from `{var}` (a single dynamic segment) because the JOIN treats it
 * differently: a `{var}` matches exactly one segment on the exact key, a `{*}`
 * prefix-matches any depth (see `catchAllStaticPrefix` + the join in `model.ts`).
 * Only served routes ever carry it — a client call targets a concrete path.
 */
export const CATCHALL = '{*}';

/** Does a normalized route path end in the catch-all marker (a prefix matcher)? */
export function isCatchAllPath(path: string): boolean {
  return path === '/' + CATCHALL || path.endsWith('/' + CATCHALL);
}

/**
 * The static prefix a catch-all route serves — the path with its trailing
 * `/{*}` removed. `/api/{*}` → `/api` (serves `/api/anything`); a root catch-all
 * `/{*}` → `''` (serves everything). Used by the join to prefix-match a concrete
 * client call against a wildcard route.
 */
export function catchAllStaticPrefix(path: string): string {
  if (path === '/' + CATCHALL) return '';
  return path.slice(0, -('/' + CATCHALL).length);
}

/**
 * Canonicalize a raw URL / route literal to a comparable path, or `null` for
 * an external absolute URL or empty / non-path input. A path that is entirely
 * dynamic (`${x}`) normalizes faithfully to `/{var}` rather than being
 * dropped here — the join (not this function) treats an all-placeholder path
 * as unresolved (validated: precision held at 96% with this split).
 *
 * `raw` is the literal text as it appears in source, including any
 * surrounding quotes/backticks (the extractor passes the node text verbatim).
 *
 * Steps (order matters):
 *  1. strip surrounding quotes / backticks;
 *  2. strip configured host-helper prefixes;
 *  3. reject external absolute URLs (`http(s)://…`, `${host}://…`) → `null`
 *     (a call to a host we don't serve is not an internal route binding);
 *  4. collapse template expressions `${…}` → `{var}`;
 *  5. drop the query string (`?…`) — query params don't distinguish a route;
 *  6. canonicalize path params `:id` and `{id}` → `{var}`;
 *  7. ensure a single leading slash (LoopBack allows `@post('zen/x')`);
 *  8. drop a trailing slash;
 *  9. require a real path head (`/letter` or `/{var}`), else `null`.
 */
export function normalizePath(
  raw: string | null | undefined,
  config?: NormalizeConfig,
): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  // 1. surrounding quotes / backticks
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"' || s[0] === '`') && s[s.length - 1] === s[0]) {
    s = s.slice(1, -1);
  }

  // 2. host-helper prefixes (longest first, so a more specific prefix wins)
  for (const prefix of [...(config?.stripUrlPrefixes ?? [])].sort((a, b) => b.length - a.length)) {
    if (prefix && s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
    // also strip when embedded at the head inside a template, e.g. a leading
    // `${Config.apiBase()}` not at index 0 due to whitespace — rare; handled by
    // a single replace of the first occurrence.
    if (prefix && s.includes(prefix)) {
      s = s.replace(prefix, '');
      break;
    }
  }

  // 3. external absolute URL (not one of our host helpers) → not internal
  if (/^https?:\/\//i.test(s) || /^\$\{[^}]*\}:\/\//.test(s)) return null;

  // 4. template expressions → placeholder
  s = s.replace(/\$\{[^}]*\}/g, PLACEHOLDER);

  // 5. drop query string
  const q = s.indexOf('?');
  if (q !== -1) s = s.slice(0, q);

  // 6a. catch-all / splat forms → the {*} marker (a prefix matcher). Must run
  //     BEFORE the single-segment collapse below so FastAPI's `{p:path}` and
  //     Next.js `[...slug]` do not degrade to a one-segment `{var}`.
  s = s.replace(/\{[A-Za-z0-9_]+:path\}/g, CATCHALL); // FastAPI/Starlette {file_path:path}
  s = s.replace(/<path:[A-Za-z0-9_]+>/g, CATCHALL); // Django/Flask <path:rest> (rest-of-path)
  s = s.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, CATCHALL); // Next.js [...slug] / [[...slug]]
  s = s.replace(/\*\*/g, CATCHALL); // Spring /**
  s = s.replace(/(?<=\/)\*[A-Za-z0-9_]*/g, CATCHALL); // Express /*, Rails /*path

  // 6b. canonicalize single-segment path params (leaving the {*} marker intact).
  //     The single `[id]` rule runs AFTER the catch-all `[...slug]` rule above so
  //     a catch-all is not misconsumed as a one-segment param.
  s = s.replace(/:[A-Za-z0-9_]+/g, PLACEHOLDER); // Express/Rails :id
  s = s.replace(/\[[^\]]+\]/g, PLACEHOLDER); // Next.js file-route [id]
  s = s.replace(/<[^>]+>/g, PLACEHOLDER); // Django/Flask <int:pk>, <slug:s>, <name>
  s = s.replace(/\{[^}]*\}/g, (m) => (m === CATCHALL ? CATCHALL : PLACEHOLDER)); // {id}, keep {*}

  // 7. single leading slash
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/'); // collapse accidental doubles after prefix strip

  // 8. trailing slash
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);

  // 9. require a real path head (a literal, a single-segment {var}, or a catch-all {*})
  if (!/^\/([A-Za-z]|\{var\}|\{\*\})/.test(s)) return null;
  return s;
}

/**
 * Canonicalize a matched method token (a decorator name like `get`, or a
 * client/router member like `post`) to an uppercase {@link HttpMethod}.
 * `aliases` carries pack-declared exceptions (LoopBack's `del` → `DELETE`);
 * everything else upper-cases. Returns `null` for a token that doesn't map to
 * a known verb.
 */
export function normalizeMethod(
  token: string,
  aliases?: Readonly<Record<string, string>>,
): HttpMethod | null {
  const lower = token.toLowerCase();
  const mapped = (aliases?.[lower] ?? lower).toUpperCase();
  return isHttpMethod(mapped) ? mapped : null;
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

function isHttpMethod(s: string): s is HttpMethod {
  return HTTP_METHODS.has(s);
}

/** A normalized binding key `"<METHOD> <path>"` — the join key + identity input. */
export function bindingKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}
