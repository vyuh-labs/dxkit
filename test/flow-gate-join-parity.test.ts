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

/** Calls the JOIN considers resolved (bound to a route), as `METHOD path` keys
 *  — method-aware so a fixture can pit two verbs on one path against each
 *  other (the `ANY` served-route rule). */
function joinResolvedKeys(calls: ClientCall[], routes: RouteEndpoint[]): Set<string> {
  return new Set(
    joinFlow(calls, routes)
      .filter((binding) => binding.route !== null)
      .map((binding) => `${binding.call.method} ${binding.call.path}`),
  );
}

/** `METHOD path` keys the GATE flags as net-new broken, with base === head
 *  served (so every HEAD-broken call is net-new, isolating the resolution
 *  decision). */
function gateBrokenKeys(calls: ClientCall[], routes: RouteEndpoint[]): Set<string> {
  const model = buildFlowModel([{ calls, routes } as FileFlow]);
  const served = servedKeySet(buildServedContract(model, META));
  const consumed = buildConsumedContract(model, META).bindings;
  const found = evaluateFlowGate({
    headConsumed: consumed,
    baseConsumed: [], // all calls are new vs base
    headServed: served,
    baseServed: served,
  });
  return new Set(found.map((f) => `${f.method} ${f.path}`));
}

/** `"/path"` (GET) or `"METHOD /path"` — fixtures vary methods so the
 *  method-agnostic (`ANY`) served-route rule is parity-checked too. */
type Keyed = string;
function parseKeyed(k: Keyed): { method: string; path: string } {
  const sp = k.indexOf(' ');
  return sp === -1 ? { method: 'GET', path: k } : { method: k.slice(0, sp), path: k.slice(sp + 1) };
}

const FIXTURES: { name: string; calls: Keyed[]; routes: Keyed[] }[] = [
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
  {
    name: 'method-agnostic routes (Django path / Go HandleFunc) serve every verb',
    calls: ['GET /users', 'POST /users', 'DELETE /users/{var}', 'PUT /typo'],
    routes: ['ANY /users', 'ANY /users/{var}'],
  },
  {
    name: 'method-agnostic catch-all covers any verb under its prefix',
    calls: ['POST /api/x', 'GET /api/y/z', 'GET /elsewhere'],
    routes: ['ANY /api/{*}'],
  },
  {
    name: 'a concrete-method route does NOT become method-agnostic',
    calls: ['POST /a', 'POST /b', 'GET /a'],
    routes: ['GET /a', 'ANY /b'],
  },
  {
    name: 'var routes resolve concrete calls (pact/HAR artifact paths)',
    calls: ['/articles/1', '/articles/1/comments', '/typo/9/x'],
    routes: ['/articles/{var}', '/articles/{var}/comments'],
  },
  {
    name: 'var-route specificity: literals beat params, exact beats var',
    calls: ['/a/b', '/a/c', 'GET /a/b/c'],
    routes: ['/a/b', '/a/{var}', '/a/{var}/c'],
  },
  {
    name: 'method-agnostic var route serves every verb on the shape',
    calls: ['DELETE /users/42', 'PATCH /users/42/roles', 'GET /users'],
    routes: ['ANY /users/{var}', 'ANY /users/{var}/roles'],
  },
  {
    name: 'a var route never absorbs a different segment COUNT',
    calls: ['/things/1/extra', '/things'],
    routes: ['/things/{var}'],
  },
];

describe('gate ↔ join resolution parity (catch-all regression net)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name}: every join-resolved call is NOT gate-broken, and misses agree`, () => {
      const calls = fx.calls.map((k) => {
        const { method, path } = parseKeyed(k);
        return call(path, { method: method as ClientCall['method'] });
      });
      const routes = fx.routes.map((k) => {
        const { method, path } = parseKeyed(k);
        return route(path, { method: method as RouteEndpoint['method'] });
      });

      const resolved = joinResolvedKeys(calls, routes);
      const broken = gateBrokenKeys(calls, routes);

      // The invariant: resolved and broken are disjoint. A call doctor says is
      // served must never be a gate block, and vice-versa.
      for (const k of resolved) {
        expect(broken.has(k), `join resolved ${k} but the gate flagged it broken`).toBe(false);
      }
      // And the complement holds: a call neither resolved is exactly a gate miss.
      const callKeys = calls.map((c) => `${c.method} ${c.path}`);
      const unresolved = new Set(callKeys.filter((k) => !resolved.has(k)));
      expect(broken).toEqual(unresolved);
    });
  }
});
