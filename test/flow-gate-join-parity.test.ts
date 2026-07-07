/**
 * Cross-path INVARIANT: the gate and the join agree on "is this call served?"
 *
 * `diagnoseFlow` (doctor) resolves a call through `joinFlow`; `evaluateFlowGate`
 * (the guardrail) resolves the same call against the served set. They are two
 * consumers of ONE concept — consumed→served resolution — and they MUST agree,
 * or a repo passes doctor (all calls resolved) yet hard-blocks in the gate. That
 * exact divergence shipped once: the join was catch-all-aware; the gate did exact
 * key membership only, so every call served by a `[...slug]` / `/**` catch-all
 * blocked as a net-new `no-route`.
 *
 * A grep-based arch rule can't catch a SEMANTIC divergence between two
 * implementations of one concept — only a parity test that runs both paths on
 * the same fixtures and asserts agreement. This is that test (the flow analog of
 * the fixtures-analysis harness in CLAUDE.md 2.30). When a call resolves in the
 * join, the gate must NOT flag it net-new broken; when it doesn't resolve, the
 * gate MUST (given it's new vs base). Any future path that re-loses the catch-all
 * signal fails here.
 */

import { describe, expect, it } from 'vitest';
import { buildFlowModel, joinFlow } from '../src/analyzers/flow/model';
import { evaluateFlowGate } from '../src/analyzers/flow/gate';
import {
  buildConsumedContract,
  buildServedContract,
  servedKeySet,
} from '../src/analyzers/flow/contract';
import type { ClientCall, RouteEndpoint, FileFlow } from '../src/analyzers/flow/extract';

const META = { schemaVersion: 1 as const, generatedAt: '' };

function call(path: string, over: Partial<ClientCall> = {}): ClientCall {
  return {
    method: 'GET',
    rawUrl: path,
    path,
    receiver: 'axios',
    file: 'web/a.tsx',
    line: 10,
    ...over,
  };
}

function route(path: string, over: Partial<RouteEndpoint> = {}): RouteEndpoint {
  return {
    method: 'GET',
    path,
    via: 'decorator',
    handler: 'h',
    file: 'api/r.ts',
    line: 5,
    ...over,
  };
}

/** Calls the JOIN considers resolved (bound to a route). */
function joinResolvedPaths(calls: ClientCall[], routes: RouteEndpoint[]): Set<string> {
  return new Set(
    joinFlow(calls, routes)
      .filter((binding) => binding.route !== null)
      .map((binding) => binding.call.path!),
  );
}

/** Paths the GATE flags as net-new broken, with base === head served (so every
 *  HEAD-broken call is net-new, isolating the resolution decision). */
function gateBrokenPaths(calls: ClientCall[], routes: RouteEndpoint[]): Set<string> {
  const model = buildFlowModel([{ calls, routes } as FileFlow]);
  const served = servedKeySet(buildServedContract(model, META));
  const consumed = buildConsumedContract(model, META).bindings;
  const found = evaluateFlowGate({
    headConsumed: consumed,
    baseConsumed: [], // all calls are new vs base
    headServed: served,
    baseServed: served,
  });
  return new Set(found.map((f) => f.path));
}

const FIXTURES: { name: string; calls: string[]; routes: string[] }[] = [
  {
    name: 'catch-all repo (Payload/Next [...slug])',
    calls: ['/api/users/login', '/api/posts', '/api'],
    routes: ['/api/{*}'],
  },
  {
    name: 'nested catch-alls — most-specific wins',
    calls: ['/api/v2/things', '/api/legacy'],
    routes: ['/api/{*}', '/api/v2/{*}'],
  },
  {
    name: 'exact routes + one genuine miss',
    calls: ['/articles', '/authors', '/typo'],
    routes: ['/articles', '/authors'],
  },
  {
    name: 'root catch-all serves everything',
    calls: ['/whatever/deep/path', '/x'],
    routes: ['/{*}'],
  },
  {
    name: 'mixed: exact wins, catch-all covers the rest, one outsider misses',
    calls: ['/api/exact', '/api/other', '/elsewhere'],
    routes: ['/api/exact', '/api/{*}'],
  },
];

describe('gate ↔ join resolution parity (catch-all regression net)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name}: every join-resolved call is NOT gate-broken, and misses agree`, () => {
      const calls = fx.calls.map((p) => call(p));
      const routes = fx.routes.map((p) => route(p));

      const resolved = joinResolvedPaths(calls, routes);
      const broken = gateBrokenPaths(calls, routes);

      // The invariant: resolved and broken are disjoint. A call doctor says is
      // served must never be a gate block, and vice-versa.
      for (const p of resolved) {
        expect(broken.has(p), `join resolved ${p} but the gate flagged it broken`).toBe(false);
      }
      // And the complement holds: a call neither resolved is exactly a gate miss.
      const unresolved = new Set(fx.calls.filter((p) => !resolved.has(p)));
      expect(broken).toEqual(unresolved);
    });
  }
});
