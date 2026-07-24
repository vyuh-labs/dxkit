/**
 * flow.sources end-to-end: declared artifacts join the flow model through
 * the ONE canonical gather (`gatherRepoFlowModel` reads policy itself —
 * Rule 2), disclosures ride the model, and the gate's incremental skip
 * treats artifact paths as flow surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherRepoFlowModel } from '../src/analyzers/flow/gather';
import { changedFilesTouchFlowSurface } from '../src/languages';
import { trustedLocalContext } from '../src/analysis-trust';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-fsrc-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: unknown): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('flow.sources through the canonical repo gather', () => {
  it('a pact-declared call binds against a postman-served route', async () => {
    write('.dxkit/policy.json', {
      flow: {
        sources: [
          { kind: 'pact', path: 'pacts/web-api.json' },
          { kind: 'postman', path: 'api-docs.json', side: 'served' },
        ],
      },
    });
    write('pacts/web-api.json', {
      interactions: [
        { request: { method: 'GET', path: '/articles/1' } },
        { request: { method: 'GET', path: '/missing' } },
      ],
    });
    write('api-docs.json', {
      item: [{ request: { method: 'GET', url: '/articles/:id' } }],
    });

    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext() });
    expect(model.calls).toHaveLength(2);
    expect(model.routes).toHaveLength(1);
    const bound = model.bindings.filter((b) => b.route !== null);
    const unbound = model.bindings.filter((b) => b.route === null);
    expect(bound).toHaveLength(1);
    expect(bound[0].call.path).toBe('/articles/1');
    expect(bound[0].route?.via).toBe('postman');
    expect(unbound).toHaveLength(1);
    expect(unbound[0].call.path).toBe('/missing');
    expect(model.sourceDisclosures).toBeUndefined();
  });

  it('source problems are disclosed on the model, never thrown', async () => {
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'pact', path: 'pacts/nope.json' }] },
    });
    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext() });
    expect(model.sourceDisclosures).toHaveLength(1);
    expect(model.sourceDisclosures?.[0]).toContain("cannot read 'pacts/nope.json'");
  });
});

describe('the incremental gate skip treats artifacts as flow surface', () => {
  it('exact paths and basename globs match; unrelated files do not', () => {
    const sources = ['pacts/web-api.json', 'requests/*.http'];
    expect(changedFilesTouchFlowSurface(['pacts/web-api.json'], [], [], sources)).toBe(true);
    expect(changedFilesTouchFlowSurface(['requests/checkout.http'], [], [], sources)).toBe(true);
    expect(changedFilesTouchFlowSurface(['requests/deep/c.http'], [], [], sources)).toBe(false);
    expect(changedFilesTouchFlowSurface(['README.md'], [], [], sources)).toBe(false);
  });
});
