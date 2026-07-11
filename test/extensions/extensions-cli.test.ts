/**
 * `vyuh-dxkit extensions` CLI (#11b lane 5): init scaffolds a manifest that
 * passes validation immediately, list surfaces snapshot health + manifest
 * errors, dev/refresh run through the ONE runner (here with the real
 * bounded exec against tiny node scripts — the cheapest real interpreter
 * in this repo's test environment).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runExtensionsCli } from '../../src/extensions-cli';
import { discoverExtensions } from '../../src/extensions/manifest';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ecli-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('extensions init', () => {
  it('scaffolds a manifest + stub that pass discovery validation', () => {
    const code = runExtensionsCli(tmp, 'init', 'ui-inventory', {
      kind: 'inventory',
      stub: true,
    });
    expect(code).toBe(0);
    const { extensions, errors } = discoverExtensions(tmp);
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0].manifest).toMatchObject({
      name: 'ui-inventory',
      contributes: 'inventory',
      refresh: 'on-merge',
      output: '.dxkit/contrib/ui-inventory.json',
    });
    expect(fs.existsSync(path.join(tmp, '.dxkit/extensions/ui-inventory/run.py'))).toBe(true);
  });

  it('findings kind gets the default warn gating in the scaffold', () => {
    runExtensionsCli(tmp, 'init', 'perm-audit', {
      kind: 'findings',
      command: 'python3 tools/audit.py',
    });
    const { extensions } = discoverExtensions(tmp);
    expect(extensions[0].manifest.gating).toBe('warn');
    expect(extensions[0].manifest.run).toMatchObject({
      command: 'python3',
      args: ['tools/audit.py'],
    });
  });

  it('rejects unknown kinds naming the registry set, and refuses to overwrite', () => {
    expect(runExtensionsCli(tmp, 'init', 'x', { kind: 'telemetry', command: 'node x' })).toBe(1);
    expect(runExtensionsCli(tmp, 'init', 'x', { kind: 'export', command: 'node x' })).toBe(0);
    expect(runExtensionsCli(tmp, 'init', 'x', { kind: 'export', command: 'node x' })).toBe(1);
  });
});

describe('extensions dev + refresh (real runner, node interpreter)', () => {
  function writeNodeExtension(name: string, script: string): void {
    const dir = path.join(tmp, '.dxkit/extensions', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        name,
        contributes: 'inventory',
        run: { command: 'node', args: [`.dxkit/extensions/${name}/run.js`], timeoutSeconds: 30 },
        refresh: 'on-merge',
        output: `.dxkit/contrib/${name}.json`,
      }),
    );
    fs.writeFileSync(path.join(dir, 'run.js'), script);
  }

  it('dev: a valid emit reports ok and writes the stamped snapshot', () => {
    writeNodeExtension(
      'screens',
      `process.stdout.write(JSON.stringify({
         schema: 'inventory.v1',
         entities: [{ kind: 'screen', name: 'Checkout' }],
       }));`,
    );
    const code = runExtensionsCli(tmp, 'dev', 'screens', {});
    expect(code).toBe(0);
    const snap = JSON.parse(
      fs.readFileSync(path.join(tmp, '.dxkit/contrib/screens.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(snap['schema']).toBe('inventory.v1');
    expect(typeof snap['generatedAt']).toBe('string');
  });

  it('dev: an invalid emit exits 1 (field-precise errors are the loop)', () => {
    writeNodeExtension(
      'broken',
      `process.stdout.write(JSON.stringify({ schema: 'inventory.v1', entities: [{ kind: 'k' }] }));`,
    );
    expect(runExtensionsCli(tmp, 'dev', 'broken', {})).toBe(1);
  });

  it('refresh: runs everything; list shows snapshot health', () => {
    writeNodeExtension(
      'screens',
      `process.stdout.write(JSON.stringify({ schema: 'inventory.v1', entities: [] }));`,
    );
    expect(runExtensionsCli(tmp, 'refresh', undefined, {})).toBe(0);
    expect(runExtensionsCli(tmp, 'list', undefined, {})).toBe(0);
    expect(runExtensionsCli(tmp, 'refresh', 'nope', {})).toBe(1);
  });

  it('refresh --land with no substantive change lands nothing (restamp-only)', () => {
    writeNodeExtension(
      'screens',
      `process.stdout.write(JSON.stringify({ schema: 'inventory.v1', entities: [] }));`,
    );
    // First refresh writes the snapshot; commit it so the second refresh's
    // restamp is the only diff.
    expect(runExtensionsCli(tmp, 'refresh', undefined, {})).toBe(0);
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'snap'], {
      cwd: tmp,
    });
    // --land push against a repo with no remote: the substance check must
    // return false (generatedAt-only diff) BEFORE any push is attempted.
    expect(runExtensionsCli(tmp, 'refresh', undefined, { land: 'push' })).toBe(0);
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmp,
      encoding: 'utf8',
    }).trim();
    expect(status).toBe('');
  });
});

describe('onboarding integration (registry-derived probe + planner)', () => {
  it('recommendExtensions + planFlowSources fire on undeclared artifacts, silent once declared', async () => {
    const { recommendExtensions, planFlowSources } = await import('../../src/discovery/advisor');
    fs.mkdirSync(path.join(tmp, 'pacts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pacts/web-api.json'), JSON.stringify({ interactions: [] }));
    execFileSync('git', ['add', '-A'], { cwd: tmp });

    const rec = recommendExtensions({ cwd: tmp });
    expect(rec?.reason).toContain('pacts/web-api.json (pact)');
    const plan = planFlowSources({ cwd: tmp });
    expect(plan?.patch).toEqual({
      flow: { sources: [{ kind: 'pact', path: 'pacts/web-api.json' }] },
    });

    // Declared → both go silent (a configured repo is never re-nagged).
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit/policy.json'),
      JSON.stringify({ flow: { sources: [{ kind: 'pact', path: 'pacts/web-api.json' }] } }),
    );
    expect(recommendExtensions({ cwd: tmp })).toBeNull();
    expect(planFlowSources({ cwd: tmp })).toBeNull();
  });
});
