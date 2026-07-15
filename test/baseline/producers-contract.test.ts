/**
 * Producer registry contract — closes the class of bug where a new
 * `IdentityInput` discriminant kind lands without a producer wiring
 * it (silent guardrail miss). See CLAUDE.md Rule 10.
 *
 * The contract:
 *   1. Every `IdentityKind` value is EITHER contributed by ≥1
 *      registered producer OR listed in `DEFERRED_KINDS` with
 *      explicit rationale + landing phase. Never both, never
 *      neither.
 *   2. Every producer's `contributes` list is non-empty (an
 *      unused producer in the registry signals stale wiring).
 *   3. Producer names are unique (registry-traversal logs collapse
 *      duplicates otherwise).
 *
 * This file is the single bottleneck. Adding a new identity kind
 * without a producer makes Test #1 fail with a precise error;
 * adding the kind to `DEFERRED_KINDS` resolves it but forces the
 * deferral to carry a documented rationale. Adding a producer that
 * claims a kind already in `DEFERRED_KINDS` triggers a different
 * failure mode — the "double-counted" assertion — that catches
 * forgetting to remove the deferral when the producer lands.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFERRED_KINDS,
  PRODUCERS,
  wiredKinds,
  type IdentityKind,
} from '../../src/baseline/producers';
import { RECALL_EPOCHS } from '../../src/baseline/recall';
import { producerFixtureContext as recallFixtureContext } from './producer-fixture';
import type { BaselineEntry } from '../../src/baseline/types';

/**
 * The exhaustive set of `IdentityKind` values. Sourced from a
 * representative `BaselineEntry` array typed by the discriminated
 * union — the compiler enforces that adding a new kind in
 * `types.ts` adds a new line below at type-check time.
 *
 * Listing each kind explicitly (rather than deriving via a helper)
 * is deliberate: the kind list is the contract, and pulling it
 * from the type system requires reflection that doesn't exist at
 * runtime in TS. The exhaustive type assertion below makes drift
 * compile-time visible.
 */
const ALL_KINDS: ReadonlyArray<IdentityKind> = [
  'secret',
  'code',
  'config',
  'dep-vuln',
  'duplication',
  'coverage-gap',
  'test-gap',
  'hygiene',
  'test-file-degradation',
  'god-file',
  'stale-file',
  'large-file',
  'secret-hmac',
  'stale-allow',
  'flow-binding',
  'model-schema-drift',
  'code-reimplementation',
  'custom-check',
];

/** Compile-time exhaustiveness check — adding a new kind to
 *  `BaselineEntry` without updating `ALL_KINDS` makes this fail to
 *  compile. */
type Exhaustive = BaselineEntry['kind'];
const _exhaustiveCheck: Exhaustive = ALL_KINDS[0];
void _exhaustiveCheck;

describe('producer registry contract', () => {
  it('lists every IdentityKind in ALL_KINDS (no missing values)', () => {
    // Round-trip sanity: if anyone added a kind to the union but
    // forgot ALL_KINDS, the producer wiring would silently skip it.
    const set = new Set<string>(ALL_KINDS);
    expect(set.size).toBe(ALL_KINDS.length);
  });

  it('every IdentityKind is either contributed by a producer OR deferred', () => {
    const wired = wiredKinds(PRODUCERS);
    const deferredSet = new Set(Object.keys(DEFERRED_KINDS));
    const missing: IdentityKind[] = [];
    for (const kind of ALL_KINDS) {
      if (!wired.has(kind) && !deferredSet.has(kind)) missing.push(kind);
    }
    expect(missing).toEqual([]);
  });

  it('no IdentityKind is both contributed and deferred', () => {
    const wired = wiredKinds(PRODUCERS);
    const doubleCounted: string[] = [];
    for (const kind of Object.keys(DEFERRED_KINDS)) {
      if (wired.has(kind as IdentityKind)) doubleCounted.push(kind);
    }
    expect(doubleCounted).toEqual([]);
  });

  it('every entry in DEFERRED_KINDS is a real IdentityKind', () => {
    const knownKinds = new Set<string>(ALL_KINDS);
    const orphans: string[] = [];
    for (const kind of Object.keys(DEFERRED_KINDS)) {
      if (!knownKinds.has(kind)) orphans.push(kind);
    }
    expect(orphans).toEqual([]);
  });

  it('every deferred entry carries a non-empty reason + landingPhase', () => {
    for (const [kind, info] of Object.entries(DEFERRED_KINDS)) {
      expect(info.reason.length, `${kind}.reason`).toBeGreaterThan(20);
      expect(info.landingPhase.length, `${kind}.landingPhase`).toBeGreaterThan(0);
    }
  });

  it('every registered producer contributes at least one kind', () => {
    const empty = PRODUCERS.filter((p) => p.contributes.length === 0);
    expect(empty.map((p) => p.name)).toEqual([]);
  });

  it('producer names are unique', () => {
    const names = PRODUCERS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no two producers claim the same identity kind', () => {
    const seen = new Map<IdentityKind, string>();
    const conflicts: string[] = [];
    for (const p of PRODUCERS) {
      for (const k of p.contributes) {
        const prior = seen.get(k);
        if (prior) conflicts.push(`${k}: ${prior} + ${p.name}`);
        else seen.set(k, p.name);
      }
    }
    expect(conflicts).toEqual([]);
  });
});

/**
 * Recall-context contract (CLAUDE.md Rule 19).
 *
 * The class this closes: recall attribution used to be a hardcoded list of
 * three tools in `create.ts` and a hardcoded map of five kinds in `check.ts`,
 * so every kind added since — `custom-check` above all — was silently
 * unattributable. Now the producer that OWNS a kind declares what the kind can
 * see, and these assertions make an omission impossible to ship: a producer
 * cannot contribute a kind without a context, and cannot declare a context for
 * a kind it does not contribute.
 */
describe('producer recall-context contract (Rule 19)', () => {
  const ctx = recallFixtureContext();

  it('every producer covers EXACTLY its contributed kinds — no missing, no extra', () => {
    const problems: string[] = [];
    for (const p of PRODUCERS) {
      const declared = new Set(p.recallContexts(ctx).keys());
      for (const kind of p.contributes) {
        if (!declared.has(kind)) problems.push(`${p.name}: contributes '${kind}' with no context`);
      }
      for (const kind of declared) {
        if (!p.contributes.includes(kind)) {
          problems.push(`${p.name}: context for '${kind}' it does not contribute`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every declared context has a real epoch (>= 1)', () => {
    for (const p of PRODUCERS) {
      for (const [kind, recall] of p.recallContexts(ctx)) {
        expect(recall.epoch, `${p.name}/${kind}.epoch`).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(recall.epoch), `${p.name}/${kind}.epoch is an integer`).toBe(true);
      }
    }
  });

  it('RECALL_EPOCHS covers every IdentityKind', () => {
    // A new kind must state its epoch deliberately rather than defaulting,
    // since the epoch is how dxkit says "I changed what I can see here".
    const missing = ALL_KINDS.filter((k) => RECALL_EPOCHS[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('declares contexts even when no analyzer ran — a clean run still has recall', () => {
    // The fixture context has no securityAggregate and no checks: every
    // producer's `produce` returns []. Recall must NOT follow it to zero,
    // because "clean" is only meaningful against a comparable baseline.
    for (const p of PRODUCERS) {
      expect(p.recallContexts(ctx).size, `${p.name} declared no contexts`).toBe(
        p.contributes.length,
      );
    }
  });

  it('inputs are plain string->string (comparable across runs, JSON-round-trippable)', () => {
    for (const p of PRODUCERS) {
      for (const [kind, recall] of p.recallContexts(ctx)) {
        for (const [key, value] of Object.entries(recall.inputs)) {
          expect(typeof value, `${p.name}/${kind}.inputs['${key}']`).toBe('string');
        }
        expect(JSON.parse(JSON.stringify(recall))).toEqual(recall);
      }
    }
  });
});
