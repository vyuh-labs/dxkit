/**
 * The Stop-gate's order scope (section 3C): the remediate lane writes the
 * current order's done criterion to `.dxkit/loop/order.json`; the gate
 * consumes it and blocks the agent's stop while the order's target findings
 * are still present, handing back exactly the ids left to close. Absent
 * file = every pre-existing gate behavior. Injection-guarded: the file is
 * repo-local state, the check executes NOTHING (it post-processes the
 * already-computed guardrail payload + floor outcome), a malformed or
 * hostile file degrades to a DISCLOSED skip, a foreign or stale file (a
 * killed or concurrent lane's leftover) is neutralized by the session
 * token binding, and a done question the gate's data cannot answer — an
 * unobserved kind, a skipped floor check — is UNDECIDABLE with disclosure,
 * never a silent done.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeStopGate } from '../../src/loop/stop-gate';
import type { FloorGateOutcome } from '../../src/loop/floor-gate';
import type { GuardrailJsonPayload } from '../../src/baseline/check-renderers';
import {
  ORDER_SCOPE_MAX_AGE_MS,
  clearOrderScope,
  floorOrderDone,
  orderScopePresent,
  readOrderScope,
  unresolvedOrderIds,
  writeOrderScope,
  type OrderScope,
} from '../../src/loop/order-scope';

type Pair = GuardrailJsonPayload['pairs'][number];

function payload(
  pairs: Pair[],
  extra: Partial<Pick<GuardrailJsonPayload, 'notObserved' | 'refExcludedKinds'>> = {},
): GuardrailJsonPayload {
  const blocks = pairs.some((p) => p.blocks && !p.suppressedByAllowlist);
  return {
    verdict: { blocks, warns: false, refused: false, exitCode: blocks ? 1 : 0 },
    attributionGaps: [],
    notObserved: [],
    refExcludedKinds: [],
    baseline: { findingsCount: 10 },
    current: { branch: 'main', commitSha: 'deadbeef', findingsCount: 12 },
    pairs,
    ...extra,
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

const WRITTEN_AT = new Date().toISOString();

function scope(over: Partial<OrderScope> = {}): OrderScope {
  return {
    orderId: 'lint-located:src/a.ts',
    absentIds: ['fp-one', 'fp-two'],
    kinds: ['custom-check'],
    envelope: { paths: ['src/a.ts'], manifests: false },
    verifier: 'guardrail',
    command: 'npx vyuh-dxkit guardrail check',
    token: '<lane-session-token>',
    writtenAt: WRITTEN_AT,
    ...over,
  };
}

const NO_FLOOR: FloorGateOutcome = { kind: 'unavailable', reason: 'not wired' };
const ranFloor = (
  checks: Array<{ pack: string; label: string; status?: string; findings?: string[] }>,
): FloorGateOutcome => ({
  kind: 'ran',
  result: {
    ran: true,
    checks: checks.map((f) => ({ bin: 'x', status: 'fail', ...f })),
    blocks: checks.some((c) => (c.status ?? 'fail') === 'fail'),
  } as never,
  netNew: [],
});

describe('the order-scope module (write / read / clear, validating + session-bound reader)', () => {
  it('round-trips a scope under its own token and clears it', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    writeOrderScope(cwd, scope());
    expect(orderScopePresent(cwd)).toBe(true);
    expect(readOrderScope(cwd, { expectedToken: '<lane-session-token>' }).scope).toEqual(scope());
    clearOrderScope(cwd);
    expect(orderScopePresent(cwd)).toBe(false);
    expect(readOrderScope(cwd, { expectedToken: '<lane-session-token>' })).toEqual({ scope: null });
  });

  it('a foreign token, a session with no token, and an over-age file all read absent WITH disclosure (killed/concurrent lane)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    writeOrderScope(cwd, scope());
    const foreign = readOrderScope(cwd, { expectedToken: '<another-lane-token>' });
    expect(foreign.scope).toBeNull();
    expect(foreign.problem).toContain('different lane session');
    const tokenless = readOrderScope(cwd, { expectedToken: undefined });
    expect(tokenless.scope).toBeNull();
    expect(tokenless.problem).toContain('no order token');
    const stale = readOrderScope(cwd, {
      expectedToken: '<lane-session-token>',
      now: () => Date.parse(scope().writtenAt) + ORDER_SCOPE_MAX_AGE_MS + 60_000,
    });
    expect(stale.scope).toBeNull();
    expect(stale.problem).toContain('stale');
    // The file itself still exists (the cache-bypass question), so a cached
    // ALLOW is never replayed over it.
    expect(orderScopePresent(cwd)).toBe(true);
  });

  it('a malformed file is a DISCLOSED null, never a throw (injection guard)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    const file = path.join(cwd, '.dxkit', 'loop', 'order.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const hostile of [
      'not json at all',
      '{"orderId": 42}',
      '{"orderId":"x","absentIds":"not-an-array","kinds":[],"verifier":"floor","command":"c","token":"<any-token>","writtenAt":"now","envelope":{"paths":[],"manifests":false}}',
      '{"orderId":"x","absentIds":[],"kinds":[],"verifier":"rm -rf /","command":"c","token":"<any-token>","writtenAt":"now","envelope":{"paths":[],"manifests":false}}',
      // The pre-session-binding shape (no token/writtenAt) is malformed too.
      '{"orderId":"x","absentIds":[],"verifier":"floor","command":"c","envelope":{"paths":[],"manifests":false}}',
    ]) {
      fs.writeFileSync(file, hostile);
      const read = readOrderScope(cwd, { expectedToken: '<any-token>' });
      expect(read.scope).toBeNull();
      expect(read.problem).toBeTruthy();
      expect(orderScopePresent(cwd)).toBe(true);
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

  it('guardrail verifier: an UNOBSERVED target kind is undecidable, never silently done (Rule 19)', () => {
    // The target finding has no pair — but its kind was not observed at all
    // (custom-check dropped in ref-based mode / the check did not run), so
    // "no pair" is absence of observation, not absence of the finding.
    const notObserved = payload([], {
      notObserved: [{ kind: 'custom-check', reason: 'linter unavailable', count: 3 }] as never,
    });
    const a = unresolvedOrderIds(scope(), notObserved, NO_FLOOR);
    expect(a.unresolved).toEqual([]);
    expect(a.undecidable).toContain('custom-check');
    const refExcluded = payload([], {
      refExcludedKinds: [{ kind: 'custom-check', currentCount: 5 }],
    });
    const b = unresolvedOrderIds(scope(), refExcluded, NO_FLOOR);
    expect(b.undecidable).toContain('custom-check');
    // An observed kind still resolves normally.
    const observed = unresolvedOrderIds(scope(), payload([]), NO_FLOOR);
    expect(observed.unresolved).toEqual([]);
    expect(observed.undecidable).toBeUndefined();
  });

  it('floor verifier: a SKIPPED or absent target check is undecidable with disclosure, never silently done', () => {
    const s = scope({ verifier: 'floor', absentIds: ['typescript:tests', 'go:build'] });
    const skipped = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([
        { pack: 'typescript', label: 'tests', status: 'skipped-timeout' },
        // go:build absent from the run entirely
      ]),
    );
    expect(skipped.unresolved).toEqual([]);
    expect(skipped.undecidable).toContain('typescript:tests');
    expect(skipped.undecidable).toContain('go:build');
    const failing = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([
        { pack: 'typescript', label: 'tests', status: 'fail' },
        { pack: 'go', label: 'build', status: 'pass' },
      ]),
    );
    expect(failing.unresolved).toEqual(['typescript:tests']);
    const notRun = unresolvedOrderIds(s, payload([]), NO_FLOOR);
    expect(notRun.unresolved).toEqual([]);
    expect(notRun.undecidable).toContain('did not run');
  });

  it('floor verifier: finding-level done — own findings judged individually; sibling-only failure is done WITH disclosure', () => {
    const s = scope({
      orderId: 'unresolved-import:typescript:.',
      verifier: 'floor',
      absentIds: ['typescript:import-resolution#left-pad', 'typescript:import-resolution#lodash'],
    });
    // Own finding still present → open (exactly it, not the sibling).
    const stillOpen = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([
        { pack: 'typescript', label: 'import-resolution', status: 'fail', findings: ['left-pad'] },
      ]),
    );
    expect(stillOpen.unresolved).toEqual(['typescript:import-resolution#left-pad']);
    // Own findings gone, check red only on a DIFFERENT order's finding →
    // done with disclosure (the agent that fixed exactly its order may stop).
    const siblingOnly = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([
        { pack: 'typescript', label: 'import-resolution', status: 'fail', findings: ['chalk'] },
      ]),
    );
    expect(siblingOnly.unresolved).toEqual([]);
    expect(siblingOnly.undecidable).toBeUndefined();
    expect(siblingOnly.disclosure).toContain('outside this order');
    // A finding-level id against a failure with no decomposition → undecided.
    const noDecomposition = unresolvedOrderIds(
      s,
      payload([]),
      ranFloor([{ pack: 'typescript', label: 'import-resolution', status: 'fail' }]),
    );
    expect(noDecomposition.unresolved).toEqual([]);
    expect(noDecomposition.undecidable).toContain('finding decomposition');
  });

  it('floorOrderDone is the ONE computation (open / undecided / siblingOnly split)', () => {
    const verdict = floorOrderDone(['a:b#one', 'a:b#two', 'a:c', 'a:missing'], [
      { pack: 'a', label: 'b', status: 'fail', findings: ['one'] },
      { pack: 'a', label: 'c', status: 'pass' },
    ] as never);
    expect(verdict.open).toEqual(['a:b#one']);
    expect(verdict.siblingOnly).toEqual(['a:b#two']);
    expect(verdict.undecided).toEqual(['a:missing']);
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
    expect(d.message).not.toContain('unrelated');
    expect(d.message).toContain('npx vyuh-dxkit guardrail check');
    expect(d.event.allowed).toBe(false);
  });

  it('allows the stop once every target id is absent (kind observed)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([presentPair('unrelated')]),
      () => NO_FLOOR,
      () => ({ scope: scope() }),
    );
    expect(d.outcome).toBe('allow');
  });

  it('an unobserved kind or an unanswerable floor allows, DISCLOSED (never a silent done)', async () => {
    const unobserved = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([], { refExcludedKinds: [{ kind: 'custom-check', currentCount: 2 }] }),
      () => NO_FLOOR,
      () => ({ scope: scope() }),
    );
    expect(unobserved.outcome).toBe('allow');
    expect(unobserved.message).toContain('could not verify work order');
    const floorless = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () => NO_FLOOR,
      () => ({ scope: scope({ verifier: 'floor', absentIds: ['typescript:tests'] }) }),
    );
    expect(floorless.outcome).toBe('allow');
    expect(floorless.message).toContain('could not verify work order');
  });

  it('a sibling-only floor failure allows with the disclosure riding stderr', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () =>
        ranFloor([
          { pack: 'typescript', label: 'import-resolution', status: 'fail', findings: ['chalk'] },
        ]),
      () => ({
        scope: scope({
          verifier: 'floor',
          absentIds: ['typescript:import-resolution#left-pad'],
        }),
      }),
    );
    expect(d.outcome).toBe('allow');
    expect(d.message).toContain('outside this order');
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

  it('a malformed/foreign/stale scope is a disclosed skip riding the allow (never a block, never a throw)', async () => {
    const d = await computeStopGate(
      '/repo',
      { session_id: 's' },
      async () => payload([]),
      () => NO_FLOOR,
      () => ({ scope: null, problem: 'order scope at /x belongs to a different lane session' }),
    );
    expect(d.outcome).toBe('allow');
    expect(d.message).toContain('different lane session');
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
