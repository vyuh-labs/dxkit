import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'fs';
import {
  buildCleanScenario,
  buildNetNewSecretScenario,
  gateTreeBaselineSurface,
  guardrailRefBasedSurface,
  type BuiltScenario,
  type VerdictProjection,
} from './parity-harness';

/**
 * 4.4.0 WP2 — the gate surface joins the WP0 parity matrix.
 *
 * The engine judging (materialized base tree → tree-baseline prior) must
 * agree with `guardrail check --mode ref-based --ref <base>` on the
 * FINDING-DIFF CORE over the same (prior, current) pair: verdict word,
 * exit code, and the blocking finding set with durable Rule-9
 * identities. The declared, disclosed differences between the two
 * surfaces stay out of this comparison and are asserted for what they
 * are: a tree prior has no base COMMIT, so the base-ref additive gates
 * skip `no-base-ref` (not attached) where ref-based mode can run them —
 * a disclosed absence, never a silent one.
 */

const HEAVY = 900_000;
const scenarios: BuiltScenario[] = [];
let savedSalt: string | undefined;

beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
});

afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
  for (const s of scenarios) rmSync(s.dir, { recursive: true, force: true });
});

/** The finding-diff core both surfaces must agree on. */
function core(p: VerdictProjection) {
  return {
    verdict: p.verdict,
    exitCode: p.exitCode,
    blocking: p.blocking,
    unattributable: p.unattributable,
  };
}

describe('gate (tree-baseline) vs guardrail (ref-based) over the same pair', () => {
  it(
    'clean scenario: both PASS with nothing blocking',
    async () => {
      const scenario = await buildCleanScenario();
      scenarios.push(scenario);
      const guardrail = await guardrailRefBasedSurface.run(scenario);
      const gate = await gateTreeBaselineSurface.run(scenario);
      expect(core(gate)).toEqual(core(guardrail));
      expect(gate.verdict).toMatch(/^PASSED/);
    },
    HEAVY,
  );

  it(
    'net-new-secret scenario: both BLOCK on the same finding with the same identity',
    async () => {
      const scenario = await buildNetNewSecretScenario();
      scenarios.push(scenario);
      const guardrail = await guardrailRefBasedSurface.run(scenario);
      const gate = await gateTreeBaselineSurface.run(scenario);
      expect(core(gate)).toEqual(core(guardrail));
      expect(gate.verdict).toBe('BLOCKED');
      const gateSecret = gate.blocking.find((f) => f.kind === 'secret');
      const guardrailSecret = guardrail.blocking.find((f) => f.kind === 'secret');
      // Rule 9 across the seam: the SAME leak, judged through the ref arm
      // and the dir arm, carries ONE durable identity.
      expect(gateSecret?.id).toBeDefined();
      expect(gateSecret?.id).toBe(guardrailSecret?.id);

      // The declared difference, asserted AS a disclosure: the dir prior
      // has no base commit, so the base-ref gates are absent on the gate
      // side (skip: no-base-ref, unattached) — never silently "ran clean".
      expect(gate.gates.flow).toBe('absent');
    },
    HEAVY,
  );
});
