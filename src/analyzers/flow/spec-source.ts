/**
 * OpenAPI / spec served-side source — consume an existing API spec as the
 * authoritative served contract, rather than statically extracting routes.
 *
 * Build-vs-buy (CLAUDE.md Rule 5 at the served layer): where a backend ships or
 * can emit an OpenAPI document — LoopBack's `exportOpenApiSpec`, NestJS/FastAPI
 * generators, hand-maintained specs — that document is higher-fidelity than
 * decorator scraping: it is the framework's own answer, and it cannot pick up a
 * commented-out or dead route. So a spec, when present, is the PREFERRED served
 * source; static route extraction (`extract.ts`) is the fallback for backends
 * with no spec. The CONSUMED side (client calls) has no spec equivalent and is
 * always AST-extracted — a spec replaces half the problem, never the engine.
 *
 * Output is the same `RouteEndpoint` shape the static extractor produces, so the
 * join (`model.ts`) is indifferent to where a route came from. Identity-bearing
 * via the normalized path (Rule 9), so paths route through the shared normalizer
 * exactly as source-extracted ones do.
 *
 * JSON OpenAPI (2.0/3.x) today; YAML is a fast-follow (a parser dependency
 * decision). Pure over its inputs; the file read is the only I/O.
 */

import { readFileSync } from 'fs';
import type { RouteEndpoint } from './extract';
import { normalizeMethod, normalizePath, type HttpMethod } from './normalize';

const SPEC_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** A path item holds HTTP-method operations alongside non-method siblings
 *  (`parameters`, `summary`, `$ref`), so its values are loosely typed and the
 *  method entries are narrowed at read time. */
type OpenApiPathItem = Record<string, unknown>;
interface OpenApiDoc {
  paths?: Record<string, OpenApiPathItem | undefined>;
}

/**
 * Routes from a parsed OpenAPI document. Each `(path, method)` pair becomes a
 * served `RouteEndpoint` with `via: 'spec'`; the handler is the operationId when
 * present. Paths are canonicalized through the shared normalizer so they join
 * against client calls identically to source-extracted routes.
 */
export function routesFromOpenApi(doc: OpenApiDoc, sourceFile: string): RouteEndpoint[] {
  const out: RouteEndpoint[] = [];
  const paths = doc.paths ?? {};
  for (const [rawPath, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    const path = normalizePath(rawPath);
    if (!path) continue;
    for (const [rawMethod, op] of Object.entries(ops)) {
      const lower = rawMethod.toLowerCase();
      if (!SPEC_METHODS.has(lower)) continue; // skip parameters/summary/$ref siblings
      const method: HttpMethod | null = normalizeMethod(lower);
      if (!method) continue;
      const operationId = (op as { operationId?: unknown } | null)?.operationId;
      const handler = typeof operationId === 'string' ? operationId : null;
      out.push({ method, path, via: 'spec', handler, file: sourceFile, line: 0 });
    }
  }
  return out;
}

/**
 * Read + parse a JSON OpenAPI document into served routes. Returns `[]` (never
 * throws) when the file is unreadable or not valid JSON OpenAPI — a missing or
 * broken spec degrades to the static fallback, it does not fail the run.
 */
export function loadOpenApiRoutes(filePath: string): RouteEndpoint[] {
  let doc: OpenApiDoc;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8')) as OpenApiDoc;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object' || !doc.paths) return [];
  return routesFromOpenApi(doc, filePath);
}
