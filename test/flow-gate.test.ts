/**
 * Tests for src/analyzers/flow/gate.ts — the pure net-new broken-integration
 * evaluation. Exercises both PR directions (frontend adds a dead call; backend
 * removes a live route), the net-new-vs-grandfathered boundary, and confidence
 * gating (block vs warn).
 */

import { describe, expect, it } from 'vitest';
import { evaluateFlowGate, flowGateBlocks, type GateInputs } from '../src/analyzers/flow/gate';
import type { ConsumedBinding } from '../src/analyzers/flow/contract';

function b(over: Partial<ConsumedBinding>): ConsumedBinding {
  return {
    method: 'GET',
    path: '/articles',
    file: 'web/List.tsx',
    line: 20,
    confidence: 1,
    ...over,
  };
}

function inputs(over: Partial<GateInputs>): GateInputs {
  return {
    headConsumed: [],
    baseConsumed: [],
    headServed: new Set(),
    baseServed: new Set(),
    ...over,
  };
}

describe('evaluateFlowGate — net-new detection', () => {
  it('frontend PR: a NEW call to a non-served endpoint is net-new broken', () => {
    const call = b({ path: '/usrs' }); // typo — never served
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [call],
        baseConsumed: [], // the call did not exist at base
        headServed: new Set(['GET /articles']),
        baseServed: new Set(['GET /articles']),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: '/usrs', reason: 'no-route', verdict: 'block' });
  });

  it('backend PR: removing a route a consumer still binds to is net-new broken', () => {
    const call = b({ path: '/articles' });
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [call],
        baseConsumed: [call], // the binding existed at base
        headServed: new Set(), // route removed at HEAD
        baseServed: new Set(['GET /articles']), // ...but served at base
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path: '/articles',
      reason: 'route-removed',
      verdict: 'block',
    });
  });

  it('grandfathers a binding already broken BEFORE the PR', () => {
    const call = b({ path: '/legacy' });
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [call],
        baseConsumed: [call], // present at base
        headServed: new Set(['GET /articles']),
        baseServed: new Set(['GET /articles']), // /legacy unresolved at base too
      }),
    );
    expect(found).toEqual([]); // pre-existing breakage → not net-new
  });

  it('a resolving binding is never flagged', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [b({ path: '/articles' })],
        headServed: new Set(['GET /articles']),
        baseServed: new Set(['GET /articles']),
      }),
    );
    expect(found).toEqual([]);
  });
});

// The gate once resolved consumed→served by EXACT key membership, so any call
// served by a `[...slug]` / `/**` catch-all — which doctor's join resolves
// cleanly — hard-blocked as a net-new `no-route`. The gate now shares the join's
// catch-all-aware matcher (Rule 2).
describe('evaluateFlowGate — catch-all resolution (shares the join matcher)', () => {
  it('a new call under a catch-all prefix is SERVED, not net-new broken', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [b({ method: 'POST', path: '/api/users/login' })],
        baseConsumed: [],
        headServed: new Set(['POST /api/{*}']), // Payload/Next [...slug] route
        baseServed: new Set(['POST /api/{*}']),
      }),
    );
    expect(found).toEqual([]);
  });

  it('the most-specific catch-all covers nested paths; a call outside every prefix still breaks', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [
          b({ method: 'GET', path: '/api/v2/things', file: 'web/a.tsx' }), // under /api/v2/{*}
          b({ method: 'GET', path: '/other/thing', file: 'web/b.tsx' }), // no catch-all covers it
        ],
        headServed: new Set(['GET /api/{*}', 'GET /api/v2/{*}']),
        baseServed: new Set(['GET /api/{*}', 'GET /api/v2/{*}']),
      }),
    );
    expect(found.map((f) => f.path)).toEqual(['/other/thing']);
  });

  it('route-removed is detected when a catch-all that covered the call is gone at HEAD', () => {
    const call = b({ method: 'GET', path: '/api/x' });
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [call],
        baseConsumed: [call],
        headServed: new Set(), // the catch-all was removed
        baseServed: new Set(['GET /api/{*}']), // covered the call at base
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: '/api/x', reason: 'route-removed' });
  });
});

// An opaque leading `{var}` (`/{var}/users/login`) could resolve
// under any top-level namespace, so a "no route serves it" verdict is too
// uncertain to block — it warns. Confidence is path-intrinsic (set by
// buildConsumedContract via consumedPathConfidence); the gate here honors it.
describe('evaluateFlowGate — opaque-leading-segment confidence', () => {
  it('a leading-placeholder path warns rather than blocks', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [b({ path: '/{var}/users/login', confidence: 0.3 })],
        headServed: new Set(['GET /articles']),
        baseServed: new Set(['GET /articles']),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].verdict).toBe('warn');
    expect(flowGateBlocks(found)).toBe(false);
  });
});

describe('evaluateFlowGate — confidence gating', () => {
  it('a low-confidence (placeholder-only) net-new break WARNS, never blocks', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [b({ path: '/{var}', confidence: 0.3 })],
        headServed: new Set(),
        baseServed: new Set(),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].verdict).toBe('warn');
    expect(flowGateBlocks(found)).toBe(false);
  });

  it('respects a custom block threshold', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [b({ path: '/x', confidence: 0.5 })],
        headServed: new Set(),
        baseServed: new Set(),
        blockThreshold: 0.4,
      }),
    );
    expect(found[0].verdict).toBe('block');
  });
});

describe('evaluateFlowGate — identity + ordering', () => {
  it('stamps a stable 16-char flow-binding fingerprint', () => {
    const found = evaluateFlowGate(
      inputs({ headConsumed: [b({ path: '/x' })], headServed: new Set(), baseServed: new Set() }),
    );
    expect(found[0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('orders blocks before warns', () => {
    const found = evaluateFlowGate(
      inputs({
        headConsumed: [
          b({ path: '/{var}', file: 'web/a.tsx', confidence: 0.3 }), // warn
          b({ path: '/dead', file: 'web/b.tsx', confidence: 1 }), // block
        ],
        headServed: new Set(),
        baseServed: new Set(),
      }),
    );
    expect(found.map((f) => f.verdict)).toEqual(['block', 'warn']);
  });
});
