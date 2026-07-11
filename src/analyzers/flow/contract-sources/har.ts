/**
 * HAR reader (HTTP Archive 1.2 — a browser/proxy capture).
 *
 * `log.entries[].request` carries `method` + an ABSOLUTE `url`; a capture
 * is real observed traffic, so it is high-recall and host-noisy. The
 * shared normalizer rejects absolute URLs to hosts not covered by
 * `flow.stripUrlPrefixes` — declaring your own API host there is what
 * turns a capture into joinable route paths, and the load discloses how
 * many entries were dropped as external (analytics beacons, CDNs).
 *
 * Sides: 'consumed' only — a capture is calls something made.
 */

import type { ContractSourceParse, ContractSourceReader, RawConsumedCall } from './index';

interface HarEntry {
  request?: { method?: unknown; url?: unknown } | null;
}

export const harReader: ContractSourceReader = {
  kind: 'har',
  displayName: 'HAR capture',
  sides: 'consumed',
  defaultSide: 'consumed',
  sniff: (p) => p.endsWith('.har'),
  parse(content, filePath): ContractSourceParse {
    let doc: { log?: { entries?: unknown } };
    try {
      doc = JSON.parse(content) as { log?: { entries?: unknown } };
    } catch (e) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not valid JSON (${e instanceof Error ? e.message : String(e)})`],
      };
    }
    const entries = doc?.log?.entries;
    if (!Array.isArray(entries)) {
      return {
        consumed: [],
        served: [],
        errors: [`${filePath}: not a HAR document (no log.entries[])`],
      };
    }
    const consumed: RawConsumedCall[] = [];
    for (const e of entries as HarEntry[]) {
      const req = e?.request;
      if (!req || typeof req !== 'object') continue;
      const method = typeof req.method === 'string' ? req.method : null;
      const url = typeof req.url === 'string' ? req.url : null;
      if (method && url) consumed.push({ method, url, file: filePath, line: 0 });
    }
    return { consumed, served: [], errors: [] };
  },
};
