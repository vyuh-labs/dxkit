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
