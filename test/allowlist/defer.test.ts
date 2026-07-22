/**
 * `vyuh-dxkit allowlist defer` — the bulk, dep-vuln-only, time-boxed deferral
 * of newly published advisories (D4 phase 1). Productizes the incident bridge
 * script shipped during the incident: one command, short shared expiry, and a hard
 * structural guarantee that it can never bulk-defer a real regression — every
 * entry is minted `kind=dep-vuln` (suppression matches on kind), non-dep-vuln
 * findings are refused, and `--from-last-check` only ever reads dep-vulns out
 * of the cached verdict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runAllowlistDefer } from '../../src/allowlist/cli';
import { loadAllowlist } from '../../src/allowlist/file';
import { DEFER_ADVISORY_EXPIRY_DAYS } from '../../src/allowlist/categories';
import { writeVerdict } from '../../src/baseline/verdict-cache';
import type { CachedBlockingFinding } from '../../src/baseline/verdict-cache';
import type { BrownfieldPolicy } from '../../src/baseline/policy';

const tmps: string[] = [];
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-defer-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 'dev'], { cwd: d });
  fs.writeFileSync(path.join(d, 'app.js'), 'const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  });
}

const POLICY = {} as unknown as BrownfieldPolicy;

function seedVerdict(cwd: string, blockingFindings: CachedBlockingFinding[]): void {
  writeVerdict(cwd, POLICY, {
    blocks: blockingFindings.length > 0,
    warns: false,
    blockingCount: blockingFindings.length,
    unattributableCount: 0,
    warningCount: 0,
    markdown: '## dxkit signals',
    ranAt: '2026-07-22T00:00:00.000Z',
    blockingFindings,
  });
}

const DEP_A: CachedBlockingFinding = {
  fingerprint: 'aaaa000000000001',
  kind: 'dep-vuln',
  status: 'newly_published_advisory',
  severity: 'high',
  locator: 'fast-uri@3.1.2 · GHSA-aaaa-bbbb-cccc',
};
const DEP_B: CachedBlockingFinding = {
  fingerprint: 'aaaa000000000002',
  kind: 'dep-vuln',
  status: 'newly_published_advisory',
  severity: 'medium',
  locator: 'svgo@1.3.2 · GHSA-dddd-eeee-ffff',
};
const SECRET: CachedBlockingFinding = {
  fingerprint: 'bbbb000000000001',
  kind: 'secret',
  status: 'added',
  severity: 'critical',
  locator: 'src/config.js:12',
};

describe('allowlist defer --from-last-check', () => {
  it('defers the cached blocking dep-vulns with the short default expiry, and ONLY those', async () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A, DEP_B, SECRET]);
    await runAllowlistDefer(d, { fromLastCheck: true, reason: 'advisory batch 2026-07-22' });

    const file = loadAllowlist(d);
    expect(file?.entries.map((e) => e.fingerprint).sort()).toEqual([
      DEP_A.fingerprint,
      DEP_B.fingerprint,
    ]);
    for (const e of file!.entries) {
      expect(e.kind).toBe('dep-vuln');
      expect(e.category).toBe('deferred');
      expect(e.reason).toBe('advisory batch 2026-07-22');
      expect(e.addedBy).toBe('dev@example.com');
      // Short window — the forcing function, not the 90-day accepted-risk default.
      const days = Math.round(
        (new Date(`${e.expiresAt}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBeGreaterThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS - 1);
      expect(days).toBeLessThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS);
    }
    // The secret is untouched — left blocking, never bulk-deferred.
    expect(file!.entries.some((e) => e.fingerprint === SECRET.fingerprint)).toBe(false);
  });

  it('is idempotent — already-present fingerprints are skipped, not duplicated', async () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A]);
    await runAllowlistDefer(d, { fromLastCheck: true, reason: 'first' });
    // The allowlist write changed the tree, so re-seed for the second run.
    seedVerdict(d, [DEP_A, DEP_B]);
    await runAllowlistDefer(d, { fromLastCheck: true, reason: 'second' });

    const file = loadAllowlist(d);
    expect(file?.entries).toHaveLength(2);
    expect(file?.entries.find((e) => e.fingerprint === DEP_A.fingerprint)?.reason).toBe('first');
  });

  it('refuses when no cached verdict exists for this tree, naming the remedy', async () => {
    const d = mkRepo();
    const exit = mockExit();
    await expect(runAllowlistDefer(d, { fromLastCheck: true, reason: 'x' })).rejects.toThrow(
      'process.exit(1)',
    );
    exit.mockRestore();
    expect(loadAllowlist(d)).toBeNull();
  });

  it('refuses a STALE cache (tree moved since the check) — findings must match this tree', async () => {
    const d = mkRepo();
    seedVerdict(d, [DEP_A]);
    fs.appendFileSync(path.join(d, 'app.js'), 'const y = 2;\n');
    const exit = mockExit();
    await expect(runAllowlistDefer(d, { fromLastCheck: true, reason: 'x' })).rejects.toThrow(
      'process.exit(1)',
    );
    exit.mockRestore();
  });

  it('refuses when the only blocking findings are non-dep-vuln (never a bulk bypass)', async () => {
    const d = mkRepo();
    seedVerdict(d, [SECRET]);
    const exit = mockExit();
    await expect(runAllowlistDefer(d, { fromLastCheck: true, reason: 'x' })).rejects.toThrow(
      'process.exit(1)',
    );
    exit.mockRestore();
    expect(loadAllowlist(d)).toBeNull();
  });
});

describe('allowlist defer <fingerprint>…', () => {
  it('defers an explicit fingerprint list as dep-vuln/deferred entries', async () => {
    const d = mkRepo();
    await runAllowlistDefer(d, {
      fingerprints: ['cccc000000000001', 'cccc000000000002', 'cccc000000000001'],
      reason: 'GHSA batch, PR is time-sensitive',
      expires: '+3d',
    });
    const file = loadAllowlist(d);
    // Deduped.
    expect(file?.entries).toHaveLength(2);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() + 3);
    expect(file?.entries[0].expiresAt).toBe(expected.toISOString().slice(0, 10));
    expect(file?.entries.every((e) => e.kind === 'dep-vuln' && e.category === 'deferred')).toBe(
      true,
    );
  });

  it('refuses an explicit fingerprint the last run reports as a non-dep-vuln finding', async () => {
    const d = mkRepo();
    seedVerdict(d, [SECRET]);
    const exit = mockExit();
    await expect(
      runAllowlistDefer(d, { fingerprints: [SECRET.fingerprint], reason: 'x' }),
    ).rejects.toThrow('process.exit(1)');
    exit.mockRestore();
    expect(loadAllowlist(d)).toBeNull();
  });

  it('requires a reason and at least one source', async () => {
    const d = mkRepo();
    const exit = mockExit();
    await expect(runAllowlistDefer(d, { fingerprints: ['aaaa000000000001'] })).rejects.toThrow(
      'process.exit(1)',
    );
    await expect(runAllowlistDefer(d, { reason: 'x' })).rejects.toThrow('process.exit(1)');
    exit.mockRestore();
  });

  it('rejects a malformed --expires', async () => {
    const d = mkRepo();
    const exit = mockExit();
    await expect(
      runAllowlistDefer(d, { fingerprints: ['aaaa000000000001'], reason: 'x', expires: 'soon' }),
    ).rejects.toThrow('process.exit(1)');
    exit.mockRestore();
  });
});
