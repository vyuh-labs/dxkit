/**
 * Rung-4 gather-time contributions, end-to-end through the canonical
 * surfaces (#11c): a dialect widens real tree-sitter extraction, a plugin
 * reader dispatches from flow.sources, a urlNormalizer rewrites ahead of
 * the ONE normalizer, --untrusted degrades symmetrically, and the flow
 * GATE applies one lens to both sides (a dialect-visible pre-existing call
 * can never read as net-new).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SDK_MAJOR } from '@vyuhlabs/dxkit-sdk';
import { gatherRepoFlowModel } from '../../src/analyzers/flow/gather';
import { evaluateFlowGateForGuardrail } from '../../src/baseline/flow-gate-check';
import { trustedLocalContext, untrustedContentContext } from '../../src/analysis-trust';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-plugflow-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: unknown): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

const DIALECT_PLUGIN = `module.exports = {
  name: 'acme-dialect',
  sdkMajor: ${SDK_MAJOR},
  httpFlowDialect: {
    pack: 'typescript',
    clientMethodCallees: { methods: ['fetchJson'] },
    methodAliases: { fetchjson: 'GET' },
  },
};`;

function writeDialectPlugin(): void {
  write('.dxkit/extensions/acme-dialect/extension.json', {
    schemaVersion: 1,
    name: 'acme-dialect',
    plugin: { module: 'plugin.js' },
  });
  write('.dxkit/extensions/acme-dialect/plugin.js', DIALECT_PLUGIN);
}

const APP_TS = `export async function load() {
  return api.fetchJson('/articles/1');
}
`;

describe('httpFlowDialect through real extraction', () => {
  it('a dialect-declared wrapper method becomes a consumed call', async () => {
    write('src/app.ts', APP_TS);

    const before = await gatherRepoFlowModel(tmp, {
      trust: trustedLocalContext(),
      relativeTo: tmp,
    });
    expect(before.calls).toHaveLength(0); // fetchJson is invisible without the dialect

    writeDialectPlugin();
    const after = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext(), relativeTo: tmp });
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]).toMatchObject({ method: 'GET', path: '/articles/1' });
  });

  it('--untrusted keeps the dialect out and discloses the skip', async () => {
    write('src/app.ts', APP_TS);
    writeDialectPlugin();
    const model = await gatherRepoFlowModel(tmp, {
      relativeTo: tmp,
      trust: untrustedContentContext(),
    });
    expect(model.calls).toHaveLength(0);
    expect(model.sourceDisclosures).toContainEqual(expect.stringContaining('untrusted content'));
    expect(model.sourceDisclosures?.[0]).toContain('acme-dialect');
  });

  it('a broken plugin narrows the lens with a disclosure, never a crash', async () => {
    write('src/app.ts', APP_TS);
    write('.dxkit/extensions/boom/extension.json', {
      schemaVersion: 1,
      name: 'boom',
      plugin: { module: 'plugin.js' },
    });
    write('.dxkit/extensions/boom/plugin.js', `throw new Error('kaput');`);
    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext(), relativeTo: tmp });
    expect(model.calls).toHaveLength(0);
    expect(model.sourceDisclosures).toContainEqual(expect.stringContaining('kaput'));
  });
});

describe('a plugin contractReader dispatches from flow.sources', () => {
  const READER_PLUGIN = `module.exports = {
  name: 'acme-reader',
  sdkMajor: ${SDK_MAJOR},
  contractReader: {
    kind: 'acme-csv',
    displayName: 'Acme call log',
    sides: 'consumed',
    defaultSide: 'consumed',
    sniff: (p) => p.endsWith('.acme.csv'),
    parse: (content, file) => ({
      consumed: content.trim().split('\\n').map((line, i) => {
        const [method, url] = line.split(',');
        return { method, url, file, line: i + 1 };
      }),
      served: [],
      errors: [],
    }),
  },
};`;

  it('declared artifacts of a plugin kind join the model with provenance', async () => {
    write('.dxkit/extensions/acme-reader/extension.json', {
      schemaVersion: 1,
      name: 'acme-reader',
      plugin: { module: 'plugin.js' },
    });
    write('.dxkit/extensions/acme-reader/plugin.js', READER_PLUGIN);
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'acme-csv', path: 'contracts/calls.acme.csv' }] },
    });
    write('contracts/calls.acme.csv', 'GET,/articles/1\nPOST,/comments');

    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext(), relativeTo: tmp });
    expect(model.calls).toHaveLength(2);
    expect(model.calls.map((c) => c.receiver)).toEqual(['acme-csv', 'acme-csv']);
    expect(model.calls[1]).toMatchObject({ method: 'POST', path: '/comments', line: 2 });
  });

  it('without the plugin the kind is unknown — disclosed, naming known kinds', async () => {
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'acme-csv', path: 'contracts/calls.acme.csv' }] },
    });
    write('contracts/calls.acme.csv', 'GET,/articles/1');
    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext(), relativeTo: tmp });
    expect(model.calls).toHaveLength(0);
    expect(model.sourceDisclosures).toContainEqual(
      expect.stringContaining("unknown kind 'acme-csv'"),
    );
  });
});

describe('a plugin urlNormalizer rides the ONE normalizer', () => {
  it('rewrites an internal scheme the normalizer would otherwise drop', async () => {
    write('.dxkit/extensions/svc-urls/extension.json', {
      schemaVersion: 1,
      name: 'svc-urls',
      plugin: { module: 'plugin.js' },
    });
    write(
      '.dxkit/extensions/svc-urls/plugin.js',
      `module.exports = { name: 'svc-urls', sdkMajor: ${SDK_MAJOR},
        urlNormalizer: (u) => u.startsWith('internal://svc') ? u.slice('internal://svc'.length) : null };`,
    );
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'http', path: 'requests/smoke.http' }] },
    });
    write('requests/smoke.http', 'GET internal://svc/users/42\n');

    const model = await gatherRepoFlowModel(tmp, { trust: trustedLocalContext(), relativeTo: tmp });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].path).toBe('/users/42');
  });
});

describe('the flow gate applies ONE lens to both sides', () => {
  function git(args: string[], cwd = tmp): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  }
  function initRepo(): void {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'v@v']);
    git(['config', 'user.name', 'v']);
  }
  function commitAll(msg: string): string {
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim();
  }

  const GATE_POLICY = {
    flow: {
      mode: 'block',
      sources: [{ kind: 'postman', path: 'api-docs.json', side: 'served' }],
    },
  };

  it('a pre-existing dialect-visible unserved call is grandfathered, a net-new one blocks', async () => {
    initRepo();
    // The trigger-skip reads ACTIVE packs (detection), so the fixture must
    // look like a real TS repo, not just contain .ts files.
    write('package.json', { name: 'fixture', version: '0.0.0' });
    write('tsconfig.json', {});
    write('.dxkit/policy.json', GATE_POLICY);
    write('api-docs.json', { item: [{ request: { method: 'GET', url: '/articles/:id' } }] });
    writeDialectPlugin();
    // Base: one dialect-visible call that IS served, plus one that is NOT —
    // the unserved one exists at base, so it must be grandfathered.
    write(
      'src/app.ts',
      `export const a = () => api.fetchJson('/articles/1');
export const b = () => api.fetchJson('/legacy/orphan');
`,
    );
    const baseSha = commitAll('base');

    // Unchanged tree: nothing net-new.
    const clean = await evaluateFlowGateForGuardrail({
      trust: trustedLocalContext(),
      cwd: tmp,
      baseRef: baseSha,
    });
    expect(clean.blocks).toBe(false);

    // HEAD adds a NEW dialect-visible call nothing serves → net-new block.
    write(
      'src/app.ts',
      `export const a = () => api.fetchJson('/articles/1');
export const b = () => api.fetchJson('/legacy/orphan');
export const c = () => api.fetchJson('/brand-new/call');
`,
    );
    commitAll('add unserved call');
    const dirty = await evaluateFlowGateForGuardrail({
      trust: trustedLocalContext(),
      cwd: tmp,
      baseRef: baseSha,
    });
    expect(dirty.blocks).toBe(true);
    expect(JSON.stringify(dirty)).toContain('/brand-new/call');
    expect(JSON.stringify(dirty)).not.toContain('/legacy/orphan');
  }, 30_000);

  it('--untrusted empties the lens on both sides — never a false block', async () => {
    initRepo();
    write('package.json', { name: 'fixture', version: '0.0.0' });
    write('tsconfig.json', {});
    write('.dxkit/policy.json', GATE_POLICY);
    write('api-docs.json', { item: [{ request: { method: 'GET', url: '/articles/:id' } }] });
    writeDialectPlugin();
    write('src/app.ts', APP_TS);
    const baseSha = commitAll('base');
    write(
      'src/app.ts',
      `${APP_TS}export const c = () => api.fetchJson('/brand-new/call');
`,
    );
    commitAll('add unserved call');
    const out = await evaluateFlowGateForGuardrail({
      cwd: tmp,
      baseRef: baseSha,
      trust: untrustedContentContext(),
    });
    expect(out.blocks).toBe(false);
  }, 30_000);
});

describe('every canonical flow surface applies the overlay (no half-landed lens)', () => {
  // The Tier-1 validation caught `flow extract` (the flow CLI's explicit-
  // config gather) ignoring plugins while gatherRepoFlowModel applied them —
  // the exact one-concept/two-paths class. Pin BOTH entry points.
  it('flow-cli gatherModel sees a plugin urlNormalizer', async () => {
    const { gatherModel } = await import('../../src/flow-cli');
    write('.dxkit/extensions/svc-urls/extension.json', {
      schemaVersion: 1,
      name: 'svc-urls',
      plugin: { module: 'plugin.js' },
    });
    write(
      '.dxkit/extensions/svc-urls/plugin.js',
      `module.exports = { name: 'svc-urls', sdkMajor: ${SDK_MAJOR},
        urlNormalizer: (u) => u.startsWith('internal://svc') ? u.slice('internal://svc'.length) : null };`,
    );
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'http', path: 'requests/smoke.http' }] },
    });
    write('requests/smoke.http', 'GET internal://svc/users/42\n');
    const model = await gatherModel({ cwd: tmp, trust: trustedLocalContext() });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].path).toBe('/users/42');
  });

  it("flow publish's self model sees the repo's own overlay and its declared sources", async () => {
    const { runFlowPublish } = await import('../../src/flow-contract-cli');
    const { execFileSync: exec } = await import('child_process');
    exec('git', ['init', '-q'], { cwd: tmp });
    write('.dxkit/extensions/svc-urls/extension.json', {
      schemaVersion: 1,
      name: 'svc-urls',
      plugin: { module: 'plugin.js' },
    });
    write(
      '.dxkit/extensions/svc-urls/plugin.js',
      `module.exports = { name: 'svc-urls', sdkMajor: ${SDK_MAJOR},
        urlNormalizer: (u) => u.startsWith('internal://svc') ? u.slice('internal://svc'.length) : null };`,
    );
    write('.dxkit/policy.json', {
      flow: { sources: [{ kind: 'http', path: 'requests/smoke.http' }] },
    });
    write('requests/smoke.http', 'GET internal://svc/users/42\n');
    await runFlowPublish({ trust: trustedLocalContext(), cwd: tmp, json: true });
    const consumed = JSON.parse(
      fs.readFileSync(path.join(tmp, '.dxkit/flow/consumed.json'), 'utf8'),
    ) as { bindings: Array<{ path: string }> };
    expect(consumed.bindings.map((b) => b.path)).toEqual(['/users/42']);
  });
});

describe('mergeHttpFlow (additive-only discipline)', () => {
  it('unions token lists and grouped tables without dropping pack facts', async () => {
    const { mergeHttpFlow } = await import('../../src/analyzers/flow/dialects');
    const merged = mergeHttpFlow(
      {
        clientCallees: ['fetch'],
        clientMethodCallees: { methods: ['get', 'post'], bases: ['axios'] },
        methodAliases: { del: 'DELETE' },
      },
      [
        {
          clientCallees: ['fetch', 'acmeFetch'],
          clientMethodCallees: { methods: ['request'], bases: ['acmeApi'] },
          methodAliases: { del: 'PATCH', fetchjson: 'GET' },
        },
      ],
    );
    expect(merged?.clientCallees).toEqual(['fetch', 'acmeFetch']);
    expect(merged?.clientMethodCallees).toEqual({
      methods: ['get', 'post', 'request'],
      bases: ['axios', 'acmeApi'],
    });
    // Additive-only: the pack's alias wins on conflict; new aliases join.
    expect(merged?.methodAliases).toEqual({ del: 'DELETE', fetchjson: 'GET' });
  });

  it('a dialect can bring flow to a pack that declared none', async () => {
    const { mergeHttpFlow } = await import('../../src/analyzers/flow/dialects');
    const merged = mergeHttpFlow(undefined, [{ clientCallees: ['acmeFetch'] }]);
    expect(merged?.clientCallees).toEqual(['acmeFetch']);
  });

  it('fileRoutes stays pack-only (a routing convention is not a token union)', async () => {
    const { mergeHttpFlow } = await import('../../src/analyzers/flow/dialects');
    const base = {
      fileRoutes: { handlerFile: 'route', baseDirs: ['app'], methodExports: ['GET'] },
    };
    const merged = mergeHttpFlow(base, [
      { fileRoutes: { handlerFile: 'hijack', baseDirs: ['x'], methodExports: ['POST'] } },
    ]);
    expect(merged?.fileRoutes).toEqual(base.fileRoutes);
  });
});
