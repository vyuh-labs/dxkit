import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildIdentityRemap,
  baselineEntryToIdentityInput,
  migrateIdentity,
} from '../../src/baseline/migrate';
import { identityFor } from '../../src/baseline/finding-identity';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import {
  loadAllowlist,
  saveAllowlist,
  emptyAllowlistFile,
  addEntry,
} from '../../src/allowlist/file';
import { pathForBaseline } from '../../src/baseline/baseline-file';
import type { BaselineEntry } from '../../src/baseline/types';
import { trustedLocalContext } from '../../src/analysis-trust';

describe('buildIdentityRemap (pure)', () => {
  it('maps a changed kind (code) old→new when its id differs', () => {
    const entry: BaselineEntry = {
      id: 'newcontentid00000',
      kind: 'code',
      tool: 'semgrep',
      rule: 'r',
      file: 'a.ts',
      line: 10,
    };
    const remap = buildIdentityRemap([entry], 'v1');
    const v1 = identityFor(
      { kind: 'code', tool: 'semgrep', rule: 'r', file: 'a.ts', line: 10 },
      'v1',
    );
    expect(remap.get(v1)).toBe('newcontentid00000');
  });

  it('does not map version-independent kinds (id unchanged across schemes)', () => {
    const id = identityFor({ kind: 'test-gap', file: 'a.ts', risk: 'high' }, 'v2');
    const entry: BaselineEntry = { id, kind: 'test-gap', file: 'a.ts', risk: 'high' };
    expect(buildIdentityRemap([entry], 'v1').size).toBe(0);
  });

  it('maps dep-vuln (installed-version v1 → version-independent v2)', () => {
    const entry: BaselineEntry = {
      id: 'depv2id0000000000',
      kind: 'dep-vuln',
      package: 'lodash',
      installedVersion: '4.17.20',
      advisoryId: 'GHSA-x',
    };
    const remap = buildIdentityRemap([entry], 'v1');
    const v1 = identityFor(
      { kind: 'dep-vuln', package: 'lodash', installedVersion: '4.17.20', id: 'GHSA-x' },
      'v1',
    );
    expect(remap.get(v1)).toBe('depv2id0000000000');
  });

  it('skips sanitized entries (no metadata to recompute)', () => {
    const entry: BaselineEntry = { id: 'x', kind: 'code', sanitized: true };
    expect(baselineEntryToIdentityInput(entry)).toBeUndefined();
    expect(buildIdentityRemap([entry], 'v1').size).toBe(0);
  });
});

// End-to-end: a v1 allowlist entry is carried onto v2 and the guardrail
// works afterward — the whole point of the migrator.
describe('migrateIdentity (end-to-end)', () => {
  let dir: string;
  let savedSalt: string | undefined;

  beforeAll(() => {
    savedSalt = process.env.DXKIT_BASELINE_SALT;
    process.env.DXKIT_BASELINE_SALT = 'migrate-fixed-salt';
  });
  afterAll(() => {
    if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
    else process.env.DXKIT_BASELINE_SALT = savedSalt;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-migrate-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'config.ts'), 'const password = "s3cr3t-fixture-not-real";\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('remaps a v1 allowlist entry onto v2 and leaves the guardrail working', async () => {
    // Baseline once to discover the secret finding's metadata + v2 id.
    await createBaseline({ cwd: dir });
    const blPath = pathForBaseline(dir, 'main');
    const baseline = JSON.parse(readFileSync(blPath, 'utf8'));
    const secret = baseline.findings.find((f: { kind: string }) => f.kind === 'secret');
    expect(secret).toBeTruthy();

    // The pre-migration (v1) fingerprint the user's old allowlist would carry.
    const v1Fp = identityFor(
      {
        kind: 'secret',
        tool: secret.tool,
        rule: secret.rule,
        file: secret.file,
        line: secret.line,
      },
      'v1',
    );
    expect(v1Fp).not.toBe(secret.id); // the scheme genuinely changed this finding's id

    // Simulate a pre-2.11 repo: allowlist keyed on the v1 fingerprint +
    // both artifacts stamped v1.
    saveAllowlist(
      dir,
      addEntry(emptyAllowlistFile('full'), {
        fingerprint: v1Fp,
        kind: 'secret',
        category: 'false-positive',
        reason: 'fixture',
        addedBy: 't@t.t',
        addedAt: '2026-06-16',
      }),
    );
    // Force the allowlist + baseline back to v1.
    const al = JSON.parse(readFileSync(join(dir, '.dxkit', 'allowlist.json'), 'utf8'));
    al.identityScheme = 'v1';
    writeFileSync(join(dir, '.dxkit', 'allowlist.json'), JSON.stringify(al, null, 2));
    baseline.identityScheme = 'v1';
    writeFileSync(blPath, JSON.stringify(baseline, null, 2));

    // Migrate.
    const result = await migrateIdentity({ cwd: dir, from: 'v1' });
    expect(result.fromScheme).toBe('v1');
    expect(result.toScheme).toBe('v2');
    expect(result.allowlistRemapped).toBe(1);
    expect(result.allowlistUnmapped).toHaveLength(0);

    // The allowlist now carries the v2 id + is stamped v2.
    const migrated = loadAllowlist(dir)!;
    expect(migrated.identityScheme).toBe('v2');
    expect(migrated.entries[0].fingerprint).toBe(secret.id);

    // The regenerated baseline is stamped v2, and the guardrail now runs
    // (no scheme-mismatch error) and passes with no net-new.
    const migratedBaseline = JSON.parse(readFileSync(blPath, 'utf8'));
    expect(migratedBaseline.identityScheme).toBe('v2');
    const check = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    expect(check.blocks).toBe(false);
  }, 300_000);
});
