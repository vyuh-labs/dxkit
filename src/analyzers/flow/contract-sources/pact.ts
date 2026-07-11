/**
 * Pact contract reader (Pact Specification v2/v3 JSON).
 *
 * A pact's `interactions[]` each carry a `request` (`method` + `path`) the
 * CONSUMER makes against the provider — so a pact always testifies to the
 * consumed side. In the consumer's repo that is literally its own calls;
 * in the PROVIDER's repo the same requests are the partner's consumed
 * calls joining against the provider's served routes — still the consumed
 * side of the join (the cross-repo flow model). Hence sides: 'consumed'
 * only; there is no reading of a pact as served evidence (a pact declares
 * expectations, not implementation).
 */

import type { ContractSourceParse, ContractSourceReader, RawConsumedCall } from './index';

interface PactInteraction {
  description?: unknown;
  request?: { method?: unknown; path?: unknown } | null;
}

export const pactReader: ContractSourceReader = {
  kind: 'pact',
  displayName: 'Pact contract',
  sides: 'consumed',
  defaultSide: 'consumed',
  sniff: (p) => /pacts?\/.*\.json$/.test(p),
  parse(content, filePath): ContractSourceParse {
    let doc: { interactions?: unknown };
    try {
      doc = JSON.parse(content) as { interactions?: unknown };
    } catch (e) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not valid JSON (${e instanceof Error ? e.message : String(e)})`],
      };
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.interactions)) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not a Pact contract (no interactions[])`],
      };
    }
    const consumed: RawConsumedCall[] = [];
    for (const i of doc.interactions as PactInteraction[]) {
      const req = i?.request;
      if (!req || typeof req !== 'object') continue;
      const method = typeof req.method === 'string' ? req.method : null;
      const path = typeof req.path === 'string' ? req.path : null;
      if (method && path) consumed.push({ method, url: path, file: filePath, line: 0 });
    }
    return { consumed, served: [], errors: [] };
  },
};
