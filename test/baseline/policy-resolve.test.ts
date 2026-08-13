import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_BROWNFIELD_POLICY,
  POLICY_BASE_TOKENS,
  policyBaseFor,
  policyContentHash,
  resolvePolicy,
} from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

/**
 * WP1b (§7.2) — the declared policy base. The class under test: an
 * explicit MINIMAL policy file used to merge over the FULLY ARMED
 * compiled default, so adding a small dod.json silently armed test-gap
 * blocking (hit live by an embedder). `extends` names the base; absent
 * stays byte-identical to the pre-4.4.1 merge.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function treeWithPolicy(policy: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-policy-resolve-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy, null, 2));
  return dir;
}

describe('policyBaseFor', () => {
  it('absent and "default" both resolve to the compiled default', () => {
    expect(policyBaseFor(undefined, 'x')).toBe(DEFAULT_BROWNFIELD_POLICY);
    expect(policyBaseFor('default', 'x')).toBe(DEFAULT_BROWNFIELD_POLICY);
  });

  it('preset tokens resolve to the preset applied over the compiled default', () => {
    expect(policyBaseFor('security-only', 'x')).toEqual(
      policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY).policy,
    );
    expect(policyBaseFor('full-debt', 'x')).toEqual(
      policyForPreset('full-debt', DEFAULT_BROWNFIELD_POLICY).policy,
    );
  });

  it('an unknown token throws, naming the known bases and the source', () => {
    expect(() => policyBaseFor('security_only', '/repo/.dxkit/policy.json')).toThrow(
      /unknown base.*security_only.*\/repo\/\.dxkit\/policy\.json/s,
    );
    for (const token of POLICY_BASE_TOKENS) {
      expect(() => policyBaseFor(token, 'x')).not.toThrow();
    }
  });
});

describe('resolvePolicy with a declared base', () => {
  it('a minimal file over security-only keeps debt rules DISARMED (the footgun, closed)', () => {
    const dir = treeWithPolicy({ extends: 'security-only', id: 'acme.dod' });
    const resolved = resolvePolicy(undefined, dir);
    // Under the compiled default these were armed — the exact silent flip
    // the embedder hit. Under the declared base they stay off.
    expect(resolved.blockRules.newUntestedChangedSource).toBe(false);
    expect(resolved.blockRules.newSevereQualityIssueInChangedFiles).toBe(false);
    // The security floor stays armed, from the base.
    expect(resolved.blockRules.newSecret).toBe(true);
    expect(resolved.block).toEqual([]);
    expect(resolved.id).toBe('acme.dod');
    expect(resolved.extends).toBe('security-only');
  });

  it('file fields still override the declared base (deep-merge for blockRules)', () => {
    const dir = treeWithPolicy({
      extends: 'security-only',
      blockRules: { newUntestedChangedSource: true },
    });
    const resolved = resolvePolicy(undefined, dir);
    expect(resolved.blockRules.newUntestedChangedSource).toBe(true);
    expect(resolved.blockRules.newSecret).toBe(true);
  });

  it('extends full-debt arms the strict posture as the base', () => {
    const dir = treeWithPolicy({ extends: 'full-debt' });
    const resolved = resolvePolicy(undefined, dir);
    expect(resolved.block).toEqual(['added']);
    expect(resolved.blockRules.newUntestedChangedSource).toBe(true);
  });

  it('a file WITHOUT extends resolves exactly as before (over the compiled default)', () => {
    const overrides = { warn: ['uncertain'], blockRules: { newSecret: false } };
    const withImplicit = resolvePolicy(undefined, treeWithPolicy(overrides));
    const withExplicit = resolvePolicy(
      undefined,
      treeWithPolicy({ ...overrides, extends: 'default' }),
    );
    // Same semantics; the only difference is the declared token itself.
    expect({ ...withExplicit, extends: undefined }).toEqual({
      ...withImplicit,
      extends: undefined,
    });
    expect(withImplicit.blockRules.newUntestedChangedSource).toBe(
      DEFAULT_BROWNFIELD_POLICY.blockRules.newUntestedChangedSource,
    );
  });

  it('an unknown extends is a LOAD error, never a silent fully-armed fallback', () => {
    const dir = treeWithPolicy({ extends: 'securty-only' });
    expect(() => resolvePolicy(undefined, dir)).toThrow(/unknown base/);
  });

  it('the declared base is part of policy identity (the hash moves with it)', () => {
    const implicit = resolvePolicy(undefined, treeWithPolicy({ warn: ['uncertain'] }));
    const declared = resolvePolicy(
      undefined,
      treeWithPolicy({ warn: ['uncertain'], extends: 'security-only' }),
    );
    expect(policyContentHash(implicit)).not.toBe(policyContentHash(declared));
  });
});
