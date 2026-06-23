import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  workingTreeSignature,
  readStateCache,
  writeStateCache,
  loopGateActive,
  type StopGateStateCache,
} from '../../src/loop/gate-cache';
import {
  refScanCacheKey,
  readRefScanCache,
  writeRefScanCache,
} from '../../src/baseline/ref-baseline';
import type { CurrentScan } from '../../src/baseline/create';

/**
 * The two caches that make the Stop-gate cheap (2.13.3):
 *   - the tree-signature VERDICT cache (skip the gather when the working
 *     tree is byte-identical to the last gather), and
 *   - the content-addressed REF-SCAN cache (skip re-scanning an unchanged
 *     origin/main on every stop).
 * Both are safety-critical: a cache hit must only ever be a genuinely
 * identical input, so these tests pin the "any change invalidates" property.
 */

function git(repo: string, args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxkit-cache-test-'));
  git(dir, 'init -q');
  git(dir, 'config user.email t@t.co');
  git(dir, 'config user.name test');
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add -A');
  git(dir, 'commit -qm seed');
  return dir;
}

describe('workingTreeSignature (verdict cache key)', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns null outside a git repo', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'dxkit-nogit-'));
    expect(workingTreeSignature(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });

  it('is stable across calls on an unchanged tree', () => {
    expect(workingTreeSignature(repo)).toBe(workingTreeSignature(repo));
  });

  it('changes when a tracked file is edited', () => {
    const before = workingTreeSignature(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'hello world\n');
    expect(workingTreeSignature(repo)).not.toBe(before);
  });

  it('changes when an untracked file is created', () => {
    const before = workingTreeSignature(repo);
    writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    expect(workingTreeSignature(repo)).not.toBe(before);
  });

  it('changes when an untracked file CONTENT changes (not just its name)', () => {
    writeFileSync(path.join(repo, 'untracked.txt'), 'one\n');
    const sigOne = workingTreeSignature(repo);
    writeFileSync(path.join(repo, 'untracked.txt'), 'two\n');
    const sigTwo = workingTreeSignature(repo);
    // Same filename, same `git status` line — only the content differs. A
    // status-only signature would MISS this; a net-new finding in an
    // untracked file would then be skipped. Must differ.
    expect(sigTwo).not.toBe(sigOne);
  });

  it('changes when HEAD moves', () => {
    const before = workingTreeSignature(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'committed change\n');
    git(repo, 'commit -aqm change');
    expect(workingTreeSignature(repo)).not.toBe(before);
  });
});

describe('verdict cache read/write', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('round-trips an allow verdict', () => {
    const c: StopGateStateCache = {
      signature: 'abc',
      outcome: 'allow',
      message: '',
      netNew: 0,
      baselineFindings: 12,
    };
    writeStateCache(repo, c);
    expect(readStateCache(repo)).toEqual(c);
  });

  it('round-trips a block-model verdict with its message', () => {
    const c: StopGateStateCache = {
      signature: 'sig2',
      outcome: 'block-model',
      message: 'fix the secret',
      netNew: 1,
      baselineFindings: 5,
    };
    writeStateCache(repo, c);
    expect(readStateCache(repo)).toEqual(c);
  });

  it('returns null when no cache exists', () => {
    expect(readStateCache(repo)).toBeNull();
  });

  it('returns null on a corrupt or invalid cache file', () => {
    const dir = path.join(repo, '.dxkit', 'loop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'last-state.json'), '{ not json');
    expect(readStateCache(repo)).toBeNull();
    // valid JSON but an outcome the cache must never replay
    writeFileSync(
      path.join(dir, 'last-state.json'),
      JSON.stringify({ signature: 'x', outcome: 'block-operator' }),
    );
    expect(readStateCache(repo)).toBeNull();
  });
});

describe('ref-scan cache', () => {
  let repo: string;
  const minimalScan = { findings: [] } as unknown as CurrentScan;
  beforeEach(() => {
    repo = makeRepo();
    delete process.env.DXKIT_NO_REF_CACHE;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.DXKIT_NO_REF_CACHE;
  });

  it('key is deterministic for the same sha and differs across shas', () => {
    expect(refScanCacheKey(repo, 'sha-aaa')).toBe(refScanCacheKey(repo, 'sha-aaa'));
    expect(refScanCacheKey(repo, 'sha-aaa')).not.toBe(refScanCacheKey(repo, 'sha-bbb'));
  });

  it('incremental changed-file set is part of the key (scoped never reused for full or a different set)', () => {
    const full = refScanCacheKey(repo, 'sha-aaa');
    const incrA = refScanCacheKey(repo, 'sha-aaa', undefined, ['a.ts', 'b.ts']);
    const incrB = refScanCacheKey(repo, 'sha-aaa', undefined, ['c.ts']);
    // A scoped scan must not collide with a full scan or a different set.
    expect(incrA).not.toBe(full);
    expect(incrA).not.toBe(incrB);
    // ...but is order-independent and stable for the same set.
    expect(refScanCacheKey(repo, 'sha-aaa', undefined, ['b.ts', 'a.ts'])).toBe(incrA);
  });

  it('skipRemediation is part of the key (a remediation-skipped scan never reused for a full one)', () => {
    const full = refScanCacheKey(repo, 'sha-aaa', undefined, undefined, false);
    const skipped = refScanCacheKey(repo, 'sha-aaa', undefined, undefined, true);
    expect(skipped).not.toBe(full);
    // default (undefined) matches the explicit `false` (full enrichment).
    expect(refScanCacheKey(repo, 'sha-aaa')).toBe(full);
  });

  it('write then read returns the cached scan', () => {
    const key = refScanCacheKey(repo, 'sha-aaa');
    writeRefScanCache(repo, key, minimalScan);
    expect(readRefScanCache(repo, key)).toEqual(minimalScan);
  });

  it('returns null on a format-version mismatch', () => {
    const key = refScanCacheKey(repo, 'sha-aaa');
    const dir = path.join(repo, '.dxkit', 'cache', 'ref-scan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ format: 999, scan: { findings: [] } }),
    );
    expect(readRefScanCache(repo, key)).toBeNull();
  });

  it('returns null when the cached payload has no findings array', () => {
    const key = refScanCacheKey(repo, 'sha-aaa');
    const dir = path.join(repo, '.dxkit', 'cache', 'ref-scan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ format: 1, scan: {} }));
    expect(readRefScanCache(repo, key)).toBeNull();
  });

  it('DXKIT_NO_REF_CACHE=1 bypasses both read and write', () => {
    const key = refScanCacheKey(repo, 'sha-aaa');
    writeRefScanCache(repo, key, minimalScan); // seed without the env
    process.env.DXKIT_NO_REF_CACHE = '1';
    expect(readRefScanCache(repo, key)).toBeNull(); // read bypassed
    // write is a no-op under the env: clear, attempt, then confirm a normal read misses
    process.env.DXKIT_NO_REF_CACHE = '1';
    const key2 = refScanCacheKey(repo, 'sha-ccc');
    writeRefScanCache(repo, key2, minimalScan);
    delete process.env.DXKIT_NO_REF_CACHE;
    expect(readRefScanCache(repo, key2)).toBeNull();
  });
});

describe('loop-scoped activation', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
    delete process.env.DXKIT_LOOP_ACTIVE;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.DXKIT_LOOP_ACTIVE;
  });

  it('is inactive by default (interactive turns are not gated)', () => {
    expect(loopGateActive(repo)).toBe(false);
  });

  it('is active when DXKIT_LOOP_ACTIVE=1', () => {
    process.env.DXKIT_LOOP_ACTIVE = '1';
    expect(loopGateActive(repo)).toBe(true);
  });

  it('is not active for other DXKIT_LOOP_ACTIVE values', () => {
    process.env.DXKIT_LOOP_ACTIVE = '0';
    expect(loopGateActive(repo)).toBe(false);
    process.env.DXKIT_LOOP_ACTIVE = 'true';
    expect(loopGateActive(repo)).toBe(false);
  });

  it('is active when a .dxkit/loop/active sentinel exists', () => {
    const dir = path.join(repo, '.dxkit', 'loop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'active'), '');
    expect(loopGateActive(repo)).toBe(true);
  });

  it('auto-activates on an unattended permission_mode (bypassPermissions)', () => {
    expect(loopGateActive(repo, { permission_mode: 'bypassPermissions' })).toBe(true);
  });

  it('does NOT activate on interactive permission modes', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk']) {
      expect(loopGateActive(repo, { permission_mode: mode })).toBe(false);
    }
    expect(loopGateActive(repo, {})).toBe(false);
  });
});
