import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BASELINE_MODES,
  GATE_ONLY_MODES,
  parseBaselineMode,
  priorClassOf,
  resolveGateMode,
} from '../../src/baseline/modes';
import { runGate } from '../../src/gate/engine';
import { DEFAULT_BROWNFIELD_POLICY, resolvePolicy } from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

const securityOnly = () => policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY).policy;
import { trustedLocalContext } from '../../src/analysis-trust';
import { verdictCounts } from '../../src/baseline/check-renderers';

/**
 * 4.4.0 WP2a — the gate-only prior modes (`fresh`, `tree-baseline`) and
 * the prior-class dispatch. Pure layer first; then the engine driven
 * DIRECTLY (no CLI yet — that's WP2b) over bare, non-git directories:
 * the exact subject shape the spec's package mode judges.
 */

describe('mode → prior-class mapping (the one declaration every branch keys on)', () => {
  it('maps all five modes', () => {
    expect(priorClassOf('committed-full')).toBe('committed');
    expect(priorClassOf('committed-sanitized')).toBe('committed');
    expect(priorClassOf('ref-based')).toBe('dir-gathered');
    expect(priorClassOf('tree-baseline')).toBe('dir-gathered');
    expect(priorClassOf('fresh')).toBe('empty');
  });

  it('keeps the guardrail-facing enumeration at the three repo modes', () => {
    expect(BASELINE_MODES).toEqual(['committed-full', 'committed-sanitized', 'ref-based']);
    expect(GATE_ONLY_MODES).toEqual(['fresh', 'tree-baseline']);
  });

  it('guardrail --mode cannot select a gate-only prior', () => {
    expect(parseBaselineMode('fresh')).toBeNull();
    expect(parseBaselineMode('tree-baseline')).toBeNull();
    expect(parseBaselineMode('ref-based')).toBe('ref-based');
  });

  it('resolveGateMode: fresh without a baseline dir, tree-baseline with one', () => {
    const fresh = resolveGateMode({});
    expect(fresh.mode).toBe('fresh');
    expect(fresh.source).toBe('gate');
    expect(fresh.baselineDir).toBeUndefined();
    const tree = resolveGateMode({ baselineDir: '/some/dir' });
    expect(tree.mode).toBe('tree-baseline');
    expect(tree.baselineDir).toBe('/some/dir');
    expect(tree.explanation).toContain('/some/dir');
  });
});

describe('the engine over bare trees (no git, no init)', () => {
  const HEAVY = 600_000;
  let savedSalt: string | undefined;
  const dirs: string[] = [];

  const makeTree = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-gate-tree-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };

  // Assembled from fragments so no source line here carries a
  // credential-shaped `password = '...'` adjacency the secret scanners
  // would flag (the grep-secrets.test.ts discipline, one step further —
  // the template-literal version still matched on this line itself).
  const credentialLine = () =>
    ['const pass', 'word', " = '", ['gate', 'live', '99'].join('-'), "';\n"].join('');

  beforeAll(() => {
    savedSalt = process.env.DXKIT_BASELINE_SALT;
    delete process.env.DXKIT_BASELINE_SALT;
  });

  afterAll(() => {
    if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
    else process.env.DXKIT_BASELINE_SALT = savedSalt;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it(
    'fresh mode: a clean tree passes under a security posture; a credential-carrying tree blocks',
    async () => {
      // Policy is the DoD (P0-3): under the compiled-in DEFAULT policy a
      // fresh gate blocks on EVERY added finding — including the honest
      // test-gap a two-file tree carries — so the "clean passes" property
      // is asserted under the security-only posture, exactly how a
      // package-mode consumer declares what "done" means.
      const clean = makeTree({
        'README.md': '# generated package\n',
        'index.ts': "export const greeting = 'hello';\n",
      });
      const cleanResult = await runGate(
        { kind: 'tree', dir: clean },
        resolveGateMode({}),
        securityOnly(),
        { trust: trustedLocalContext() },
      );
      const cleanCounts = verdictCounts(cleanResult);
      expect(cleanCounts.verdict).toMatch(/^PASSED/);
      expect(cleanCounts.exitCode).toBe(0);
      // Fresh prior: nothing is excluded, nothing drifts, no committed-mode
      // disclosures apply.
      expect(cleanResult.refExcludedKinds).toEqual([]);
      expect(cleanResult.envelopeDrift.recallDrift).toEqual([]);
      expect(cleanResult.attributionGaps).toEqual([]);
      expect(cleanResult.mode.mode).toBe('fresh');

      const seeded = makeTree({
        'README.md': '# generated package\n',
        'config.ts': credentialLine(),
      });
      const seededResult = await runGate(
        { kind: 'tree', dir: seeded },
        resolveGateMode({}),
        securityOnly(),
        { trust: trustedLocalContext() },
      );
      const counts = verdictCounts(seededResult);
      expect(counts.verdict).toBe('BLOCKED');
      const secretPairs = seededResult.pairs.filter(
        (p) => p.kind === 'secret' && p.classification.blocks,
      );
      expect(secretPairs.length).toBeGreaterThanOrEqual(1);
      expect(secretPairs[0].classification.status).toBe('added');
      expect(secretPairs[0].file).toBe('config.ts');
      // Rule 9: the identity is minted through the canonical helpers even on
      // a bare tree — 16-hex, durable.
      expect(secretPairs[0].pair.currentId).toMatch(/^[0-9a-f]{16}$/);
    },
    HEAVY,
  );

  it(
    'tree-baseline mode: the same tree on both sides persists; an edit introducing a credential blocks',
    async () => {
      const base = makeTree({
        'README.md': '# generated package\n',
        'index.ts': "export const greeting = 'hello';\n",
      });
      // The "edited" tree: same content plus a net-new credential.
      const edited = makeTree({
        'README.md': '# generated package\n',
        'index.ts': "export const greeting = 'hello';\n",
        'config.ts': credentialLine(),
      });

      const same = await runGate(
        { kind: 'tree', dir: base },
        resolveGateMode({ baselineDir: base }),
        resolvePolicy(undefined, base),
        { trust: trustedLocalContext() },
      );
      const sameCounts = verdictCounts(same);
      expect(sameCounts.verdict).toMatch(/^PASSED/);
      expect(same.pairs.every((p) => !p.classification.blocks)).toBe(true);
      expect(same.mode.mode).toBe('tree-baseline');

      const diff = await runGate(
        { kind: 'tree', dir: edited },
        resolveGateMode({ baselineDir: base }),
        resolvePolicy(undefined, edited),
        { trust: trustedLocalContext() },
      );
      const diffCounts = verdictCounts(diff);
      expect(diffCounts.verdict).toBe('BLOCKED');
      const added = diff.pairs.filter((p) => p.classification.blocks && p.kind === 'secret');
      expect(added.length).toBeGreaterThanOrEqual(1);
      expect(added[0].file).toBe('config.ts');
    },
    HEAVY,
  );

  it(
    'fresh mode is deterministic across two runs (P0-1 acceptance property)',
    async () => {
      const tree = makeTree({
        'README.md': '# generated package\n',
        'config.ts': credentialLine(),
      });
      const run = async () => {
        const r = await runGate(
          { kind: 'tree', dir: tree },
          resolveGateMode({}),
          resolvePolicy(undefined, tree),
          { trust: trustedLocalContext() },
        );
        const c = verdictCounts(r);
        return {
          verdict: c.verdict,
          blocking: r.pairs
            .filter((p) => p.classification.blocks)
            .map((p) => `${p.kind}:${p.file}:${p.pair.currentId}`)
            .sort(),
        };
      };
      const a = await run();
      const b = await run();
      expect(a).toEqual(b);
      expect(a.verdict).toBe('BLOCKED');
    },
    HEAVY,
  );
});
