/**
 * Postman Collection reader (v2.x JSON export).
 *
 * A collection is a tree: `item[]` entries are either folders (their own
 * `item[]`) or requests (`request.method` + `request.url`). The url may be
 * the string form or the object form (`{ raw, path[] }`); `raw` wins when
 * present because it preserves `{{variable}}` segments, which the shared
 * normalizer's template collapse reduces to `{var}` — a Postman variable
 * IS a path parameter for join purposes (after `{{host}}`-style heads are
 * stripped via flow.stripUrlPrefixes or rejected as external).
 *
 * Sides: 'both'. The common case is a collection of calls a team MAKES
 * (consumed, the default); a collection documenting the repo's OWN API is
 * declared `side: 'served'` and each request reads as a served route.
 */

import type { ContractSourceParse, ContractSourceReader, RawConsumedCall } from './index';

interface PostmanUrl {
  raw?: unknown;
  path?: unknown;
}
interface PostmanItem {
  name?: unknown;
  item?: unknown;
  request?: { method?: unknown; url?: unknown } | null;
}

function urlText(url: unknown): string | null {
  if (typeof url === 'string' && url.length > 0) return url;
  if (typeof url === 'object' && url !== null) {
    const u = url as PostmanUrl;
    if (typeof u.raw === 'string' && u.raw.length > 0) return u.raw;
    if (Array.isArray(u.path)) {
      const segs = u.path.filter((s): s is string => typeof s === 'string');
      if (segs.length > 0) return `/${segs.join('/')}`;
    }
  }
  return null;
}

function walkItems(items: unknown, file: string, out: RawConsumedCall[]): void {
  if (!Array.isArray(items)) return;
  for (const entry of items as PostmanItem[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.item) walkItems(entry.item, file, out);
    const req = entry.request;
    if (req && typeof req === 'object') {
      const method = typeof req.method === 'string' ? req.method : 'GET';
      const url = urlText(req.url);
      if (url) out.push({ method, url, file, line: 0 });
    }
  }
}

export const postmanReader: ContractSourceReader = {
  kind: 'postman',
  displayName: 'Postman collection',
  sides: 'both',
  defaultSide: 'consumed',
  sniff: (p) => p.endsWith('.postman_collection.json'),
  parse(content, filePath): ContractSourceParse {
    let doc: { item?: unknown };
    try {
      doc = JSON.parse(content) as { item?: unknown };
    } catch (e) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not valid JSON (${e instanceof Error ? e.message : String(e)})`],
      };
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.item)) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not a Postman collection (no item[] tree)`],
      };
    }
    const consumed: RawConsumedCall[] = [];
    walkItems(doc.item, filePath, consumed);
    return { consumed, served: [], errors: [] };
  },
};
