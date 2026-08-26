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
 * never a silent done. A leftover the reader cannot honor (foreign, stale,
 * malformed) is REMOVED on read, so the disclosure fires once and only a
 * live, matching scope bypasses the verdict cache.
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

const scopeFile = (cwd: string): string => path.join(cwd, '.dxkit', 'loop', 'order.json');

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
    expect(fs.existsSync(scopeFile(cwd))).toBe(true);
    expect(readOrderScope(cwd, { expectedToken: '<lane-session-token>' }).scope).toEqual(scope());
    // A live, matching read leaves the file in place (the lane clears it).
    expect(fs.existsSync(scopeFile(cwd))).toBe(true);
    clearOrderScope(cwd);
    expect(fs.existsSync(scopeFile(cwd))).toBe(false);
    expect(readOrderScope(cwd, { expectedToken: '<lane-session-token>' })).toEqual({ scope: null });
  });

  it('a foreign token, a session with no token, and an over-age file all read absent WITH disclosure and are REMOVED (killed/concurrent lane leftover)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    const cases: Array<[string, Parameters<typeof readOrderScope>[1], string]> = [
      ['foreign', { expectedToken: '<another-lane-token>' }, 'different lane session'],
      ['tokenless', { expectedToken: undefined }, 'no order token'],
      [
        'stale',
        {
          expectedToken: '<lane-session-token>',
          now: () => Date.parse(scope().writtenAt) + ORDER_SCOPE_MAX_AGE_MS + 60_000,
        },
        'stale',
      ],
    ];
    for (const [, opts, phrase] of cases) {
      writeOrderScope(cwd, scope());
      const read = readOrderScope(cwd, opts);
      expect(read.scope).toBeNull();
      expect(read.problem).toContain(phrase);
      expect(read.problem).toContain('removed it');
      // The leftover is gone: the next stop neither re-discloses it nor
      // bypasses the verdict cache over it.
      expect(fs.existsSync(scopeFile(cwd))).toBe(false);
      expect(readOrderScope(cwd, opts)).toEqual({ scope: null });
    }
  });

  it('a malformed file is a DISCLOSED null, never a throw, and is removed (injection guard)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scope-'));
    const file = scopeFile(cwd);
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
      expect(read.problem).toContain('removed it');
      expect(fs.existsSync(file)).toBe(false);
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

  it('guardrail verifier: a RELOCATED target (priorId X paired with currentId Y) is still present, never done', () => {
    // The finding moved (a reindent, an insertion above it); the matcher
    // paired the baseline id with a new current id. Reading only currentId
    // certified the order done with the finding still in the tree.
    const json = payload([
      presentPair('fp-moved-now', { status: 'relocated', priorId: 'fp-one' } as Partial<Pair>),
    ]);
    const v = unresolvedOrderIds(scope({ absentIds: ['fp-one'] }), json, NO_FLOOR);
    expect(v.unresolved).toEqual(['fp-one']);
    // A genuinely removed target is done.
    const gone = payload([
      { ...presentPair('x'), currentId: undefined, priorId: 'fp-one', status: 'removed' } as Pair,
    ]);
    expect(unresolvedOrderIds(scope({ absentIds: ['fp-one'] }), gone, NO_FLOOR)).toEqual({
      unresolved: [],
    });
  });

  it('guardrail verifier: a target the run did NOT OBSERVE (incremental scan skipped its file) is undecidable, never done', () => {
    // The Stop-gate scans incrementally: a code finding in an untouched file
    // has a `not_observed` pair, not a `removed` one. That is absence of
    // observation, and the order stays undecided with the reason named.
    const json = payload([
      {
        ...presentPair('x'),
        currentId: undefined,
        priorId: 'fp-one',
        kind: 'code',
        status: 'not_observed',
      } as Pair,
    ]);
    const v = unresolvedOrderIds(scope({ absentIds: ['fp-one'], kinds: ['code'] }), json, NO_FLOOR);
    expect(v.unresolved).toEqual([]);
    expect(v.undecidable).toContain('fp-one');
    expect(v.undecidable).toContain('incremental');
    // A still-present sibling target wins over the undecidable one (block).
    const mixed = payload([
      ...json.pairs,
      presentPair('fp-two', { kind: 'code' } as Partial<Pair>),
    ]);
    const w = unresolvedOrderIds(
      scope({ absentIds: ['fp-one', 'fp-two'], kinds: ['code'] }),
      mixed,
      NO_FLOOR,
    );
    expect(w.unresolved).toEqual(['fp-two']);
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
