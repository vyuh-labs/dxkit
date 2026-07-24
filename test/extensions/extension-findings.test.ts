/**
 * findings.v1 → the custom-check seam (#11b lane 4b).
 *
 * Extension findings are the seam's third consumer: they enter through the
 * ONE entry point (`gatherCustomCheckFindings`), so the baseline producer
 * and the guardrail current scan see the identical set, and the located
 * identity (check + file + lineWindow + rule) grandfathers pre-existing
 * findings exactly as lint's does. Snapshot reads only — the gate stays
 * offline; nothing here can execute an extension.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherExtensionFindings } from '../../src/extensions/extension-findings';
import { gatherCustomCheckFindings } from '../../src/analyzers/custom-checks/gather';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { identityFor } from '../../src/baseline/finding-identity';
import { trustedLocalContext } from '../../src/analysis-trust';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-extf-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeExtension(
  name: string,
  gating: 'block' | 'warn' | 'off' | undefined,
  findings: unknown[],
): void {
  const dir = path.join(tmp, '.dxkit/extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      contributes: 'findings',
      run: { command: 'python3', args: ['x.py'] },
      refresh: 'on-merge',
      output: `.dxkit/contrib/${name}.json`,
      ...(gating !== undefined ? { gating } : {}),
    }),
  );
  const out = path.join(tmp, '.dxkit/contrib', `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ schema: 'findings.v1', findings }));
}

const FINDING = {
  rule: 'unguarded-permission',
  message: 'screen lacks hasPermission()',
  severity: 'high',
  file: 'src/screens/Admin.jsx',
  line: 12,
};

describe('gatherExtensionFindings', () => {
  it('maps wire findings to located custom-check findings with gating', async () => {
    writeExtension('perm-audit', 'block', [FINDING]);
    const out = gatherExtensionFindings(tmp);
    expect(out).toEqual([
      {
        check: 'extension:perm-audit',
        blocking: true,
        file: 'src/screens/Admin.jsx',
        line: 12,
        rule: 'unguarded-permission',
        message: '[high] screen lacks hasPermission()',
      },
    ]);
  });

  it("default gating is 'warn' (non-blocking); 'off' excludes the extension", () => {
    writeExtension('warns', undefined, [FINDING]);
    writeExtension('silent', 'off', [FINDING]);
    const out = gatherExtensionFindings(tmp);
    expect(out).toHaveLength(1);
    expect(out[0].check).toBe('extension:warns');
    expect(out[0].blocking).toBe(false);
  });

  it('a missing or invalid snapshot contributes nothing (doctor owns the disclosure)', async () => {
    const dir = path.join(tmp, '.dxkit/extensions/no-snap');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'no-snap',
        contributes: 'findings',
        run: { command: 'python3' },
        refresh: 'manual',
        output: '.dxkit/contrib/no-snap.json',
      }),
    );
    expect(gatherExtensionFindings(tmp)).toEqual([]);
  });

  it('non-findings extensions are ignored by this lane', async () => {
    const dir = path.join(tmp, '.dxkit/extensions/inv');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'inv',
        contributes: 'inventory',
        run: { command: 'python3' },
        refresh: 'manual',
        output: '.dxkit/contrib/inv.json',
      }),
    );
    fs.mkdirSync(path.join(tmp, '.dxkit/contrib'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.dxkit/contrib/inv.json'),
      JSON.stringify({ schema: 'inventory.v1', entities: [] }),
    );
    expect(gatherExtensionFindings(tmp)).toEqual([]);
  });
});

describe('the seam entry point folds extensions in', () => {
  it('gatherCustomCheckFindings returns extension findings with no checks configured', async () => {
    writeExtension('perm-audit', 'block', [FINDING]);
    const out = gatherCustomCheckFindings({
      trust: trustedLocalContext(),
      cwd: tmp,
      policy: DEFAULT_BROWNFIELD_POLICY,
      packs: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].check).toBe('extension:perm-audit');
  });

  it('located identity is stable across runs and distinct per rule', async () => {
    writeExtension('perm-audit', 'warn', [FINDING, { ...FINDING, rule: 'other-rule' }]);
    const [a, b] = gatherExtensionFindings(tmp);
    const idA = identityFor({
      kind: 'custom-check',
      check: a.check,
      file: a.file,
      line: a.line,
      rule: a.rule,
    });
    const idA2 = identityFor({
      kind: 'custom-check',
      check: a.check,
      file: a.file,
      line: a.line,
      rule: a.rule,
    });
    const idB = identityFor({
      kind: 'custom-check',
      check: b.check,
      file: b.file,
      line: b.line,
      rule: b.rule,
    });
    expect(idA).toBe(idA2);
    expect(idA).not.toBe(idB);
  });
});
