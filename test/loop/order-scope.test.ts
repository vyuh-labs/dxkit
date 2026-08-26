/**
 * The Stop-gate's order scope (section 3C): the remediate lane writes the
 * current order's done criterion to `.dxkit/loop/order.json`; the gate
 * consumes it and blocks the agent's stop while the order's target findings
 * are still present, handing back exactly the ids left to close. Absent
 * file = every pre-existing gate behavior. Injection-guarded: the file is
 * repo-local state, the check executes NOTHING (it post-processes the
 * already-computed guardrail payload + floor outcome), and a malformed or
 * hostile file degrades to a DISCLOSED skip, never a throw and never a
 * widened execution.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeStopGate } from '../../src/loop/stop-gate';
import type { FloorGateOutcome } from '../../src/loop/floor-gate';
import type { GuardrailJsonPayload } from '../../src/baseline/check-renderers';
import {
  clearOrderScope,
  readOrderScope,
  unresolvedOrderIds,
  writeOrderScope,
  type OrderScope,
} from '../../src/loop/order-scope';

type Pair = GuardrailJsonPayload['pairs'][number];

function payload(pairs: Pair[]): GuardrailJsonPayload {
  const blocks = pairs.some((p) => p.blocks && !p.suppressedByAllowlist);
  return {
    verdict: { blocks, warns: false, refused: false, exitCode: blocks ? 1 : 0 },
    attributionGaps: [],
    baseline: { findingsCount: 10 },
    current: { branch: 'main', commitSha: 'deadbeef', findingsCount: 12 },
    pairs,
  } as unknown as GuardrailJsonPayload;
}

function presentPair(currentId: string, over: Partial<Pair> = {}): Pair {
  return {
    status: 'persisted',
    blocks: false,
    warns: false,
    confidence: 1,
    kind: 'custom-check',
    currentId,
    reasons: [],
    ...over,
  } as Pair;
}

function scope(over: Partial<OrderScope> = {}): OrderScope {
  return {
    orderId: 'lint-located:src/a.ts',
    absentIds: ['fp-one', 'fp-two'],
    envelope: { paths: ['src/a.ts'], manifests: false },
    verifier: 'guardrail',
    command: 'npx vyuh-dxkit guardrail check',
    ...over,
  };
}

const NO_FLOOR: FloorGateOutcome = { kind: 'unavailable', reason: 'not wired' };
const ranFloor = (failing: Array<{ pack: string; label: string }>): FloorGateOutcome => ({
  kind: 'ran',
  result: {
    ran: true,
    checks: failing.map((f) => ({ ...f, bin: 'x', status: 'fail' })),
    blocks: failing.length > 0,
  } as never,
  netNew: [],
});

describe('the order-scope module (write / read / clear, validating reader)', () => {
  it('round-trips a scope and clears it', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    writeOrderScope(cwd, scope());
    expect(readOrderScope(cwd).scope).toEqual(scope());
    clearOrderScope(cwd);
    expect(readOrderScope(cwd).scope).toBeNull();
  });

  it('absent file reads as no scope, with no problem', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    expect(readOrderScope(cwd)).toEqual({ scope: null });
  });

  it('a malformed file is a DISCLOSED null, never a throw (injection guard)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    const file = path.join(cwd, '.dxkit', 'loop', 'order.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const hostile of [
      'not json at all',
      '{"orderId": 42}',
      '{"orderId":"x","absentIds":"not-an-array","verifier":"floor","command":"c","envelope":{"paths":[],"manifests":false}}',
      '{"orderId":"x","absentIds":[],"verifier":"rm -rf /","command":"c","envelope":{"paths":[],"manifests":false}}',
    ]) {
      fs.writeFileSync(file, hostile);
      const read = readOrderScope(cwd);
      expect(read.scope).toBeNull();
      expect(read.problem).toBeTruthy();
    }
  });
});

describe('unresolvedOrderIds (judged from computed state only — nothing executes)', () => {
  it('guardrail verifier: an id is present when any pair carries it as currentId, allowlist-waived included', () => {
    const json = payload([
      presentPair('fp-one'),
      presentPair('fp-waived', {
        suppressedByAllowlist: { fingerprint: 'fp-waived', category: 'lint' },
      } as Partial<Pair>),
    ]);
    const v = unresolvedOrderIds(
      scope({ absentIds: ['fp-one', 'fp-waived', 'fp-closed'] }),
      json,
      NO_FLOOR,
    );
    expect(v.unresolved).toEqual(['fp-one', 'fp-waived']);
  });

  it('floor verifier: an id is open while its check key still fails; a not-run floor is undecidable (fail-open, disclosed)', () => {
    const s = scope({
      verifier: 'floor',
      absentIds: ['typescript:tests#one', 'go:build'],
    });
    const failing = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([{ pack: 'typescript', label: 'tests' }]),
    );
    expect(failing.unresolved).toEqual(['typescript:tests#one']);
    const undecidable = unresolvedOrderIds(s, payload([]), NO_FLOOR);
    expect(undecidable.unresolved).toEqual([]);
    expect(undecidable.undecidable).toContain('did not run');
  });
});

describe('computeStopGate with an order scope', () => {
  it('blocks the stop while the order target findings are still present, naming exactly those ids', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([presentPair('fp-one'), presentPair('unrelated')]),
      () => NO_FLOOR,
      () => ({ scope: scope() }),
    );
    expect(d.outcome).toBe('block-model');
    expect(d.message).toContain('lint-located:src/a.ts');
    expect(d.message).toContain('fp-one');
    expect(d.message).not.toContain('fp-two\n- unrelated');
    expect(d.message).not.toContain('unrelated');
    expect(d.message).toContain('npx vyuh-dxkit guardrail check');
    expect(d.event.allowed).toBe(false);
  });

  it('allows the stop once every target id is absent', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([presentPair('unrelated')]),
      () => NO_FLOOR,
      () => ({ scope: scope() }),
    );
    expect(d.outcome).toBe('allow');
  });

  it('a floor-verifier scope the floor cannot answer allows, DISCLOSED (never a silent skip)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () => NO_FLOOR,
      () => ({ scope: scope({ verifier: 'floor', absentIds: ['typescript:tests'] }) }),
    );
    expect(d.outcome).toBe('allow');
    expect(d.message).toContain('could not verify work order');
  });

  it('no scope file keeps every pre-existing behavior (legacy allow)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () => NO_FLOOR,
      () => ({ scope: null }),
    );
    expect(d.outcome).toBe('allow');
    expect(d.message).toBe('');
  });

  it('a malformed scope file is a disclosed skip riding the allow (never a block, never a throw)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () => NO_FLOOR,
      () => ({ scope: null, problem: 'order scope at /x is malformed — ignoring it' }),
    );
    expect(d.outcome).toBe('allow');
    expect(d.message).toContain('malformed');
  });

  it('the guardrail net-new block still wins over the order scope (order checked only on an otherwise-allow)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () =>
        payload([presentPair('fp-one', { blocks: true, status: 'added' } as Partial<Pair>)]),
      () => NO_FLOOR,
      () => ({ scope: scope() }),
    );
    expect(d.outcome).toBe('block-model');
    // The net-new repair message, not the order message.
    expect(d.message).not.toContain('work order');
  });
});
