import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isAdvisoryDbError, resolveAdvisoryDb } from '../src/analyzers/security/advisory-db';
import {
  buildOsvScannerScanCommand,
  gatherOsvScannerDepVulnsResult,
} from '../src/analyzers/tools/osv-scanner-deps';
import { gatherPackDepVulnsAcrossRoots } from '../src/analyzers/security/gather';
import type { LanguageSupport } from '../src/languages/types';

/**
 * 4.4.0 WP5 — the offline advisory snapshot (P1-4, air-gap).
 *
 * The properties, in dependency order: the ONE spec module resolves a
 * `--advisory-db` value; the scan invocation is offline-shaped (the
 * `--offline` umbrella flag + the env-only cache-dir variable); the
 * gather performs ZERO enrichment egress in snapshot mode; and the one
 * dispatch primitive skips — with cause — both an unusable snapshot and
 * any pack whose scanner has no offline mode. Silence is never an
 * outcome: every skip names why.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dxkit-advisory-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveAdvisoryDb (the one spec module)', () => {
  it('resolves a bare directory, reading VERSION when present', () => {
    mkdirSync(join(dir, 'db'));
    writeFileSync(join(dir, 'db', 'VERSION'), '2026-08-01\n');
    const spec = resolveAdvisoryDb(join(dir, 'db'), dir);
    expect(isAdvisoryDbError(spec)).toBe(false);
    if (!isAdvisoryDbError(spec)) {
      expect(spec.dir).toBe(join(dir, 'db'));
      expect(spec.version).toBe('2026-08-01');
    }
  });

  it('splits a path@version suffix only when the prefix is a real directory', () => {
    mkdirSync(join(dir, 'db'));
    const spec = resolveAdvisoryDb(`${join(dir, 'db')}@snap-42`, dir);
    if (isAdvisoryDbError(spec)) throw new Error(spec.error);
    expect(spec.version).toBe('snap-42');
    // A directory whose NAME contains @ still resolves whole.
    mkdirSync(join(dir, 'weird@dir'));
    const whole = resolveAdvisoryDb(join(dir, 'weird@dir'), dir);
    if (isAdvisoryDbError(whole)) throw new Error(whole.error);
    expect(whole.dir).toBe(join(dir, 'weird@dir'));
    expect(whole.version).toBe('unversioned');
  });

  it('an unversioned snapshot is declared, not invented', () => {
    mkdirSync(join(dir, 'db'));
    const spec = resolveAdvisoryDb(join(dir, 'db'), dir);
    if (isAdvisoryDbError(spec)) throw new Error(spec.error);
    expect(spec.version).toBe('unversioned');
  });

  it('a missing directory is a NAMED error — never a silent live fallback', () => {
    const spec = resolveAdvisoryDb(join(dir, 'nope'), dir);
    expect(isAdvisoryDbError(spec)).toBe(true);
    if (isAdvisoryDbError(spec)) {
      expect(spec.error).toContain('not a directory');
      expect(spec.error).toContain('SKIPPED');
    }
  });
});

describe('the offline scan invocation', () => {
  it('snapshot mode adds --offline and the env-only cache dir; live mode adds neither', () => {
    const offline = buildOsvScannerScanCommand('/bin/osv-scanner', 'package-lock.json', {
      dir: '/snap/db',
      version: 'v1',
    });
    expect(offline.cmd).toContain(' --offline');
    expect(offline.env).toEqual({ OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: '/snap/db' });
    const live = buildOsvScannerScanCommand('/bin/osv-scanner', 'package-lock.json');
    expect(live.cmd).not.toContain('--offline');
    expect(live.env).toBeUndefined();
  });
});

describe('the gather in snapshot mode (zero enrichment egress)', () => {
  const osvJson = JSON.stringify({
    results: [
      {
        source: { path: 'composer.lock', type: 'lockfile' },
        packages: [
          {
            package: { name: 'acme/pkg', version: '1.0.0', ecosystem: 'Packagist' },
            vulnerabilities: [{ id: 'GHSA-xxxx', aliases: [], severity: [], affected: [] }],
          },
        ],
      },
    ],
  });

  it('runs offline, parses findings, names the snapshot in the envelope, and never fetches', async () => {
    writeFileSync(join(dir, 'composer.lock'), '{}');
    const seen: Array<{ cmd: string; env?: Record<string, string> }> = [];
    // Any network attempt in snapshot mode is a test FAILURE.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network egress in snapshot mode');
    }) as typeof fetch;
    try {
      const outcome = await gatherOsvScannerDepVulnsResult(
        dir,
        'php',
        'Packagist',
        ['composer.lock'],
        {
          advisoryDb: { dir: '/snap/db', version: 'snap-7' },
          exec: (cmd, _cwd, _timeout, opts) => {
            seen.push({ cmd, env: opts?.env as Record<string, string> | undefined });
            return { code: 1, stdout: osvJson };
          },
        },
      );
      expect(outcome.kind).toBe('success');
      if (outcome.kind === 'success') {
        expect(outcome.envelope.enrichment).toBe('offline-snapshot@snap-7');
        expect(outcome.envelope.advisoryDbVersion).toBe('snap-7');
        expect(outcome.envelope.findings?.length).toBe(1);
      }
      expect(seen).toHaveLength(1);
      expect(seen[0].cmd).toContain('--offline');
      expect(seen[0].env?.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).toBe('/snap/db');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the one dispatch primitive', () => {
  const fakePack = (supportsOffline: boolean): LanguageSupport =>
    ({
      id: 'php',
      capabilities: {
        depVulns: {
          source: 'php',
          execution: () => ({
            hosts: ['any'],
            toolchains: [],
            needsBuild: false,
            buildTarget: 'none',
            weight: 'cheap',
          }),
          manifestPatterns: ['composer.lock'],
          lockfilePatterns: [],
          ...(supportsOffline ? { supportsOfflineSnapshot: true } : {}),
          gather: async () => null,
          gatherOutcome: async () => ({
            kind: 'success',
            envelope: {
              schemaVersion: 1,
              tool: 'osv-scanner',
              enrichment: 'offline-snapshot@x',
              counts: { critical: 0, high: 0, medium: 0, low: 0 },
              findings: [],
            },
          }),
        },
      },
    }) as unknown as LanguageSupport;

  it('skips a pack WITHOUT offline support, naming the zero-egress reason', async () => {
    const outcome = await gatherPackDepVulnsAcrossRoots(fakePack(false), dir, {
      advisoryDb: { dir: '/snap/db', version: 'v1' },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') {
      expect(outcome.reason).toContain('no offline mode');
      expect(outcome.reason).toContain('zero egress');
    }
  });

  it('an unusable snapshot makes the audit unavailable WITH the cause — for every pack', async () => {
    const outcome = await gatherPackDepVulnsAcrossRoots(fakePack(true), dir, {
      advisoryDb: { dir: '', version: 'unusable', error: 'advisory snapshot not found: /nope' },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') {
      expect(outcome.reason).toContain('advisory snapshot not found');
    }
  });

  it('a pack WITH offline support runs in snapshot mode', async () => {
    const outcome = await gatherPackDepVulnsAcrossRoots(fakePack(true), dir, {
      advisoryDb: { dir: '/snap/db', version: 'v1' },
    });
    expect(outcome.kind).toBe('success');
  });
});
