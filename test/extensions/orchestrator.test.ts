/**
 * Extension orchestrator core: manifest discovery + the ONE runner +
 * committed snapshots (#11b lane 2).
 *
 * The runner's policy matrix is exercised through an injected exec (the
 * bounded-exec discipline — no real toolchain in unit tests): missing
 * interpreter → skipped, timeout → skipped, non-zero exit → invalid,
 * valid emit → ok + canonical stamped snapshot on disk. Manifest
 * validation covers the three path-safety guards (argument injection,
 * traversal, name aliasing) — the security posture is test-pinned, not
 * prose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';
import {
  discoverExtensions,
  isProducerExtension,
  type ProducerExtension,
} from '../../src/extensions/manifest';
import { runExtension, type ExtensionStdinPayload } from '../../src/extensions/run';
import { readExtensionSnapshot } from '../../src/extensions/snapshot';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ext-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(tmp, '.dxkit/extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2));
}

const GOOD = {
  schemaVersion: 1,
  name: 'ui-inventory',
  contributes: 'inventory',
  run: { command: 'python3', args: ['tools/extract.py'], timeoutSeconds: 60 },
  refresh: 'on-merge',
  output: '.dxkit/contrib/ui-inventory.json',
};

describe('manifest discovery', () => {
  it('returns nothing quietly when no extensions dir exists', async () => {
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('loads a valid manifest with its committed config block', async () => {
    writeManifest('ui-inventory', { ...GOOD, config: { screensDir: 'src/screens' } });
    const r = discoverExtensions(tmp);
    expect(r.errors).toEqual([]);
    expect(r.extensions).toHaveLength(1);
    expect(r.extensions[0].manifest.name).toBe('ui-inventory');
    expect(r.extensions[0].config).toEqual({ screensDir: 'src/screens' });
    expect(r.extensions[0].dir).toBe('.dxkit/extensions/ui-inventory');
  });

  it('a broken manifest is reported and never hides healthy siblings', async () => {
    writeManifest('ui-inventory', GOOD);
    writeManifest('broken', { schemaVersion: 1 });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toHaveLength(1);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('.dxkit/extensions/broken/extension.json');
  });

  it('rejects argument injection, path traversal, and name aliasing', async () => {
    writeManifest('inj', { ...GOOD, name: 'inj', run: { command: '--rm-rf' } });
    writeManifest('trav', { ...GOOD, name: 'trav', output: '../../etc/cron.json' });
    writeManifest('abs', { ...GOOD, name: 'abs', output: '/etc/cron.json' });
    writeManifest('alias', { ...GOOD, name: 'other-name' });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors).toContainEqual(expect.stringContaining('run.command'));
    expect(r.errors.filter((e) => e.includes('output')).length).toBeGreaterThanOrEqual(2);
    expect(r.errors).toContainEqual(
      expect.stringContaining('must equal the extension directory name'),
    );
  });

  it('rejects an unknown contribution kind naming the known set', async () => {
    writeManifest('bad-kind', { ...GOOD, name: 'bad-kind', contributes: 'telemetry' });
    const r = discoverExtensions(tmp);
    expect(r.errors[0]).toContain("'contract' | 'inventory' | 'findings' | 'export'");
  });
});

describe('output-path safety (S-06 — the runner owns the file it replaces)', () => {
  it('rejects an output outside .dxkit/ — package.json used to be a legal target', () => {
    writeManifest('grabby', { ...GOOD, name: 'grabby', output: 'package.json' });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors.join('\n')).toContain('.dxkit/');
  });

  it('rejects a nested non-dxkit json target too', () => {
    writeManifest('grabby2', { ...GOOD, name: 'grabby2', output: 'src/config.json' });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
  });

  it('accepts the .dxkit/contrib convention', () => {
    writeManifest('fine', { ...GOOD, name: 'fine', output: '.dxkit/contrib/fine.json' });
    const r = discoverExtensions(tmp);
    expect(r.errors).toEqual([]);
    expect(r.extensions).toHaveLength(1);
  });
});

describe('rung-4 plugin manifests', () => {
  const PLUGIN_GATHER = {
    schemaVersion: 1,
    name: 'acme-dialect',
    plugin: { module: 'plugin.js' },
  };
  const PLUGIN_PRODUCER = {
    schemaVersion: 1,
    name: 'acme-verify',
    contributes: 'findings',
    plugin: { module: 'plugin.js' },
    refresh: 'manual',
    output: '.dxkit/contrib/acme-verify.json',
  };

  it('accepts a gather-only plugin manifest (no wire kind, no snapshot)', async () => {
    writeManifest('acme-dialect', PLUGIN_GATHER);
    const r = discoverExtensions(tmp);
    expect(r.errors).toEqual([]);
    expect(r.extensions).toHaveLength(1);
    expect(isProducerExtension(r.extensions[0])).toBe(false);
  });

  it('accepts a producer plugin manifest (contributes ⇒ refresh + output)', async () => {
    writeManifest('acme-verify', PLUGIN_PRODUCER);
    const r = discoverExtensions(tmp);
    expect(r.errors).toEqual([]);
    expect(isProducerExtension(r.extensions[0])).toBe(true);
  });

  it('rejects a manifest with both run and plugin, and one with neither', async () => {
    writeManifest('both', { ...GOOD, name: 'both', plugin: { module: 'plugin.js' } });
    writeManifest('neither', { schemaVersion: 1, name: 'neither', contributes: 'findings' });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors).toContainEqual(expect.stringContaining("declares both 'run' and 'plugin'"));
    expect(r.errors).toContainEqual(expect.stringContaining('needs exactly one of'));
  });

  it('rejects unsafe plugin module paths (traversal, absolute, non-CJS)', async () => {
    writeManifest('trav', { ...PLUGIN_GATHER, name: 'trav', plugin: { module: '../../x.js' } });
    writeManifest('abs', { ...PLUGIN_GATHER, name: 'abs', plugin: { module: '/etc/x.js' } });
    writeManifest('ts', { ...PLUGIN_GATHER, name: 'ts', plugin: { module: 'plugin.ts' } });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors.filter((e) => e.includes('plugin.module'))).toHaveLength(3);
  });

  it('rejects producer fields on a gather-only plugin (silent no-ops banned)', async () => {
    writeManifest('noisy', {
      ...PLUGIN_GATHER,
      name: 'noisy',
      output: '.dxkit/contrib/noisy.json',
      gating: 'block',
    });
    const r = discoverExtensions(tmp);
    expect(r.extensions).toEqual([]);
    expect(r.errors).toContainEqual(expect.stringContaining('only applies to a producer'));
  });

  it('requires contributes with run (a rung-3 extension always emits a kind)', async () => {
    const rest: Record<string, unknown> = { ...GOOD };
    delete rest['contributes'];
    writeManifest('ui-inventory', rest);
    const r = discoverExtensions(tmp);
    expect(r.errors).toContainEqual(expect.stringContaining("required with 'run'"));
  });

  it('runner skips a gather-only plugin with a live-loading disclosure', async () => {
    writeManifest('acme-dialect', PLUGIN_GATHER);
    const r = discoverExtensions(tmp);
    const out = await runExtension(tmp, r.extensions[0]);
    expect(out.status).toBe('skipped');
    if (out.status === 'skipped') expect(out.reason).toContain('gather-only');
  });
});

function loaded(): ProducerExtension {
  writeManifest('ui-inventory', { ...GOOD, config: { a: 1 } });
  const r = discoverExtensions(tmp);
  expect(r.errors).toEqual([]);
  const ext = r.extensions[0];
  if (!isProducerExtension(ext)) throw new Error('fixture manifest must be producer-shaped');
  return ext;
}

const VALID_DOC = JSON.stringify({
  schema: 'inventory.v1',
  entities: [{ kind: 'screen', name: 'Checkout' }],
});

describe('the ONE runner (policy matrix via injected exec)', () => {
  it('missing interpreter → disclosed skip', async () => {
    const exec: CommandExec = () => ({ available: false, code: -1, output: '' });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r).toEqual({ status: 'skipped', reason: "interpreter 'python3' not found" });
  });

  it('timeout → disclosed skip naming the budget', async () => {
    const exec: CommandExec = () => ({ available: true, timedOut: true, code: -1, output: '' });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toContain('60s');
  });

  it('non-zero exit → invalid with the output tail disclosed', async () => {
    const exec: CommandExec = () => ({ available: true, code: 3, output: 'Traceback: boom' });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') {
      expect(r.errors[0]).toContain('exited 3');
      expect(r.errors[0]).toContain('boom');
    }
  });

  it('stdin payload carries the config block and canonical repo facts', async () => {
    let seen: ExtensionStdinPayload | undefined;
    const exec: CommandExec = (cmd) => {
      seen = JSON.parse(cmd.stdin ?? '{}') as ExtensionStdinPayload;
      return { available: true, code: 0, output: VALID_DOC };
    };
    await runExtension(tmp, loaded(), {
      exec,
      excludeDirs: ['node_modules', 'dist'],
      activeLanguages: ['python'],
    });
    expect(seen?.payloadVersion).toBe(1);
    expect(seen?.extension).toEqual({ name: 'ui-inventory', contributes: 'inventory' });
    expect(seen?.config).toEqual({ a: 1 });
    expect(seen?.repo.excludeDirs).toEqual(['node_modules', 'dist']);
    expect(seen?.repo.activeLanguages).toEqual(['python']);
  });

  it('valid stdout emit → ok + stamped canonical snapshot on disk', async () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: VALID_DOC });
    const now = () => new Date('2026-07-11T12:00:00Z');
    const r = await runExtension(tmp, loaded(), { exec, now });
    expect(r.status).toBe('ok');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp, '.dxkit/contrib/ui-inventory.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(onDisk['schema']).toBe('inventory.v1');
    expect(onDisk['generatedAt']).toBe('2026-07-11T12:00:00.000Z');
  });

  it('output-file emit wins over stdout, and a stale file never counts as this run', async () => {
    const outAbs = path.join(tmp, '.dxkit/contrib/ui-inventory.json');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, JSON.stringify({ schema: 'inventory.v1', entities: [] }));
    // The exec does NOT rewrite the file → the runner must not read the
    // stale pre-run file; with empty stdout the emit is missing.
    const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors[0]).toContain('neither its output file');
    // Now an exec that writes the file during the run:
    const writingExec: CommandExec = () => {
      fs.writeFileSync(
        outAbs,
        JSON.stringify({ schema: 'inventory.v1', entities: [{ kind: 'k', name: 'FromFile' }] }),
      );
      return { available: true, code: 0, output: VALID_DOC };
    };
    const r2 = await runExtension(tmp, loaded(), { exec: writingExec });
    expect(r2.status).toBe('ok');
    if (r2.status === 'ok') {
      expect(JSON.stringify(r2.doc)).toContain('FromFile');
    }
  });

  it('a FAILED refresh restores the last-known-good snapshot (S-06 — never destroy evidence)', async () => {
    const outAbs = path.join(tmp, '.dxkit/contrib/ui-inventory.json');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    const good = JSON.stringify({ schema: 'inventory.v1', entities: [], generatedAt: 'x' });
    fs.writeFileSync(outAbs, good);
    // The run fails outright — the prior snapshot must come back.
    const exec: CommandExec = () => ({ available: true, code: 1, output: 'boom' });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r.status).toBe('invalid');
    expect(fs.readFileSync(outAbs, 'utf-8')).toBe(good);
    // A timeout (skip) restores too.
    const execTimeout: CommandExec = () => ({
      available: true,
      timedOut: true,
      code: -1,
      output: '',
    });
    const r2 = await runExtension(tmp, loaded(), { exec: execTimeout });
    expect(r2.status).toBe('skipped');
    expect(fs.readFileSync(outAbs, 'utf-8')).toBe(good);
  });

  it('invalid emit → the field-precise wire errors surface verbatim', async () => {
    const exec: CommandExec = () => ({
      available: true,
      code: 0,
      output: JSON.stringify({ schema: 'inventory.v1', entities: [{ kind: 'screen' }] }),
    });
    const r = await runExtension(tmp, loaded(), { exec });
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') {
      expect(r.errors).toContainEqual(expect.stringContaining('entities[0].name'));
    }
  });
});

describe('export sinks (delivery payload + receipt)', () => {
  it('the delivery document rides stdin and the receipt round-trips', async () => {
    writeManifest('influx-sink', {
      schemaVersion: 1,
      name: 'influx-sink',
      contributes: 'export',
      run: { command: 'python3', args: ['push.py'] },
      refresh: 'manual',
      output: '.dxkit/reports/export-influx-sink.json',
    });
    const r = discoverExtensions(tmp);
    expect(r.errors).toEqual([]);
    let seenDelivery: unknown;
    const exec: CommandExec = (cmd) => {
      seenDelivery = (JSON.parse(cmd.stdin ?? '{}') as { delivery?: unknown }).delivery;
      return {
        available: true,
        code: 0,
        output: JSON.stringify({ schema: 'export.v1', delivered: true, detail: '3 rows' }),
      };
    };
    const out = await runExtension(tmp, r.extensions[0], {
      exec,
      delivery: { overall: 81, sha: 'abc' },
    });
    expect(seenDelivery).toEqual({ overall: 81, sha: 'abc' });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.schemaId).toBe('export.v1');
      expect(out.outputPath).toBe('.dxkit/reports/export-influx-sink.json');
    }
  });
});

describe('committed snapshots (the offline half)', () => {
  it('round-trips a runner-written snapshot with staleness age', async () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: VALID_DOC });
    const ext = loaded();
    await runExtension(tmp, ext, { exec, now: () => new Date('2026-07-01T00:00:00Z') });
    const snap = readExtensionSnapshot(tmp, ext, () => new Date('2026-07-11T00:00:00Z'));
    expect(snap.status).toBe('ok');
    if (snap.status === 'ok') {
      expect(snap.schemaId).toBe('inventory.v1');
      expect(snap.ageDays).toBe(10);
    }
  });

  it('missing snapshot is a disclosed state naming the expected path', async () => {
    const snap = readExtensionSnapshot(tmp, loaded());
    expect(snap).toEqual({ status: 'missing', outputPath: '.dxkit/contrib/ui-inventory.json' });
  });

  it('a hand-edited invalid snapshot is disclosed with wire errors', async () => {
    const ext = loaded();
    const outAbs = path.join(tmp, ext.manifest.output);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, JSON.stringify({ schema: 'inventory.v1' }));
    const snap = readExtensionSnapshot(tmp, ext);
    expect(snap.status).toBe('invalid');
  });
});
