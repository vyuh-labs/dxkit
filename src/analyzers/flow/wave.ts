/**
 * The estate WAVE evaluator (4.4.0 WP7 / P2-6) — judge N member trees
 * as ONE composition. Pure: takes each member's already-gathered
 * `RepoFlowModel` (members stay separate — the `RepoFlowModel` type
 * guard exists precisely to stop premature merging) plus optional
 * declared flows, and emits findings through the EXISTING predicates:
 *
 *   - the served MESH is `buildServedMatcher` over the union of every
 *     member's `servedKeySet` — the one catch-all/var-aware matcher the
 *     join and the flow gate already share (never a second resolver);
 *   - UNRESOLVED CALLS (`no-route`): a member's consumed binding no
 *     member serves — `BrokenIntegration`, the flow gate's own record,
 *     with the same confidence gate (`consumedPathConfidence` is
 *     already baked into each binding's confidence);
 *   - DEAD ROUTES (`dead-route`): a served route no member consumes —
 *     the `describe` holistic-seam algorithm, emitted as a first-class
 *     finding (the estate DoD: after a wave, every surviving route has
 *     a consumer). The finding's `file` is the SERVING file, so the
 *     `(method, path, file)` flow-binding identity applies unchanged;
 *   - BROKEN FLOWS (`broken-flow`): a declared flow (`flow.v1`) with a
 *     step the mesh cannot resolve. Identity = the flow id alone (the
 *     paired-change name-only doctrine — failing steps never churn it).
 *
 * The wave is POINT-IN-TIME (fresh semantics): the estate DoD judges
 * the composition as it stands, not a diff. Grandfathering is the
 * allowlist's job here, keyed on the durable fingerprints above.
 */

import type { WireFlow } from '@vyuhlabs/dxkit-sdk';
import {
  computeBrokenFlowFingerprint,
  computeFlowBindingFingerprint,
} from '../tools/fingerprint-contract';
import { buildConsumedContract, buildServedContract, servedKeySet } from './contract';
import type { BrokenIntegration } from './gate';
import { buildServedMatcher, servedMatch } from './model';
import type { RepoFlowModel } from './model';
import { normalizeMethod, normalizePath } from './normalize';

export interface WaveMember {
  readonly name: string;
  readonly model: RepoFlowModel;
}

/** One declared-flow failure: the flow, and which steps cannot resolve. */
export interface BrokenFlowFinding {
  /** `computeBrokenFlowFingerprint(flowId)` — durable, name-only. */
  readonly id: string;
  readonly flowId: string;
  readonly missingSteps: ReadonlyArray<{ readonly method: string; readonly path: string }>;
  readonly stepCount: number;
  readonly verdict: 'block';
}

export interface WaveMemberSummary {
  readonly name: string;
  readonly routes: number;
  readonly calls: number;
}

export interface WaveGateResult {
  /** Unresolved calls (`no-route`) + dead routes (`dead-route`), in the
   *  flow gate's own finding shape (fingerprint, locator, confidence,
   *  verdict) so the allowlist + renderers treat them natively. */
  readonly seamFindings: ReadonlyArray<BrokenIntegration>;
  readonly flowFindings: ReadonlyArray<BrokenFlowFinding>;
  readonly members: ReadonlyArray<WaveMemberSummary>;
  readonly blocks: boolean;
  readonly warns: boolean;
  /** Steps whose `call` string could not be parsed — disclosed, never
   *  silently dropped (an unparseable declaration must not read as a
   *  satisfied one). */
  readonly malformedFlowSteps: ReadonlyArray<{ readonly flowId: string; readonly raw: string }>;
}

const SNAPSHOT_META = { schemaVersion: 1 as const, generatedAt: '' };

/** Parse a `flow.v1` step into a normalized `(method, path)`, or null. */
function parseStep(step: {
  method?: string;
  path?: string;
  call?: string;
}): { method: string; path: string } | null {
  let method = step.method;
  let path = step.path;
  if ((!method || !path) && typeof step.call === 'string') {
    const m = step.call.trim().match(/^(\S+)\s+(\S.*)$/);
    if (m) {
      method = method ?? m[1];
      path = path ?? m[2];
    }
  }
  if (!method || !path) return null;
  const normalized = normalizePath(path);
  const normalizedMethod = normalizeMethod(method);
  if (normalized === null || normalizedMethod === null) return null;
  return { method: normalizedMethod, path: normalized };
}

/** The block threshold mirrors the flow gate's: full-confidence bindings
 *  block; a leading-`{var}` anchorless path (confidence 0.3) warns. */
const BLOCK_THRESHOLD = 0.99;

export function evaluateWaveGate(inputs: {
  readonly members: ReadonlyArray<WaveMember>;
  readonly flows?: ReadonlyArray<WireFlow>;
}): WaveGateResult {
  const perMember = inputs.members.map((m) => ({
    name: m.name,
    model: m.model,
    served: buildServedContract(m.model, SNAPSHOT_META),
    consumed: buildConsumedContract(m.model, SNAPSHOT_META),
  }));

  // The mesh: one matcher over EVERY member's served keys.
  const meshKeys = new Set<string>();
  for (const m of perMember) {
    for (const key of servedKeySet(m.served)) meshKeys.add(key);
  }
  const mesh = buildServedMatcher(meshKeys);

  const seamFindings: BrokenIntegration[] = [];

  // (a) Unresolved calls: any member's consumed binding the mesh can't
  // serve. Confidence rides the binding (the one consumedPathConfidence
  // computation, already applied at contract build).
  for (const m of perMember) {
    for (const b of m.consumed.bindings) {
      if (servedMatch(b.method, b.path, mesh)) continue;
      seamFindings.push({
        id: computeFlowBindingFingerprint(b.method, b.path, b.file),
        method: b.method,
        path: b.path,
        file: b.file,
        line: b.line,
        confidence: b.confidence,
        reason: 'no-route',
        verdict: b.confidence >= BLOCK_THRESHOLD ? 'block' : 'warn',
      });
    }
  }

  // (b) Dead routes: a served route no consumer reaches. CONSUMERS are
  // member calls ∪ declared flow steps — a flow.v1 declaration is the
  // estate's own statement that the route has a consumer (often an
  // external one the member code cannot show). Per-route matcher (the
  // holistic-seam algorithm) so catch-all/var routes count a covered
  // call as consumption.
  const declaredSteps: Array<{ method: string; path: string }> = [];
  for (const flow of inputs.flows ?? []) {
    for (const rawStep of flow.steps ?? []) {
      const step = parseStep(rawStep);
      if (step) declaredSteps.push(step);
    }
  }
  const allCalls = [
    ...perMember.flatMap((m) => m.consumed.bindings),
    ...declaredSteps.map((s) => ({ method: s.method, path: s.path })),
  ];
  for (const m of perMember) {
    for (const route of m.model.routes) {
      const routeMatcher = buildServedMatcher([`${route.method} ${route.path}`]);
      const consumed = allCalls.some((c) => servedMatch(c.method, c.path, routeMatcher));
      if (consumed) continue;
      seamFindings.push({
        id: computeFlowBindingFingerprint(route.method, route.path, route.file),
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
        confidence: 1,
        reason: 'dead-route',
        // WARN, deliberately: an estate's outward-facing endpoints have
        // consumers the workspace cannot see (UIs, partners). The finding
        // is visible + allowlistable debt; only statically PROVEN breakage
        // (unresolved calls, broken declared flows) blocks a wave.
        verdict: 'warn',
      });
    }
  }

  // (c) Declared flows: every step must resolve via the mesh.
  const flowFindings: BrokenFlowFinding[] = [];
  const malformedFlowSteps: Array<{ flowId: string; raw: string }> = [];
  for (const flow of inputs.flows ?? []) {
    const missing: Array<{ method: string; path: string }> = [];
    let steps = 0;
    for (const rawStep of flow.steps ?? []) {
      const step = parseStep(rawStep);
      if (!step) {
        malformedFlowSteps.push({
          flowId: flow.id,
          raw: JSON.stringify(rawStep).slice(0, 120),
        });
        continue;
      }
      steps++;
      if (!servedMatch(step.method, step.path, mesh)) missing.push(step);
    }
    if (missing.length > 0) {
      flowFindings.push({
        id: computeBrokenFlowFingerprint(flow.id),
        flowId: flow.id,
        missingSteps: missing,
        stepCount: steps,
        verdict: 'block',
      });
    }
  }

  const blocks = seamFindings.some((f) => f.verdict === 'block') || flowFindings.length > 0;
  const warns = seamFindings.some((f) => f.verdict === 'warn');

  return {
    seamFindings,
    flowFindings,
    members: perMember.map((m) => ({
      name: m.name,
      routes: m.served.routes.length,
      calls: m.consumed.bindings.length,
    })),
    blocks,
    warns,
    malformedFlowSteps,
  };
}
