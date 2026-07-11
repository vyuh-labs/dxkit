/**
 * CONTRACT_SOURCE_READERS — declared contract artifacts (#11b lane 3).
 *
 * Layers: per-reader parsing fixtures (each format's canonical shape and
 * its failure modes), the registry contract, central-load behavior
 * (side legality, glob expansion, external-URL disclosure, provenance),
 * and the synthetic-reader playbook proving a new format is one registry
 * entry (mirror of recipe-playbook — the check that the architecture
 * stayed registry-driven).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CONTRACT_SOURCE_READERS,
  contractSourceReaderFor,
  loadContractSources,
  type ContractSourceReader,
} from '../src/analyzers/flow/contract-sources';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-src-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: unknown): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('registry contract', () => {
  it('kinds are unique and defaultSide is always legal', () => {
    const kinds = CONTRACT_SOURCE_READERS.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const r of CONTRACT_SOURCE_READERS) {
      if (r.sides !== 'both') expect(r.defaultSide).toBe(r.sides);
      expect(typeof r.sniff('anything')).toBe('boolean');
    }
  });

  it('ships the five launch formats', () => {
    expect(CONTRACT_SOURCE_READERS.map((r) => r.kind).sort()).toEqual([
      'har',
      'http',
      'openapi',
      'pact',
      'postman',
    ]);
  });
});

describe('postman reader', () => {
  it('walks nested folders and both url forms; {{vars}} become {var}', () => {
    write('col.json', {
      info: { name: 'c' },
      item: [
        {
          name: 'folder',
          item: [
            { name: 'r1', request: { method: 'POST', url: '{{base}}/articles/{{slug}}' } },
            { name: 'r2', request: { method: 'GET', url: { raw: '/tags' } } },
          ],
        },
        { name: 'r3', request: { method: 'DELETE', url: { path: ['articles', ':id'] } } },
      ],
    });
    const r = loadContractSources(tmp, [{ kind: 'postman', path: 'col.json' }], {});
    expect(r.disclosures).toEqual([]);
    const keys = r.calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(keys).toEqual(['DELETE /articles/{var}', 'GET /tags', 'POST /{var}/articles/{var}']);
    expect(r.calls.every((c) => c.receiver === 'postman')).toBe(true);
  });

  it("side: 'served' reads the collection as the repo's own API", () => {
    write('col.json', {
      item: [{ request: { method: 'GET', url: '/things/:id' } }],
    });
    const r = loadContractSources(tmp, [{ kind: 'postman', path: 'col.json', side: 'served' }], {});
    expect(r.calls).toEqual([]);
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ method: 'GET', path: '/things/{var}', via: 'postman' });
  });

  it('a non-collection is a disclosed parse error', () => {
    write('col.json', { nope: true });
    const r = loadContractSources(tmp, [{ kind: 'postman', path: 'col.json' }], {});
    expect(r.disclosures[0]).toContain('not a Postman collection');
  });
});

describe('pact reader', () => {
  it('interactions become consumed calls; served declaration is refused', () => {
    write('pacts/web-api.json', {
      consumer: { name: 'web' },
      provider: { name: 'api' },
      interactions: [
        { description: 'list', request: { method: 'GET', path: '/articles' } },
        { description: 'del', request: { method: 'DELETE', path: '/articles/1' } },
      ],
    });
    const ok = loadContractSources(tmp, [{ kind: 'pact', path: 'pacts/web-api.json' }], {});
    expect(ok.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /articles',
      'DELETE /articles/1',
    ]);
    const refused = loadContractSources(
      tmp,
      [{ kind: 'pact', path: 'pacts/web-api.json', side: 'served' }],
      {},
    );
    expect(refused.routes).toEqual([]);
    expect(refused.disclosures[0]).toContain("'consumed' side only");
  });
});

describe('.http reader', () => {
  it('parses request lines with REAL line numbers, ignoring comments/bodies', () => {
    write(
      'requests/checkout.http',
      [
        '### create',
        'POST {{host}}/api/orders HTTP/1.1',
        'Content-Type: application/json',
        '',
        '{"total": 1}',
        '',
        '### fetch',
        'GET /api/orders/42',
      ].join('\n'),
    );
    const r = loadContractSources(tmp, [{ kind: 'http', path: 'requests/*.http' }], {});
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toMatchObject({ method: 'POST', path: '/{var}/api/orders', line: 2 });
    expect(r.calls[1]).toMatchObject({ method: 'GET', path: '/api/orders/42', line: 8 });
  });

  it('glob expansion is basename-only and misses are disclosed', () => {
    write('requests/a.http', 'GET /a');
    write('requests/b.http', 'GET /b');
    write('requests/deep/c.http', 'GET /c');
    const r = loadContractSources(tmp, [{ kind: 'http', path: 'requests/*.http' }], {});
    expect(r.calls.map((c) => c.path).sort()).toEqual(['/a', '/b']);
    const miss = loadContractSources(tmp, [{ kind: 'http', path: 'nowhere/*.http' }], {});
    expect(miss.disclosures[0]).toContain("no file matches 'nowhere/*.http'");
  });
});

describe('har reader', () => {
  it('own-host entries join via stripUrlPrefixes; externals are counted, not silent', () => {
    write('session.har', {
      log: {
        entries: [
          { request: { method: 'GET', url: 'https://api.example.com/articles?page=2' } },
          { request: { method: 'POST', url: 'https://api.example.com/articles' } },
          { request: { method: 'GET', url: 'https://analytics.vendor.io/beacon' } },
        ],
      },
    });
    const r = loadContractSources(tmp, [{ kind: 'har', path: 'session.har' }], {
      stripUrlPrefixes: ['https://api.example.com'],
    });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /articles',
      'POST /articles',
    ]);
    expect(r.disclosures).toHaveLength(1);
    expect(r.disclosures[0]).toContain('1 entry dropped');
    expect(r.disclosures[0]).toContain('flow.stripUrlPrefixes');
  });
});

describe('openapi registry entry', () => {
  it('serves routes with via openapi through the same central load', () => {
    write('api/openapi.json', {
      openapi: '3.0.0',
      paths: {
        '/articles/{slug}': { get: { operationId: 'getArticle' }, parameters: [] },
      },
    });
    const r = loadContractSources(tmp, [{ kind: 'openapi', path: 'api/openapi.json' }], {});
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({
      method: 'GET',
      path: '/articles/{var}',
      handler: 'getArticle',
      via: 'openapi',
    });
  });
});

describe('central-load discipline', () => {
  it('unknown kind is a loud disclosure naming the known kinds', () => {
    const r = loadContractSources(tmp, [{ kind: 'wsdl', path: 'x.wsdl' }], {});
    expect(r.disclosures[0]).toContain("unknown kind 'wsdl'");
    for (const k of ['openapi', 'postman', 'pact', 'http', 'har']) {
      expect(r.disclosures[0]).toContain(`'${k}'`);
    }
  });

  it('an invalid side value is disclosed and the entry skipped', () => {
    write('col.json', { item: [] });
    const r = loadContractSources(tmp, [{ kind: 'postman', path: 'col.json', side: 'both' }], {});
    expect(r.disclosures[0]).toContain("side must be 'consumed' or 'served'");
  });
});

describe('synthetic-reader playbook (formats stay registry entries)', () => {
  it('an injected format flows through load, provenance, and the known-kind list', () => {
    const wsdl: ContractSourceReader = {
      kind: 'wsdl',
      displayName: 'WSDL document',
      sides: 'served',
      defaultSide: 'served',
      sniff: (p) => p.endsWith('.wsdl'),
      parse: (_content, filePath) => ({
        consumed: [],
        served: [{ method: 'POST', path: '/soap/checkout', file: filePath, line: 0 }],
        errors: [],
      }),
    };
    const registry = [...CONTRACT_SOURCE_READERS, wsdl];
    write('svc.wsdl', '<definitions/>');

    const r = loadContractSources(tmp, [{ kind: 'wsdl', path: 'svc.wsdl' }], {}, registry);
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ method: 'POST', path: '/soap/checkout', via: 'wsdl' });

    expect(contractSourceReaderFor('wsdl', registry)).toBe(wsdl);
    const unknown = loadContractSources(tmp, [{ kind: 'nope', path: 'x' }], {}, registry);
    expect(unknown.disclosures[0]).toContain("'wsdl'");
  });
});
