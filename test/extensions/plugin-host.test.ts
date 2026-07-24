/**
 * The plugin host (#11c): loading + field-precise validation of committed
 * rung-4 plugin modules, the sdkMajor version contract, and the flow
 * overlay's trust gating (--untrusted → nothing loads, one disclosure).
 *
 * Fixtures are REAL CommonJS modules written to temp repos and loaded
 * through createRequire — the same path production takes; no mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defineExtension, SDK_MAJOR } from '@vyuhlabs/dxkit-sdk';
import { discoverExtensions } from '../../src/extensions/manifest';
import { loadFlowPluginOverlay, loadPluginDefinition } from '../../src/extensions/plugin-host';
import { trustedLocalContext, untrustedContentContext } from '../../src/analysis-trust';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-plug-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePlugin(
  name: string,
  moduleSource: string,
  manifestExtra: Record<string, unknown> = {},
): void {
  const dir = path.join(tmp, '.dxkit/extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      plugin: { module: 'plugin.js' },
      ...manifestExtra,
    }),
  );
  fs.writeFileSync(path.join(dir, 'plugin.js'), moduleSource);
}

function firstExtension(name: string) {
  const r = discoverExtensions(tmp);
  expect(r.errors).toEqual([]);
  const ext = r.extensions.find((e) => e.manifest.name === name);
  if (!ext) throw new Error(`fixture extension '${name}' not discovered`);
  return ext;
}

const DIALECT_PLUGIN = `module.exports = {
  name: 'acme-dialect',
  sdkMajor: ${SDK_MAJOR},
  httpFlowDialect: {
    pack: 'typescript',
    clientMethodCallees: { methods: ['get', 'post'], bases: ['acmeApi'] },
  },
};`;

describe('defineExtension (the SDK sugar)', () => {
  it('stamps the running SDK major and returns the definition unchanged', () => {
    const def = defineExtension({ name: 'x', urlNormalizer: () => null });
    expect(def.sdkMajor).toBe(SDK_MAJOR);
    expect(def.name).toBe('x');
  });

  it('an explicit sdkMajor wins (deliberate target declaration)', () => {
    expect(defineExtension({ name: 'x', sdkMajor: 7, urlNormalizer: () => null }).sdkMajor).toBe(7);
  });
});

describe('loadPluginDefinition', () => {
  it('loads a plain-object CommonJS plugin (no SDK runtime dependency)', () => {
    writePlugin('acme-dialect', DIALECT_PLUGIN);
    const r = loadPluginDefinition(tmp, firstExtension('acme-dialect'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.definition.httpFlowDialect?.pack).toBe('typescript');
      expect(r.disclosures).toEqual([]); // sdkMajor declared → no disclosure
    }
  });

  it('discloses a missing sdkMajor stamp without refusing', () => {
    writePlugin('no-stamp', `module.exports = { name: 'no-stamp', urlNormalizer: (u) => null };`);
    const r = loadPluginDefinition(tmp, firstExtension('no-stamp'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.disclosures).toContainEqual(expect.stringContaining('no sdkMajor declared'));
    }
  });

  it('REFUSES an sdkMajor targeting a different major, naming both', () => {
    writePlugin(
      'future',
      `module.exports = { name: 'future', sdkMajor: 999, urlNormalizer: (u) => null };`,
    );
    const r = loadPluginDefinition(tmp, firstExtension('future'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain('999');
      expect(r.errors[0]).toContain(`(${SDK_MAJOR})`);
    }
  });

  it('rejects a name mismatch (one identity with the manifest)', () => {
    writePlugin('named', `module.exports = { name: 'other', urlNormalizer: (u) => null };`);
    const r = loadPluginDefinition(tmp, firstExtension('named'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("must equal the manifest name ('named')");
  });

  it('rejects a definition with no contribution points', () => {
    writePlugin('empty', `module.exports = { name: 'empty', sdkMajor: ${SDK_MAJOR} };`);
    const r = loadPluginDefinition(tmp, firstExtension('empty'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('at least one contribution point');
  });

  it('a module that throws at load is a field-precise error, not a crash', () => {
    writePlugin('boom', `throw new Error('kaput');`);
    const r = loadPluginDefinition(tmp, firstExtension('boom'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('failed to load — kaput');
  });

  it('catches the plain-JS typo class: wrong-shaped dialect fields fail loudly', () => {
    writePlugin(
      'typo',
      `module.exports = { name: 'typo', sdkMajor: ${SDK_MAJOR},
        httpFlowDialect: { pack: 'typescript', clientCallees: 'fetch' } };`,
    );
    const r = loadPluginDefinition(tmp, firstExtension('typo'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain('httpFlowDialect.clientCallees');
      expect(r.errors[0]).toContain('wrong shape');
    }
  });

  it('discloses misspelled dialect fields and unknown definition keys', () => {
    writePlugin(
      'spell',
      `module.exports = { name: 'spell', sdkMajor: ${SDK_MAJOR},
        htmlFlowDialect: {},
        httpFlowDialect: { pack: 'typescript', clientCalles: ['fetch'] } };`,
    );
    const r = loadPluginDefinition(tmp, firstExtension('spell'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.disclosures).toContainEqual(
        expect.stringContaining("unknown key 'htmlFlowDialect'"),
      );
      expect(r.disclosures).toContainEqual(
        expect.stringContaining('httpFlowDialect.clientCalles is not an HttpFlowSupport field'),
      );
    }
  });

  it('rejects a contractReader kind colliding with a built-in reader', () => {
    writePlugin(
      'collide',
      `module.exports = { name: 'collide', sdkMajor: ${SDK_MAJOR},
        contractReader: { kind: 'postman', displayName: 'X', sides: 'consumed',
          defaultSide: 'consumed', sniff: () => false, parse: () => ({consumed: [], served: [], errors: []}) } };`,
    );
    const r = loadPluginDefinition(tmp, firstExtension('collide'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('collides with a built-in reader');
  });

  it('enforces producer ↔ contributes in both directions', () => {
    // Producer key without a declared wire kind.
    writePlugin(
      'orphan',
      `module.exports = { name: 'orphan', sdkMajor: ${SDK_MAJOR},
        findingProducer: () => ({ schema: 'findings.v1', findings: [] }) };`,
    );
    const rOrphan = loadPluginDefinition(tmp, firstExtension('orphan'));
    expect(rOrphan.ok).toBe(false);
    if (!rOrphan.ok) {
      expect(rOrphan.errors[0]).toContain("contributes: 'findings'");
    }

    // Declared wire kind without its producer.
    writePlugin(
      'hollow',
      `module.exports = { name: 'hollow', sdkMajor: ${SDK_MAJOR}, urlNormalizer: (u) => null };`,
      {
        contributes: 'inventory',
        refresh: 'manual',
        output: '.dxkit/contrib/hollow.json',
      },
    );
    const rHollow = loadPluginDefinition(tmp, firstExtension('hollow'));
    expect(rHollow.ok).toBe(false);
    if (!rHollow.ok) {
      expect(rHollow.errors[0]).toContain('inventoryProducer is missing');
    }

    // Mismatched producer key.
    writePlugin(
      'crossed',
      `module.exports = { name: 'crossed', sdkMajor: ${SDK_MAJOR},
        exporter: () => ({ schema: 'export.v1', delivered: true }) };`,
      {
        contributes: 'findings',
        refresh: 'manual',
        output: '.dxkit/contrib/crossed.json',
      },
    );
    const rCrossed = loadPluginDefinition(tmp, firstExtension('crossed'));
    expect(rCrossed.ok).toBe(false);
    if (!rCrossed.ok) {
      expect(rCrossed.errors).toContainEqual(
        expect.stringContaining("is the 'export' producer but the manifest declares"),
      );
    }
  });

  it('integrationVerifier requires findings and excludes a second producer', () => {
    writePlugin(
      'verify',
      `module.exports = { name: 'verify', sdkMajor: ${SDK_MAJOR},
        integrationVerifier: () => ({ schema: 'findings.v1', findings: [] }),
        findingProducer: () => ({ schema: 'findings.v1', findings: [] }) };`,
      { contributes: 'findings', refresh: 'manual', output: '.dxkit/contrib/verify.json' },
    );
    const r = loadPluginDefinition(tmp, firstExtension('verify'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContainEqual(expect.stringContaining('cannot both be declared'));
    }
  });

  it('cache-busts: an edited module is reloaded, not served stale', () => {
    writePlugin('evolve', DIALECT_PLUGIN.replace(/acme-dialect/g, 'evolve'));
    const first = loadPluginDefinition(tmp, firstExtension('evolve'));
    expect(first.ok).toBe(true);
    fs.writeFileSync(
      path.join(tmp, '.dxkit/extensions/evolve/plugin.js'),
      `module.exports = { name: 'evolve', sdkMajor: ${SDK_MAJOR},
        httpFlowDialect: { pack: 'python', clientCallees: ['acme_call'] } };`,
    );
    const second = loadPluginDefinition(tmp, firstExtension('evolve'));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.definition.httpFlowDialect?.pack).toBe('python');
  });
});

describe('loadFlowPluginOverlay (the gather-time trust tier)', () => {
  it('assembles dialects + readers + the composed rewriteUrl hook', () => {
    writePlugin('acme-dialect', DIALECT_PLUGIN);
    writePlugin(
      'csv-reader',
      `module.exports = { name: 'csv-reader', sdkMajor: ${SDK_MAJOR},
        contractReader: { kind: 'acme-csv', displayName: 'Acme CSV', sides: 'consumed',
          defaultSide: 'consumed', sniff: (p) => p.endsWith('.acme.csv'),
          parse: () => ({ consumed: [], served: [], errors: [] }) } };`,
    );
    writePlugin(
      'tenant-urls',
      `module.exports = { name: 'tenant-urls', sdkMajor: ${SDK_MAJOR},
        urlNormalizer: (u) => u.startsWith('tenant://') ? u.slice('tenant://'.length) : null };`,
    );
    const overlay = loadFlowPluginOverlay(tmp, trustedLocalContext());
    expect(overlay.dialects).toHaveLength(1);
    expect(overlay.readers.map((r) => r.kind)).toEqual(['acme-csv']);
    expect(overlay.rewriteUrl?.('tenant:///api/x')).toBe('/api/x');
    expect(overlay.rewriteUrl?.('/plain')).toBeNull();
    expect(overlay.disclosures).toEqual([]);
  });

  it('--untrusted loads NOTHING and discloses exactly what was skipped', () => {
    writePlugin('acme-dialect', DIALECT_PLUGIN);
    const overlay = loadFlowPluginOverlay(tmp, untrustedContentContext());
    expect(overlay.dialects).toEqual([]);
    expect(overlay.readers).toEqual([]);
    expect(overlay.rewriteUrl).toBeUndefined();
    expect(overlay.disclosures).toEqual([expect.stringContaining('acme-dialect')]);
    expect(overlay.disclosures[0]).toContain('untrusted content');
  });

  it('a broken plugin is disclosed and never hides a healthy sibling', () => {
    writePlugin('acme-dialect', DIALECT_PLUGIN);
    writePlugin('boom', `throw new Error('kaput');`);
    const overlay = loadFlowPluginOverlay(tmp, trustedLocalContext());
    expect(overlay.dialects).toHaveLength(1);
    expect(overlay.disclosures).toContainEqual(expect.stringContaining('kaput'));
  });

  it('rung-3 (run) extensions are invisible to the overlay', () => {
    const dir = path.join(tmp, '.dxkit/extensions', 'script-ext');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'script-ext',
        contributes: 'inventory',
        run: { command: 'python3', args: ['x.py'] },
        refresh: 'manual',
        output: '.dxkit/contrib/script-ext.json',
      }),
    );
    const overlay = loadFlowPluginOverlay(tmp, trustedLocalContext());
    expect(overlay).toEqual({ dialects: [], readers: [], disclosures: [] });
  });
});

describe('rung-4 producers (the in-process transport of the ONE runner)', () => {
  const FINDINGS_MANIFEST = {
    contributes: 'findings',
    refresh: 'manual',
    output: '.dxkit/contrib/perm-audit.json',
  };

  async function run(name: string) {
    const { runExtension } = await import('../../src/extensions/run');
    return runExtension(tmp, firstExtension(name), { now: () => new Date('2026-07-11T00:00:00Z') });
  }

  it('a findingProducer emits, validates, stamps, and snapshots like rung 3', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: (ctx) => ({ schema: 'findings.v1', findings: [
          { rule: 'unguarded', message: 'screen ' + ctx.name, severity: 'high', file: 'src/A.jsx', line: 3 },
        ] }) };`,
      FINDINGS_MANIFEST,
    );
    const out = await run('perm-audit');
    expect(out.status).toBe('ok');
    const snap = JSON.parse(
      fs.readFileSync(path.join(tmp, '.dxkit/contrib/perm-audit.json'), 'utf8'),
    );
    expect(snap.schema).toBe('findings.v1');
    expect(snap.generatedAt).toBe('2026-07-11T00:00:00.000Z');
    expect(snap.findings[0].message).toBe('screen perm-audit');
  });

  it('the snapshot enters the custom-check seam exactly like a rung-3 emit', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: () => ({ schema: 'findings.v1', findings: [
          { rule: 'unguarded', message: 'no guard', severity: 'high', file: 'src/A.jsx', line: 3 },
        ] }) };`,
      { ...FINDINGS_MANIFEST, gating: 'block' },
    );
    await run('perm-audit');
    const { gatherExtensionFindings } = await import('../../src/extensions/extension-findings');
    const findings = gatherExtensionFindings(tmp);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('extension:perm-audit');
    expect(findings[0].blocking).toBe(true);
  });

  it('an async producer is awaited', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: async () => ({ schema: 'findings.v1', findings: [] }) };`,
      FINDINGS_MANIFEST,
    );
    const out = await run('perm-audit');
    expect(out.status).toBe('ok');
  });

  it('a throwing producer is an invalid outcome, never a crash', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: () => { throw new Error('sideways'); } };`,
      FINDINGS_MANIFEST,
    );
    const out = await run('perm-audit');
    expect(out.status).toBe('invalid');
    if (out.status === 'invalid') expect(out.errors[0]).toContain('sideways');
  });

  it('an invalid emission gets the field-precise wire errors', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: () => ({ schema: 'findings.v1', findings: [{ rule: 'x' }] }) };`,
      FINDINGS_MANIFEST,
    );
    const out = await run('perm-audit');
    expect(out.status).toBe('invalid');
    if (out.status === 'invalid') {
      expect(out.errors.join('\n')).toContain('findings[0]');
    }
  });

  it('a hung async producer is a disclosed timeout skip (plugin.timeoutSeconds)', async () => {
    writePlugin(
      'perm-audit',
      `module.exports = { name: 'perm-audit', sdkMajor: ${SDK_MAJOR},
        findingProducer: () => new Promise(() => {}) };`,
      FINDINGS_MANIFEST,
    );
    // Tighten the bound via the plugin spec so the test stays fast.
    const manifestPath = path.join(tmp, '.dxkit/extensions/perm-audit/extension.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.plugin.timeoutSeconds = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(m));
    const out = await run('perm-audit');
    expect(out.status).toBe('skipped');
    if (out.status === 'skipped') expect(out.reason).toBe('timed out after 1s');
  }, 10_000);

  it('an exporter receives the delivery document and its receipt persists', async () => {
    writePlugin(
      'sink',
      `module.exports = { name: 'sink', sdkMajor: ${SDK_MAJOR},
        exporter: (ctx) => ({ schema: 'export.v1', delivered: true,
          detail: 'score=' + ctx.delivery.score }) };`,
      { contributes: 'export', refresh: 'manual', output: '.dxkit/reports/export-sink.json' },
    );
    const { runExtension } = await import('../../src/extensions/run');
    const out = await runExtension(tmp, firstExtension('sink'), {
      delivery: { score: 87 },
      now: () => new Date('2026-07-11T00:00:00Z'),
    });
    expect(out.status).toBe('ok');
    const receipt = JSON.parse(
      fs.readFileSync(path.join(tmp, '.dxkit/reports/export-sink.json'), 'utf8'),
    );
    expect(receipt).toMatchObject({ schema: 'export.v1', delivered: true, detail: 'score=87' });
  });

  it('an integrationVerifier receives the flow context and asserts over it', async () => {
    writePlugin(
      'contract-verify',
      `module.exports = { name: 'contract-verify', sdkMajor: ${SDK_MAJOR},
        integrationVerifier: (ctx) => ({ schema: 'findings.v1',
          findings: ctx.flow.unserved.map((c) => ({
            rule: 'unserved-call', severity: 'high',
            message: c.method + ' ' + c.url + ' has no serving route',
            file: c.file || 'unknown', ...(c.line !== undefined ? { line: c.line } : {}),
          })) }) };`,
      { contributes: 'findings', refresh: 'manual', output: '.dxkit/contrib/contract-verify.json' },
    );
    const { runExtension } = await import('../../src/extensions/run');
    const flow = {
      consumed: [{ method: 'GET', url: '/orphan', file: 'src/app.ts', line: 4 }],
      served: [],
      unserved: [{ method: 'GET', url: '/orphan', file: 'src/app.ts', line: 4 }],
    };
    const out = await runExtension(tmp, firstExtension('contract-verify'), { flow });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const doc = out.doc as { findings: Array<{ message: string }> };
      expect(doc.findings[0].message).toBe('GET /orphan has no serving route');
    }
  });

  it('a verifier without a flow context is a disclosed skip, not a lie', async () => {
    writePlugin(
      'contract-verify',
      `module.exports = { name: 'contract-verify', sdkMajor: ${SDK_MAJOR},
        integrationVerifier: () => ({ schema: 'findings.v1', findings: [] }) };`,
      { contributes: 'findings', refresh: 'manual', output: '.dxkit/contrib/contract-verify.json' },
    );
    const { runExtension } = await import('../../src/extensions/run');
    const out = await runExtension(tmp, firstExtension('contract-verify'));
    expect(out.status).toBe('skipped');
    if (out.status === 'skipped') expect(out.reason).toContain('flow model');
  });
});
