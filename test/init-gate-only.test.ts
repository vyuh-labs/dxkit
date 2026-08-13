import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runGateOnlyInit } from '../src/init-gate-only';
import { parsePolicyText } from '../src/baseline/policy-text';
import { resolvePolicy } from '../src/baseline/policy';

/**
 * The embed profile (4.4.0 WP8) + its declared base (4.4.1 WP1b §7.2).
 * Pins: exactly one artifact, and the scaffolded policy PINS its posture
 * explicitly — `"extends": "security-only"`, the same base the gate's
 * no-policy fallback applies, so scaffolding never silently changes what
 * a tree is judged under.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('init --gate-only', () => {
  it('writes exactly one artifact: a policy scaffold with a declared security-only base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-gate-only-'));
    dirs.push(dir);
    await runGateOnlyInit(dir);

    // Exactly one artifact: .dxkit/policy.json — no hooks, CI, or .claude.
    expect(readdirSync(dir)).toEqual(['.dxkit']);
    expect(readdirSync(join(dir, '.dxkit'))).toEqual(['policy.json']);

    const text = readFileSync(join(dir, '.dxkit', 'policy.json'), 'utf8');
    const parsed = parsePolicyText(text) as Record<string, unknown>;
    expect(parsed.extends).toBe('security-only');

    // The declared base resolves to the security-only posture: debt rules
    // disarmed, the security floor armed.
    const resolved = resolvePolicy(undefined, dir);
    expect(resolved.blockRules.newUntestedChangedSource).toBe(false);
    expect(resolved.blockRules.newSecret).toBe(true);
  });

  it('leaves an existing policy untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-gate-only-existing-'));
    dirs.push(dir);
    await runGateOnlyInit(dir);
    const before = readFileSync(join(dir, '.dxkit', 'policy.json'), 'utf8');
    await runGateOnlyInit(dir);
    expect(readFileSync(join(dir, '.dxkit', 'policy.json'), 'utf8')).toBe(before);
  });
});
