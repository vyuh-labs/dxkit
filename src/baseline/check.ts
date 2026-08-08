/**
 * `dxkit guardrail check` — consumer #1 of the gate engine.
 *
 * Since the 4.4.0 WP1 extraction the actual judgment lives in
 * `src/gate/engine.ts:runGate` (SUBJECT × PRIOR × POLICY — one engine,
 * every surface a thin parameterization). This module is the guardrail
 * SURFACE: it resolves the policy and the baseline mode (Rule 11's one
 * resolver), stamps the `repo` subject, and delegates. It also remains
 * the stable import path for every pre-extraction consumer — the moved
 * types and helpers are re-exported below with identical names, so
 * `from './check'` keeps meaning what it always meant (one definition,
 * re-exported; never a second copy).
 *
 * The WP0 parity net (test/gate/guardrail-parity.test.ts) freezes this
 * surface's behavior; the engine split must never move a verdict.
 */

import * as path from 'path';
import { resolveBaselineMode } from './modes';
import type { ResolvedMode } from './modes';
import { resolvePolicy } from './policy';
import type { BrownfieldPolicy } from './policy';
import { runGate } from '../gate/engine';
import type { GateEngineOptions } from '../gate/types';
import type { GuardrailCheckResult } from '../gate/result';

// The stable re-export surface. Definitions moved to src/gate/ in the
// WP1 engine split; every name below is the same object/type it was
// before the move.
export type {
  AnchorSourceDisclosure,
  ClassifiedPair,
  EnvelopeDrift,
  GuardrailCheckResult,
  NotObservedDisclosure,
} from '../gate/result';
export {
  KIND_DEFAULT_SEVERITY,
  collectNotObservedDisclosures,
  kindNotObservedReason,
  partitionForRefBasedDiff,
} from '../gate/observation';
export {
  applyCustomCheckIntent,
  buildReachableIndex,
  describeEntryLocation,
  pairBlocks,
} from '../gate/context';
export { schemeMismatchRemedy } from '../gate/prior';

export interface RunGuardrailCheckOptions extends GateEngineOptions {
  /** Repo root being checked. Caller should pass an absolute path. */
  readonly cwd: string;
  /** Path to a `.dxkit/policy.json` override. The on-disk shape
   *  matches `BrownfieldPolicy` (modulo readonly markers); unknown
   *  fields are preserved but not type-checked here — the policy
   *  classifier reads only the fields it knows. When omitted, a
   *  `<cwd>/.dxkit/policy.json` is auto-loaded if it exists; otherwise
   *  the compiled-in defaults apply. */
  readonly policyPath?: string;
  /** Pre-resolved policy override. When supplied, the orchestrator uses
   *  it verbatim and skips disk resolution (`policyPath` /
   *  `.dxkit/policy.json`). This is the seam the loop Stop-gate uses to
   *  inject its loop-scoped preset policy (see
   *  `src/loop/policy.ts:resolveLoopPolicy`) WITHOUT changing what the
   *  CI guardrail resolves. CI / `baseline check` never set this. */
  readonly policy?: BrownfieldPolicy;
  /** Pre-resolved baseline mode. When supplied, the orchestrator
   *  skips its own resolution. Callers wanting deterministic
   *  behavior (tests, agents) pass this. */
  readonly resolvedMode?: ResolvedMode;
  /** Explicit CLI flag value for the mode (`--mode=<X>`). Forwarded
   *  to `resolveBaselineMode`. Ignored when `resolvedMode` is
   *  supplied. */
  readonly cliMode?: ResolvedMode['mode'];
  /** Explicit CLI flag value for the ref (`--ref=<R>`). Only
   *  consulted when the resolved mode is `ref-based`. */
  readonly cliRef?: string;
}

/**
 * Run the guardrail-check pipeline: resolve policy + mode, then judge
 * the repo subject through the ONE engine. Returns a structured result;
 * renderers + CLI (and verdict/exit-code derivation via
 * `check-renderers.ts:verdictCounts`) are downstream.
 */
export async function runGuardrailCheck(
  options: RunGuardrailCheckOptions,
): Promise<GuardrailCheckResult> {
  const cwd = path.resolve(options.cwd);
  // A pre-resolved `policy` (loop Stop-gate path) wins over disk
  // resolution; otherwise resolve from `--policy` / `.dxkit/policy.json`.
  const policy = options.policy ?? resolvePolicy(options.policyPath, cwd);
  const mode =
    options.resolvedMode ??
    resolveBaselineMode({
      cwd,
      cliMode: options.cliMode,
      cliRef: options.cliRef,
      policyMode: policy.baseline?.mode,
      policyRef: policy.baseline?.ref,
    });
  return runGate({ kind: 'repo', cwd }, mode, policy, options);
}
