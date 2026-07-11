/**
 * OpenAPI as a registry entry — the convergence of `flow.specs` onto the
 * contract-source registry (one mechanism for every declared artifact).
 *
 * The parsing itself stays in `spec-source.ts` (the module `flow.specs`
 * has always used — Rule 2: one OpenAPI reader); this entry adapts it to
 * the reader interface so `flow.sources: [{ kind: 'openapi', ... }]` works
 * identically to the legacy `flow.specs` list, which remains supported
 * verbatim (it is frozen v1 config contract).
 */

import type { ContractSourceParse, ContractSourceReader, RawServedRoute } from './index';
import { routesFromOpenApi } from '../spec-source';

export const openapiReader: ContractSourceReader = {
  kind: 'openapi',
  displayName: 'OpenAPI document',
  sides: 'served',
  defaultSide: 'served',
  sniff: (p) => /openapi.*\.json$|swagger.*\.json$/i.test(p),
  parse(content, filePath): ContractSourceParse {
    let doc: Parameters<typeof routesFromOpenApi>[0];
    try {
      doc = JSON.parse(content) as Parameters<typeof routesFromOpenApi>[0];
    } catch (e) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not valid JSON (${e instanceof Error ? e.message : String(e)})`],
      };
    }
    if (!doc || typeof doc !== 'object' || !('paths' in doc) || !doc.paths) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not an OpenAPI document (no paths object)`],
      };
    }
    // routesFromOpenApi normalizes internally (it predates this registry);
    // re-normalizing an already-normalized path is a no-op, so routing its
    // output through the central normalization stays correct.
    const served: RawServedRoute[] = routesFromOpenApi(doc, filePath).map((r) => ({
      method: r.method,
      path: r.path,
      handler: r.handler,
      file: r.file,
      line: r.line,
    }));
    return { consumed: [], served, errors: [] };
  },
};
