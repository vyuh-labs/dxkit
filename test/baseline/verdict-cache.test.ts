/**
 * The guardrail verdict cache — the replay contract behind `receipt` and the
 * redundant-scan fix (#24/#93). A cached verdict may only be replayed when the
 * tree it would scan is byte-identical AND the policy is unchanged; anything
 * else must miss so the caller re-gathers. These tests pin that a replay can
 * never hide a change.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readFreshVerdict, writeVerdict, policyHash } from '../../src/baseline/verdict-cache';
import type { BrownfieldPolicy } from '../../src/baseline/policy';

const tmps: string[] = [];
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-verdict-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  fs.writeFileSync(path.join(d, 'app.js'), 'const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const POLICY = { code: { block: ['critical'] } } as unknown as BrownfieldPolicy;
const FIELDS = {
  blocks: false,
  warns: false,
  blockingCount: 0,
  unattributableCount: 0,
  warningCount: 0,
  markdown: '## Guardrail: PASSED',
  ranAt: '2026-07-06T00:00:00.000Z',
};

describe('verdict cache — replay contract', () => {
  it('replays a verdict when the tree + policy are unchanged', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    const hit = readFreshVerdict(d, POLICY);
    expect(hit?.markdown).toBe('## Guardrail: PASSED');
    expect(hit?.blocks).toBe(false);
  });

  it('MISSES after any tracked edit (a changed tree can never replay)', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    fs.appendFileSync(path.join(d, 'app.js'), 'const y = 2;\n');
    expect(readFreshVerdict(d, POLICY)).toBeNull();
  });

  it('MISSES after a new untracked file appears', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    fs.writeFileSync(path.join(d, 'new.js'), 'const z = 3;\n');
    expect(readFreshVerdict(d, POLICY)).toBeNull();
  });

  it('MISSES when the policy changes (a tightened gate must re-evaluate)', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    const stricter = { code: { block: ['critical', 'high'] } } as unknown as BrownfieldPolicy;
    expect(policyHash(stricter)).not.toBe(policyHash(POLICY));
    expect(readFreshVerdict(d, stricter)).toBeNull();
  });

  it('is NOT perturbed by writing dxkit’s own output dirs (the cache stays warm)', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    // Simulate a subsequent gather writing reports/cache — these are dxkit
    // outputs, not code under test, so they must not invalidate the replay.
    fs.mkdirSync(path.join(d, '.dxkit', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(d, '.dxkit', 'reports', 'health.json'), '{}');
    expect(readFreshVerdict(d, POLICY)?.markdown).toBe('## Guardrail: PASSED');
  });

  it('MISSES on a pre-refusal-tier entry (no unattributableCount) — replaying it could say PASSED over an attribution gap', () => {
    const d = mkRepo();
    writeVerdict(d, POLICY, FIELDS);
    const cachePath = path.join(d, '.dxkit', 'cache', 'verdict.json');
    const entry = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    delete entry.unattributableCount; // what a 3.7.x-written cache entry looks like
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2) + '\n');
    expect(readFreshVerdict(d, POLICY)).toBeNull();
  });

  it('returns null in a non-git dir (never caches without a commit)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-nogit-'));
    tmps.push(d);
    expect(readFreshVerdict(d, POLICY)).toBeNull();
    // write is a no-op (no signature) — never throws.
    expect(() => writeVerdict(d, POLICY, FIELDS)).not.toThrow();
  });
});
