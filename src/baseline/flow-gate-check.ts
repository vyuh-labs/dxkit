/**
 * The flow integration-gate pass for the guardrail check — an ADDITIVE,
 * fail-open layer over `runGuardrailCheck`.
 *
 * This is guardrail-integration glue, not analysis: it composes the pure flow
 * gate (`analyzers/flow/gate.ts`) with the ref-based gather primitive
 * (`withRefWorktree`, Rule 11) to answer "does this diff net-new break a UI→API
 * integration?" without touching the existing net-new finding matcher. The gate
 * runs only in ref-based mode, where a base↔HEAD comparison is well defined
 * (committed mode has no base flow model — flow-binding is a deferred baseline
 * kind, minted here ref-based rather than at baseline-create).
 *
 * Every failure path degrades to "did not gate" rather than an error: a
 * missing base ref, an unparseable tree, a repo with no server-side truth to
 * check against — all yield an empty, non-blocking outcome. A brand-new
 * cross-repo gate must never wedge a build on its own uncertainty.
 *
 * Served-side truth. In a monorepo both surfaces live in the scanned tree, so
 * the served set is gathered live. In a split repo the counterpart commits its
 * `served.json` snapshot here (Rule 13 pattern), unioned in below. When neither
 * yields any served route the gate self-skips: with no served inventory every
 * consumed binding would look broken, so gating would be all false positives.
 */

import * as path from 'path';
import { changedFilesTouchFlowSurface, detectActiveLanguages } from '../languages';
import { computeChangedFiles } from './changed-files';
import { withRefWorktree } from './ref-baseline';
import type { ResolvedMode } from './modes';
import { gatherFlowModel } from '../analyzers/flow/gather';
import {
  buildConsumedContract,
  buildServedContract,
  readServedContract,
  servedKeySet,
  type ConsumedBinding,
} from '../analyzers/flow/contract';
import { evaluateFlowGate, type BrokenIntegration } from '../analyzers/flow/gate';
import { readFlowConfig, type FlowGateMode } from '../analyzers/flow/config';

/** Why the gate produced no verdict, when it didn't run. */
export type FlowGateSkip =
  | 'off' // policy `flow.mode: off`
  | 'not-ref-based' // committed mode — no base flow model to diff against
  | 'no-flow-surface-change' // the diff touched no client call / route / spec
  | 'no-served-truth' // no served inventory (monorepo route set + snapshot both empty)
  | 'error'; // any failure — fail-open

/** Outcome of the flow gate pass, folded additively into the guardrail verdict. */
export interface FlowGateOutcome {
  /** True when the gate actually evaluated a base↔HEAD comparison. */
  readonly ran: boolean;
  /** Populated when `ran` is false — the reason no verdict was produced. */
  readonly skipped?: FlowGateSkip;
  /** The effective mode after the loop-seam override (block / warn / off). */
  readonly mode: FlowGateMode;
  /** Net-new broken integrations. In `warn` mode every finding's verdict is
   *  demoted to `warn` so renderers present them as warnings. */
  readonly findings: readonly BrokenIntegration[];
  /** True when at least one finding blocks (only possible in `block` mode). */
  readonly blocks: boolean;
  /** True when at least one finding warns. */
  readonly warns: boolean;
}

/** Meta stub for contract building — the gate reads only routes/bindings, never
 *  the snapshot metadata, so a clock-free placeholder keeps this pure. */
const GATE_META = { schemaVersion: 1 as const, generatedAt: '' };

function skip(mode: FlowGateMode, reason: FlowGateSkip): FlowGateOutcome {
  return { ran: false, skipped: reason, mode, findings: [], blocks: false, warns: false };
}

/**
 * Run the flow gate for a guardrail check. Never throws — a caller ORs the
 * returned `blocks` / `warns` into the overall verdict and attaches the outcome
 * to the result for rendering.
 *
 * @param modeOverride the loop Stop-gate's posture-derived mode (the seam that
 *   lets `security-only` warn while `full-debt` blocks) — wins over the
 *   `.dxkit/policy.json:flow.mode` default.
 */
export async function evaluateFlowGateForGuardrail(opts: {
  readonly cwd: string;
  readonly mode: ResolvedMode;
  readonly modeOverride?: FlowGateMode;
  readonly verbose?: boolean;
}): Promise<FlowGateOutcome> {
  const cwd = path.resolve(opts.cwd);
  const config = readFlowConfig(cwd);
  const gateMode = opts.modeOverride ?? config.mode;

  if (gateMode === 'off') return skip(gateMode, 'off');
  if (opts.mode.mode !== 'ref-based' || !opts.mode.ref) return skip(gateMode, 'not-ref-based');
  const ref = opts.mode.ref;

  try {
    // Trigger-skip: a net-new broken integration requires a change to a client
    // call, a route, or a spec. When the diff touched none, there is nothing to
    // gate. `computeChangedFiles` returns null on any uncertainty → we can't
    // prove the diff is flow-free, so we fall through and run (safe default).
    const changed = computeChangedFiles(cwd, ref) ?? undefined;
    if (
      changed &&
      !changedFilesTouchFlowSurface(changed, detectActiveLanguages(cwd), config.specs)
    ) {
      return skip(gateMode, 'no-flow-surface-change');
    }

    // HEAD side (the working tree). Served truth = live routes ∪ any committed
    // counterpart snapshot (split-repo case).
    const headModel = await gatherFlowModel({
      roots: [cwd],
      specs: config.specs.map((s) => path.resolve(cwd, s)),
      stripUrlPrefixes: config.stripUrlPrefixes,
      // Repo-relative locators so a binding's identity is the same whether it
      // was gathered here or from the base worktree below (Rule 9).
      relativeTo: cwd,
    });
    const headConsumed = buildConsumedContract(headModel, GATE_META).bindings;
    const headServed = servedKeySet(buildServedContract(headModel, GATE_META));
    unionCommittedServed(cwd, headServed);

    // Base side, gathered from a detached worktree at the ref (Rule 11). Read
    // ITS committed snapshot so the base served set reflects the counterpart as
    // it was at base — keeping the grandfathering diff honest.
    const base = await withRefWorktree({ cwd, ref }, async (wt) => {
      const baseModel = await gatherFlowModel({
        roots: [wt],
        specs: config.specs.map((s) => path.resolve(wt, s)),
        stripUrlPrefixes: config.stripUrlPrefixes,
        relativeTo: wt, // same repo-relative locators as the HEAD side
      });
      const baseServed = servedKeySet(buildServedContract(baseModel, GATE_META));
      unionCommittedServed(wt, baseServed);
      return {
        consumed: buildConsumedContract(baseModel, GATE_META).bindings as ConsumedBinding[],
        served: [...baseServed],
      };
    });
    const baseServed = new Set(base.served);

    // No server-side truth on either side → cannot distinguish a broken call
    // from a call served by a repo we can't see. Skip rather than false-block.
    if (headServed.size === 0 && baseServed.size === 0) return skip(gateMode, 'no-served-truth');

    const found = evaluateFlowGate({
      headConsumed,
      baseConsumed: base.consumed,
      headServed,
      baseServed,
      blockThreshold: config.blockThreshold,
    });

    // Apply the posture. `warn` demotes every finding so renderers show them as
    // warnings and nothing fails the build; `block` honors each per-finding
    // verdict (exact → block, placeholder → warn).
    const findings =
      gateMode === 'warn' ? found.map((f) => ({ ...f, verdict: 'warn' as const })) : found;
    const blocks = gateMode === 'block' && findings.some((f) => f.verdict === 'block');
    const warns = findings.some((f) => f.verdict === 'warn');

    if (opts.verbose && findings.length > 0) {
      process.stderr.write(
        `    [flow] ${findings.length} net-new broken integration(s) — ${blocks ? 'blocking' : 'warning'}\n`,
      );
    }
    return { ran: true, mode: gateMode, findings, blocks, warns };
  } catch {
    // Fail-open: a ref that can't be checked out, an unparseable tree, a git
    // error — none of these should fail the guardrail. The gate simply did not
    // run.
    return skip(gateMode, 'error');
  }
}

/** Union a repo's committed counterpart `served.json` (if any) into a served
 *  key set. Fail-open: an absent / malformed snapshot is a no-op. */
function unionCommittedServed(cwd: string, into: Set<string>): void {
  const committed = readServedContract(cwd);
  if (!committed) return;
  for (const k of servedKeySet(committed)) into.add(k);
}
