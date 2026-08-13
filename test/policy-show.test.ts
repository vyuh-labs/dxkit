import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderPolicyShow, resolvePolicyShow } from '../src/policy-show';

/**
 * WP1b (§7.2) — the effective-policy view. `policy show` is a VIEW over
 * the ONE resolver, never a fourth resolution path: these tests pin
 * that it renders the resolved merge (base + provenance), the
 * required-observation contract, and the per-surface fallback notes.
 */

const dirs: string[] = [];
let savedPreset: string | undefined;

beforeAll(() => {
  savedPreset = process.env.DXKIT_LOOP_PRESET;
  delete process.env.DXKIT_LOOP_PRESET;
});

afterAll(() => {
  if (savedPreset === undefined) delete process.env.DXKIT_LOOP_PRESET;
  else process.env.DXKIT_LOOP_PRESET = savedPreset;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(policy?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-policy-show-'));
  dirs.push(dir);
  if (policy) {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy, null, 2));
  }
  return dir;
}

describe('resolvePolicyShow', () => {
  it('no policy file → compiled-default source, with both fallback surfaces named', () => {
    const view = resolvePolicyShow(tree());
    expect(view.source.kind).toBe('compiled-default');
    expect(view.base).toEqual({ name: 'default', declared: false });
    expect(view.identity.hash).toMatch(/^[0-9a-f]{16}$/);
    const joined = view.notes.join('\n');
    expect(joined).toContain('guardrail check');
    expect(joined).toContain('SECURITY-ONLY');
    expect(joined).toContain('loop Stop-gate');
  });

  it('a file without extends → implicit default base + the footgun note', () => {
    const view = resolvePolicyShow(tree({ id: 'acme.dod' }));
    expect(view.source.kind).toBe('tree-file');
    expect(view.base).toEqual({ name: 'default', declared: false });
    expect(view.notes.join('\n')).toContain('declares no "extends"');
  });

  it('a declared base with a file override → per-rule provenance distinguishes them', () => {
    const view = resolvePolicyShow(
      tree({
        extends: 'security-only',
        blockRules: { newUntestedChangedSource: true },
        checks: [
          { name: 'arch', command: 'scripts/arch.sh', required: true },
          { name: 'audit', pattern: 'TODO', blocking: false },
        ],
      }),
    );
    expect(view.base).toEqual({ name: 'security-only', declared: true });
    const byRule = new Map(view.blockRules.map((r) => [r.rule, r]));
    // The file flipped this away from the security-only base.
    expect(byRule.get('newUntestedChangedSource')).toMatchObject({ armed: true, origin: 'file' });
    // The base supplied this; the file did not touch it.
    expect(byRule.get('newSecret')).toMatchObject({ armed: true, origin: 'base' });
    // Required observations reflect WP1a's contract.
    expect(view.requiredObservations.floor).toEqual({ required: true, source: 'default' });
    expect(view.requiredObservations.checks).toEqual([
      { name: 'arch', required: true, blocking: true },
      { name: 'audit', required: false, blocking: false },
    ]);
  });

  it('floor.required: false shows as file-sourced not-required', () => {
    const view = resolvePolicyShow(tree({ extends: 'security-only', floor: { required: false } }));
    expect(view.requiredObservations.floor).toEqual({ required: false, source: 'file' });
  });

  it('--policy renders that document (embed use), marked explicit', () => {
    const dir = tree();
    const p = join(dir, 'dod.json');
    writeFileSync(p, JSON.stringify({ extends: 'security-only', id: 'embed.dod' }));
    const view = resolvePolicyShow(dir, { policyPath: p });
    expect(view.source).toEqual({ kind: 'explicit-file', path: p });
    expect(view.identity.id).toBe('embed.dod');
  });
});

describe('renderPolicyShow', () => {
  it('renders source, base, identity, armed rules with provenance, and required observations', () => {
    const out = renderPolicyShow(
      resolvePolicyShow(
        tree({
          extends: 'security-only',
          id: 'acme.dod',
          version: '2',
          blockRules: { newUntestedChangedSource: true },
          checks: [{ name: 'arch', command: 'x', required: true }],
        }),
      ),
    );
    expect(out).toContain('Effective policy');
    expect(out).toContain('base:   security-only (declared via "extends")');
    expect(out).toContain('acme.dod@2');
    expect(out).toContain('ARMED  newUntestedChangedSource  (set by this file)');
    expect(out).toContain('ARMED  newSecret');
    expect(out).toContain('floor: REQUIRED (default)');
    expect(out).toContain('check "arch": REQUIRED, blocking');
  });
});
