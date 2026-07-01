/**
 * The integration-breakage gate — pure evaluation core.
 *
 * Answers "does this diff NET-NEW break a UI→API integration?" from a base↔HEAD
 * contract comparison, with no running system. One algorithm covers both
 * directions (CLAUDE.md design §6):
 *   - a FRONTEND PR that adds a call to an endpoint no backend serves, and
 *   - a BACKEND PR that removes/renames a route a frontend still calls,
 * because both reduce to "a consumed binding whose (method, path) is not in the
 * served set". The diff makes it net-new: a binding already broken BEFORE the
 * PR (present at base and unresolved against the base served set) is
 * grandfathered; only a binding the PR NEWLY breaks is surfaced.
 *
 * Pure over its inputs — the ref-based gather (base worktree via
 * `withRefWorktree`, Rule 11) and the guardrail wiring live above this module;
 * here we only diff two already-materialized contract sides. Identity is the
 * flow-binding fingerprint (line-independent (method, path, file), Rule 9),
 * computed through the canonical helper so an emitted finding shares one
 * identity contract with the baseline + allowlist.
 */

import { computeFlowBindingFingerprint } from '../tools/fingerprint';
import { contractKey, type ConsumedBinding } from './contract';

/** Why a binding is broken: the endpoint was never served (a new call to a
 *  non-existent route, or a typo), or a route that WAS served got removed. */
export type BrokenReason = 'no-route' | 'route-removed';

/** One net-new broken integration the gate surfaces. */
export interface BrokenIntegration {
  /** Flow-binding fingerprint — the durable identity (Rule 9). */
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  readonly confidence: number;
  readonly reason: BrokenReason;
  /** `block` when confidence clears the threshold (a real, specific breakage),
   *  else `warn` — conservative by construction to protect the false-positive
   *  budget (fuzzy / placeholder-only paths never fail a build). */
  readonly verdict: 'block' | 'warn';
}

export interface GateInputs {
  /** Bindings this side depends on at HEAD (the consumed contract post-diff). */
  readonly headConsumed: readonly ConsumedBinding[];
  /** Bindings at the base ref — the grandfathering set. */
  readonly baseConsumed: readonly ConsumedBinding[];
  /** `${method} ${path}` keys served at HEAD (the counterpart's served
   *  contract, or this repo's own in a monorepo). */
  readonly headServed: ReadonlySet<string>;
  /** Served keys at the base ref. */
  readonly baseServed: ReadonlySet<string>;
  /** Confidence at/above which a net-new broken binding BLOCKS (else warns).
   *  Default 1 — only exact, fully-specified bindings can fail a build. */
  readonly blockThreshold?: number;
}

/** The flow-binding identity tuple as a map key (method, path, file). */
function identityKey(b: { method: string; path: string; file: string }): string {
  return `${b.method}\0${b.path}\0${b.file}`;
}

/**
 * Evaluate the gate. Returns every NET-NEW broken integration, most-severe
 * (block before warn) first, then by location for stable output. Empty when the
 * diff breaks nothing new.
 */
export function evaluateFlowGate(inputs: GateInputs): BrokenIntegration[] {
  const blockThreshold = inputs.blockThreshold ?? 1;
  const baseByIdentity = new Map<string, ConsumedBinding>();
  for (const b of inputs.baseConsumed) baseByIdentity.set(identityKey(b), b);

  const out: BrokenIntegration[] = [];
  for (const b of inputs.headConsumed) {
    const key = contractKey(b.method, b.path);
    if (inputs.headServed.has(key)) continue; // resolves at HEAD → not broken

    // Broken at HEAD. Was the SAME binding already broken at base? (present at
    // base AND unresolved against the base served set) → grandfathered.
    const base = baseByIdentity.get(identityKey(b));
    const brokenBefore = base !== undefined && !inputs.baseServed.has(key);
    if (brokenBefore) continue;

    // Net-new. `route-removed` when the binding existed at base and WAS served
    // then (the PR removed the route); otherwise the call itself is new or
    // never resolved (`no-route`).
    const reason: BrokenReason =
      base !== undefined && inputs.baseServed.has(key) ? 'route-removed' : 'no-route';
    out.push({
      id: computeFlowBindingFingerprint(b.method, b.path, b.file),
      method: b.method,
      path: b.path,
      file: b.file,
      line: b.line,
      confidence: b.confidence,
      reason,
      verdict: b.confidence >= blockThreshold ? 'block' : 'warn',
    });
  }

  out.sort(
    (a, z) =>
      Number(z.verdict === 'block') - Number(a.verdict === 'block') ||
      a.file.localeCompare(z.file) ||
      a.path.localeCompare(z.path),
  );
  return out;
}

/** Does the gate result block? True when any finding's verdict is `block`. */
export function flowGateBlocks(findings: readonly BrokenIntegration[]): boolean {
  return findings.some((f) => f.verdict === 'block');
}

/** Human-readable one-liner for a broken integration (report + Stop-gate). */
export function describeBrokenIntegration(f: BrokenIntegration): string {
  const what =
    f.reason === 'route-removed'
      ? `removed ${f.method} ${f.path} still called by`
      : `${f.method} ${f.path} matches no served route —`;
  return `net-new broken integration: ${what} ${f.file}:${f.line}`;
}
