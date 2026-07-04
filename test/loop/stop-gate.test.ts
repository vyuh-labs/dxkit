import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeStopGate, buildRepairMessage } from '../../src/loop/stop-gate';
import { buildFloorRepairMessage, type FloorGateOutcome } from '../../src/loop/floor-gate';
import type { GuardrailJsonPayload } from '../../src/baseline/check-renderers';
import type { CorrectnessCheckResult } from '../../src/analyzers/correctness/run';

/**
 * The Stop-gate decides whether an autonomous loop may declare "done".
 * `computeStopGate` takes an injected `runCheck` so these tests drive
 * every branch (clean / net-new block / allowlist-waived / guardrail
 * couldn't run) without a real repo + baseline.
 */
type Pair = GuardrailJsonPayload['pairs'][number];

function payload(pairs: Pair[]): GuardrailJsonPayload {
  return {
    baseline: { findingsCount: 1020 },
    current: { branch: 'feature/x', commitSha: 'deadbeef', findingsCount: 1022 },
    pairs,
  } as unknown as GuardrailJsonPayload;
}

function blockingPair(over: Partial<Pair> = {}): Pair {
  return {
    status: 'added',
    blocks: true,
    warns: false,
    confidence: 1,
    kind: 'code',
    severity: 'high',
    file: 'src/routes/debug.ts',
    line: 42,
    reasons: [
      { code: 'no-prior-match', detail: 'identity fingerprint not present in the baseline' },
    ],
    ...over,
  } as Pair;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env.DXKIT_LOOP_FAIL_OPEN;
  delete process.env.DXKIT_LOOP_TEST_COMMAND;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('computeStopGate', () => {
  it('allows the stop when there are no blocking pairs', async () => {
    const d = await computeStopGate('/repo', { session_id: 's' }, async () => payload([]));
    expect(d.outcome).toBe('allow');
    expect(d.event.allowed).toBe(true);
    expect(d.event.guardrail_status).toBe('pass');
    expect(d.event.net_new_findings).toBe(0);
  });

  it('blocks the model with a repair message on a net-new finding', async () => {
    const d = await computeStopGate('/repo', { session_id: 's' }, async () =>
      payload([blockingPair()]),
    );
    expect(d.outcome).toBe('block-model');
    expect(d.event.allowed).toBe(false);
    expect(d.event.guardrail_status).toBe('fail');
    expect(d.event.net_new_findings).toBe(1);
    expect(d.message).toContain('src/routes/debug.ts:42');
    expect(d.message).toContain('Do not refresh the baseline');
  });

  it('does NOT count an allowlist-waived pair as blocking', async () => {
    const waived = blockingPair({
      suppressedByAllowlist: { fingerprint: 'abc', category: 'false-positive' },
    });
    const d = await computeStopGate('/repo', { session_id: 's' }, async () => payload([waived]));
    expect(d.outcome).toBe('allow');
    expect(d.event.net_new_findings).toBe(0);
  });

  it('records stop_hook_active on the ledger event', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's', stop_hook_active: true },
      async () => payload([blockingPair()]),
    );
    expect(d.event.stop_hook_active).toBe(true);
    expect(d.outcome).toBe('block-model'); // still blocks while unsafe
  });

  describe('guardrail could not run (config/preflight error)', () => {
    const boom = async (): Promise<GuardrailJsonPayload> => {
      throw new Error('no baseline found');
    };

    it('blocks the operator on the first attempt (fail closed)', async () => {
      const d = await computeStopGate('/repo', { session_id: 's', stop_hook_active: false }, boom);
      expect(d.outcome).toBe('block-operator');
      expect(d.event.guardrail_status).toBe('error');
      expect(d.event.allowed).toBe(false);
      expect(d.message).toContain('loop doctor');
    });

    it('allows once already continuing (anti-thrash) since the model cannot fix it', async () => {
      const d = await computeStopGate('/repo', { session_id: 's', stop_hook_active: true }, boom);
      expect(d.outcome).toBe('allow');
      expect(d.event.allowed).toBe(true);
    });

    it('allows immediately under DXKIT_LOOP_FAIL_OPEN=1', async () => {
      process.env.DXKIT_LOOP_FAIL_OPEN = '1';
      const d = await computeStopGate('/repo', { session_id: 's', stop_hook_active: false }, boom);
      expect(d.outcome).toBe('allow');
    });
  });

  describe('configured test command', () => {
    // The configured-test-command path actually shells out (cwd = repo),
    // so these use a real directory rather than the synthetic '/repo'.
    it('blocks the model when the guardrail passes but tests fail', async () => {
      process.env.DXKIT_LOOP_TEST_COMMAND = 'exit 1';
      const d = await computeStopGate(process.cwd(), { session_id: 's' }, async () => payload([]));
      expect(d.outcome).toBe('block-model');
      expect(d.event.guardrail_status).toBe('pass');
      expect(d.event.tests_status).toBe('fail');
    });

    it('allows when both the guardrail and the test command pass', async () => {
      process.env.DXKIT_LOOP_TEST_COMMAND = 'exit 0';
      const d = await computeStopGate(process.cwd(), { session_id: 's' }, async () => payload([]));
      expect(d.outcome).toBe('allow');
      expect(d.event.tests_status).toBe('pass');
    });
  });

  describe('correctness floor', () => {
    const failCheck = (label: string): CorrectnessCheckResult => ({
      pack: 'typescript',
      label,
      bin: 'npx',
      status: 'fail',
      output: 'error TS2322: not assignable',
    });
    const passCheck = (label: string): CorrectnessCheckResult => ({
      pack: 'typescript',
      label,
      bin: 'npx',
      status: 'pass',
    });
    const floor = (
      checks: CorrectnessCheckResult[],
      netNew: CorrectnessCheckResult[],
    ): FloorGateOutcome => ({
      result: {
        ran: checks.some((c) => c.status === 'pass' || c.status === 'fail'),
        checks,
        blocks: checks.some((c) => c.status === 'fail'),
      },
      netNew,
    });

    it('blocks the model on a net-new floor failure with a repair message', async () => {
      const tc = failCheck('typecheck');
      const d = await computeStopGate(
        '/repo',
        { session_id: 's' },
        async () => payload([]),
        () => floor([tc], [tc]),
      );
      expect(d.outcome).toBe('block-model');
      expect(d.event.guardrail_status).toBe('pass');
      expect(d.event.typecheck_status).toBe('fail');
      expect(d.message).toContain('typescript typecheck');
      expect(d.message).toContain('Do not refresh the floor snapshot');
      expect(d.message).toContain('TS2322');
    });

    it('does NOT block on a pre-existing floor failure (empty net-new)', async () => {
      const tc = failCheck('affected-tests');
      const d = await computeStopGate(
        '/repo',
        { session_id: 's' },
        async () => payload([]),
        () => floor([tc], []), // failing, but net-new is empty → grandfathered
      );
      expect(d.outcome).toBe('allow');
    });

    it('records floor pass status on a clean stop', async () => {
      const d = await computeStopGate(
        '/repo',
        { session_id: 's' },
        async () => payload([]),
        () => floor([passCheck('typecheck'), passCheck('affected-tests')], []),
      );
      expect(d.outcome).toBe('allow');
      expect(d.event.typecheck_status).toBe('pass');
      expect(d.event.tests_status).toBe('pass');
    });

    it('is a no-op when no pack provides a floor (null)', async () => {
      const d = await computeStopGate(
        '/repo',
        { session_id: 's' },
        async () => payload([]),
        () => null,
      );
      expect(d.outcome).toBe('allow');
    });

    it('does not consult the floor when the guardrail already blocks', async () => {
      let floorCalled = false;
      const d = await computeStopGate(
        '/repo',
        { session_id: 's' },
        async () => payload([blockingPair()]),
        () => {
          floorCalled = true;
          return null;
        },
      );
      expect(d.outcome).toBe('block-model'); // guardrail block, not floor
      expect(floorCalled).toBe(false);
    });
  });
});

describe('buildFloorRepairMessage', () => {
  it('numbers each net-new failing check with its captured output', () => {
    const msg = buildFloorRepairMessage([
      {
        pack: 'typescript',
        label: 'typecheck',
        bin: 'npx',
        status: 'fail',
        output: 'error TS1005',
      },
      { pack: 'go', label: 'build', bin: 'go', status: 'fail', output: 'undefined: Foo' },
    ]);
    expect(msg).toContain('introduces 2 net-new correctness failures');
    expect(msg).toContain('1. typescript typecheck');
    expect(msg).toContain('TS1005');
    expect(msg).toContain('2. go build');
  });
});

describe('buildRepairMessage', () => {
  it('numbers each net-new finding with its location and severity', () => {
    const msg = buildRepairMessage(
      payload([
        blockingPair({ file: 'a.ts', line: 1, kind: 'code', severity: 'high' }),
        blockingPair({ file: 'b.env', line: 3, kind: 'secret', severity: undefined }),
      ]),
    );
    expect(msg).toContain('introduces 2 net-new findings');
    expect(msg).toContain('1. code [high]');
    expect(msg).toContain('a.ts:1');
    expect(msg).toContain('2. secret');
    expect(msg).toContain('b.env:3');
  });
});
