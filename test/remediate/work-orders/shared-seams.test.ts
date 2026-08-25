/**
 * The seams this unit routed through ONE entry point each (Rule 2.30):
 * the import-resolution check carries structured `{ specifier, file }` pairs;
 * `provisionArgv` and `provisionCommand` agree; `floorDebtToBaseChecks` is
 * the one envelope projection; `activeDeferredEntries` is what both `debt`
 * and the planner read; the typescript pack declares `provision`.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCorrectnessFloor,
  IMPORT_RESOLUTION_LABEL,
} from '../../../src/analyzers/correctness/run';
import type { LanguageSupport } from '../../../src/languages/types';
import { getLanguage } from '../../../src/languages';
import { provisionArgv, provisionCommand, type PackageManager } from '../../../src/package-manager';
import { floorDebtToBaseChecks } from '../../../src/baseline/floor-debt';
import { activeDeferredEntries, type AllowlistFile } from '../../../src/allowlist/file';
import { buildDebtReport } from '../../../src/debt-cli';

describe('import-resolution check carries structured unresolved pairs', () => {
  it('every importer reaches the result beside the identity projection', () => {
    const ts = getLanguage('typescript')!;
    const pack: LanguageSupport = {
      ...ts,
      correctness: {
        ...ts.correctness,
        syntaxCheck: () => null,
        affectedTests: () => null,
        resolutionCheck: () => ({
          kind: 'unresolved',
          unresolved: [
            { specifier: 'lodash', file: 'src/a.ts' },
            { specifier: 'lodash', file: 'src/z.ts' },
          ],
        }),
      },
    };
    const result = runCorrectnessFloor({
      cwd: process.cwd(),
      changedFiles: [],
      scope: 'full',
      packs: [pack],
      exec: () => ({ available: true, code: 0, output: '' }),
    });
    const check = result.checks.find((c) => c.label === IMPORT_RESOLUTION_LABEL)!;
    expect(check.status).toBe('fail');
    expect(check.findings).toEqual(['lodash']);
    expect(check.unresolved).toEqual([
      { specifier: 'lodash', file: 'src/a.ts' },
      { specifier: 'lodash', file: 'src/z.ts' },
    ]);
  });
});

describe('provisionArgv is the one provision command', () => {
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as PackageManager[]) {
    it(`${pm}: the display command is the argv joined`, () => {
      expect(provisionCommand(pm)).toBe(provisionArgv(pm).join(' '));
      expect(provisionArgv(pm)[0]).toBe(pm);
    });
  }

  it('the typescript pack declares provision from the repo lockfile, null without one (npm ci would always fail)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-provision-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      expect(getLanguage('typescript')!.provision!(dir)).toBeNull();
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      expect(getLanguage('typescript')!.provision!(dir)).toEqual({
        bin: 'pnpm',
        args: ['install'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the interpreted packs declare their own ecosystem provision commands (never npm)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-provision-eco-'));
    try {
      expect(getLanguage('python')!.provision!(dir)).toBeNull();
      writeFileSync(join(dir, 'requirements.txt'), '');
      expect(getLanguage('python')!.provision!(dir)).toEqual({
        bin: 'pip',
        args: ['install', '-r', 'requirements.txt'],
      });
      writeFileSync(join(dir, 'poetry.lock'), '');
      expect(getLanguage('python')!.provision!(dir)).toEqual({ bin: 'poetry', args: ['install'] });
      expect(getLanguage('ruby')!.provision!(dir)).toBeNull();
      writeFileSync(join(dir, 'Gemfile.lock'), '');
      expect(getLanguage('ruby')!.provision!(dir)).toEqual({ bin: 'bundle', args: ['install'] });
      expect(getLanguage('php')!.provision!(dir)).toBeNull();
      writeFileSync(join(dir, 'composer.lock'), '');
      expect(getLanguage('php')!.provision!(dir)).toEqual({ bin: 'composer', args: ['install'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('floorDebtToBaseChecks', () => {
  it('projects every status onto the comparator vocabulary', () => {
    expect(
      floorDebtToBaseChecks({
        capturedAtCommit: null,
        capturedAt: 'x',
        checks: [
          { pack: 'p', label: 'a', command: '', status: 'pass' },
          { pack: 'p', label: 'b', command: '', status: 'fail' },
          { pack: 'p', label: 'c', command: '', status: 'skipped-environment' },
        ],
      }),
    ).toEqual([
      { pack: 'p', label: 'a', status: 'pass' },
      { pack: 'p', label: 'b', status: 'fail' },
      { pack: 'p', label: 'c', status: 'skipped' },
    ]);
  });
});

describe('activeDeferredEntries is what debt reads too (parity)', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  const file: AllowlistFile = {
    schemaVersion: 'dxkit-allowlist/v1',
    mode: 'full',
    entries: [
      {
        fingerprint: 'late',
        kind: 'dep-vuln',
        category: 'deferred',
        addedAt: '2026-08-01',
        expiresAt: '2026-09-20',
      },
      {
        fingerprint: 'soon',
        kind: 'dep-vuln',
        category: 'deferred',
        addedAt: '2026-08-01',
        expiresAt: '2026-09-01',
      },
      {
        fingerprint: 'expired',
        kind: 'dep-vuln',
        category: 'deferred',
        addedAt: '2026-07-01',
        expiresAt: '2026-08-01',
      },
      { fingerprint: 'fp', kind: 'code', category: 'false-positive', addedAt: '2026-08-01' },
    ],
  };

  it('active deferred only, soonest first', () => {
    expect(activeDeferredEntries(file, now).map((e) => e.fingerprint)).toEqual(['soon', 'late']);
    expect(activeDeferredEntries(null, now)).toEqual([]);
  });

  it('the debt report lists exactly the same deferrals in the same order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-defer-parity-'));
    try {
      mkdirSync(join(dir, '.dxkit'), { recursive: true });
      writeFileSync(join(dir, '.dxkit', 'allowlist.json'), JSON.stringify(file));
      const report = buildDebtReport(dir, { stored: true, now });
      expect(report.deferred.map((d) => d.fingerprint)).toEqual(
        activeDeferredEntries(file, now).map((e) => e.fingerprint),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
