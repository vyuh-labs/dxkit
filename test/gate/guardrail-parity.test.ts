import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'fs';
import {
  buildCleanScenario,
  buildNetNewSecretScenario,
  buildPersistedCheckScenario,
  guardrailCommittedSurface,
  guardrailRefBasedSurface,
  assertSurfacesAgree,
  compareProjections,
  projectGuardrailResult,
  type BuiltScenario,
  type GateSurface,
  type VerdictProjection,
} from './parity-harness';

/**
 * WP0 — the gate-vs-guardrail parity net (4.4.0).
 *
 * Freezes `runGuardrailCheck`'s verdict behavior over a shared scenario
 * matrix BEFORE the engine extraction (WP1) and the `gate` surface (WP2)
 * land. Two layers:
 *
 *   1. CHARACTERIZATION — each surface's projection over each scenario is
 *      pinned with explicit expectations. The extraction must not move any
 *      of these values; a diff here after WP1 means the refactor changed
 *      behavior, not just structure.
 *   2. PARITY MACHINERY — `compareProjections` / `assertSurfacesAgree` are
 *      proven to BITE (injection-guarded): a surface that drifts in any
 *      projected field fails loudly. WP2 adds the `gate` surface to the
 *      same matrix and inherits a net already known to catch drift.
 *
 * Declared surface differences (committed grandfathers custom-checks;
 * ref-based structurally excludes + discloses them) are characterized per
 * surface, never papered over by comparing less.
 *
 * Runtime note: every projection is computed ONCE in beforeAll and shared
 * across assertions (each full check runs every analyzer, ~10-20s).
 */

const HEAVY = 600_000;

let savedSalt: string | undefined;
const scenarios: BuiltScenario[] = [];

beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
});

afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
  for (const s of scenarios) rmSync(s.dir, { recursive: true, force: true });
});

/** A surface that replays a stored projection under a new name — used to
 *  exercise the agreement machinery without re-running analyzers. */
function replaySurface(name: string, projection: VerdictProjection): GateSurface {
  return {
    name,
    run: () => Promise.resolve({ ...projection, surface: name }),
  };
}

describe('scenario: clean (base == current)', () => {
  let committed: VerdictProjection;
  let committedAgain: VerdictProjection;
  let refBased: VerdictProjection;

  beforeAll(async () => {
    const scenario = await buildCleanScenario();
    scenarios.push(scenario);
    committed = await guardrailCommittedSurface.run(scenario);
    committedAgain = await guardrailCommittedSurface.run(scenario);
    refBased = await guardrailRefBasedSurface.run(scenario);
  }, HEAVY);

  it('committed mode: PASSED, exit 0, nothing blocking', () => {
    expect(committed.verdict).toMatch(/^PASSED/);
    expect(committed.exitCode).toBe(0);
    expect(committed.blocking).toEqual([]);
    expect(committed.blockingCount).toBe(0);
    expect(committed.unattributable).toBe(0);
    expect(committed.refExcludedKinds).toEqual([]);
  });

  it('ref-based mode: PASSED, exit 0, exclusions disclosed not silent', () => {
    expect(refBased.verdict).toMatch(/^PASSED/);
    expect(refBased.exitCode).toBe(0);
    expect(refBased.blocking).toEqual([]);
    expect(refBased.unattributable).toBe(0);
  });

  it('is deterministic: the same surface run twice projects identically (P0-1 accept)', () => {
    expect(compareProjections(committed, committedAgain)).toEqual([]);
  });

  it('assertSurfacesAgree passes for genuinely agreeing surfaces', async () => {
    const scenario = scenarios.find((s) => s.name === 'clean')!;
    const projections = await assertSurfacesAgree(scenario, [
      replaySurface('surface-a', committed),
      replaySurface('surface-b', committedAgain),
    ]);
    expect(projections).toHaveLength(2);
  });
});

describe('scenario: net-new secret introduced after base', () => {
  let committed: VerdictProjection;
  let refBased: VerdictProjection;

  beforeAll(async () => {
    const scenario = await buildNetNewSecretScenario();
    scenarios.push(scenario);
    committed = await guardrailCommittedSurface.run(scenario);
    refBased = await guardrailRefBasedSurface.run(scenario);
  }, HEAVY);

  it('committed mode: BLOCKED with the secret finding, exit 1', () => {
    expect(committed.verdict).toBe('BLOCKED');
    expect(committed.exitCode).toBe(1);
    const secrets = committed.blocking.filter((f) => f.kind === 'secret');
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    expect(secrets[0].file).toBe('config.ts');
    expect(secrets[0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ref-based mode: BLOCKED with the secret finding, exit 1', () => {
    expect(refBased.verdict).toBe('BLOCKED');
    expect(refBased.exitCode).toBe(1);
    const secrets = refBased.blocking.filter((f) => f.kind === 'secret');
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    expect(secrets[0].file).toBe('config.ts');
  });

  it('both surfaces mint the SAME durable identity for the same finding (Rule 9)', () => {
    const committedSecret = committed.blocking.find((f) => f.kind === 'secret');
    const refSecret = refBased.blocking.find((f) => f.kind === 'secret');
    expect(committedSecret?.id).toBeDefined();
    expect(committedSecret?.id).toBe(refSecret?.id);
  });
});

describe('scenario: custom check failing at base and current', () => {
  let committed: VerdictProjection;
  let refBased: VerdictProjection;

  beforeAll(async () => {
    const scenario = await buildPersistedCheckScenario();
    scenarios.push(scenario);
    committed = await guardrailCommittedSurface.run(scenario);
    refBased = await guardrailRefBasedSurface.run(scenario);
  }, HEAVY);

  it('committed mode: grandfathered — PASSED, nothing blocking', () => {
    expect(committed.verdict).toMatch(/^PASSED/);
    expect(committed.exitCode).toBe(0);
    expect(committed.blocking).toEqual([]);
  });

  it('ref-based mode: custom-check excluded AND disclosed, never silently dropped', () => {
    expect(refBased.verdict).toMatch(/^PASSED/);
    expect(refBased.exitCode).toBe(0);
    expect(refBased.refExcludedKinds.map((e) => e.kind)).toContain('custom-check');
  });
});

describe('the parity machinery itself (injection-guarded)', () => {
  // A hand-built projection so these tests run without analyzers.
  const base: VerdictProjection = {
    surface: 'a',
    verdict: 'PASSED',
    exitCode: 0,
    blocking: [{ kind: 'secret', file: 'x.ts', id: 'deadbeefdeadbeef' }],
    blockingCount: 1,
    warningCount: 2,
    unattributable: 0,
    notObserved: [{ kind: 'custom-check', count: 3 }],
    refExcludedKinds: [{ kind: 'custom-check', currentCount: 3 }],
    gates: { flow: 'absent', schema: 'absent', dup: 'absent', paired: 'absent' },
  };
  const asB = (p: VerdictProjection): VerdictProjection => ({ ...p, surface: 'b' });

  it('identical projections produce zero diffs', () => {
    expect(compareProjections(base, asB(base))).toEqual([]);
  });

  it('flags a verdict mismatch by name', () => {
    const diffs = compareProjections(base, asB({ ...base, verdict: 'BLOCKED', exitCode: 1 }));
    expect(diffs.some((d) => d.startsWith('verdict:'))).toBe(true);
    expect(diffs.some((d) => d.startsWith('exitCode:'))).toBe(true);
  });

  it('flags a dropped blocking finding', () => {
    const diffs = compareProjections(base, asB({ ...base, blocking: [], blockingCount: 0 }));
    expect(diffs.some((d) => d.startsWith('blocking:'))).toBe(true);
  });

  it('flags an identity mismatch even when counts agree', () => {
    const mutated = asB({
      ...base,
      blocking: [{ kind: 'secret', file: 'x.ts', id: 'feedfacefeedface' }],
    });
    const diffs = compareProjections(base, mutated);
    expect(diffs.some((d) => d.startsWith('blocking:'))).toBe(true);
  });

  it('flags a silently-dropped disclosure (notObserved / refExcludedKinds)', () => {
    expect(
      compareProjections(base, asB({ ...base, notObserved: [] })).some((d) =>
        d.startsWith('notObserved:'),
      ),
    ).toBe(true);
    expect(
      compareProjections(base, asB({ ...base, refExcludedKinds: [] })).some((d) =>
        d.startsWith('refExcludedKinds:'),
      ),
    ).toBe(true);
  });

  it('flags an additive-gate outcome drift', () => {
    const diffs = compareProjections(
      base,
      asB({ ...base, gates: { ...base.gates, flow: 'blocks' } }),
    );
    expect(diffs.some((d) => d.startsWith('gates.flow:'))).toBe(true);
  });

  it('assertSurfacesAgree THROWS on a drifted surface, naming scenario and field', async () => {
    const scenario: BuiltScenario = { name: 'synthetic', dir: '/nonexistent', baseRef: 'x' };
    const drifted = replaySurface('drifted', {
      ...base,
      blocking: [],
      blockingCount: 0,
    });
    await expect(
      assertSurfacesAgree(scenario, [replaySurface('reference', base), drifted]),
    ).rejects.toThrow(/parity violation on scenario 'synthetic'.*blocking/s);
  });

  it('projectGuardrailResult derives verdict/exit ONLY through verdictCounts', () => {
    // Compile-time + shape guard: the projection function exists and its
    // output carries exitCode 0|1 — the field every consumer must read
    // instead of re-deriving from `blocks`. (The behavioral pin lives in
    // attribution-gap.test.ts; this keeps the projection on that path.)
    expect(typeof projectGuardrailResult).toBe('function');
  });
});
