/**
 * The ONE fail-open diagnostic contract shared by every additive guardrail gate
 * (flow, schema-drift, seam/dup — and any future sibling).
 *
 * These gates are deliberately fail-OPEN: a ref that can't be checked out, an
 * unparseable tree, a plugin that throws at load — none should wedge the build,
 * so the gate degrades to "did not gate" rather than an error. The class of bug
 * this module exists to kill: a fail-open gate that catches its error in a bare
 * `catch {}` and returns `skipped: 'error'` with NO captured reason, so a real
 * throw becomes a diagnosability black hole (nothing in the human output, the
 * `--json`, or stderr). It shipped once — the flow gate erroring silently inside
 * `guardrail check` on a real repo while every direct flow surface ran clean —
 * and it was invisible in dogfood because dxkit's own repo runs `flow` off, so
 * the gate path was never exercised by the self-guardrail.
 *
 * The fix is structural, not a one-off log line: every gate's outcome carries an
 * optional `error: GateFailure` (the step that threw + a clean message), the
 * catch routes through `captureGateFailure`, and the renderers surface it. A
 * fail-open gate stays fail-open — it just says WHY, always.
 *
 * See `test/baseline/gate-failopen.test.ts` (the cross-gate contract: an induced
 * throw in each gate must yield a populated `GateFailure`) and the
 * `check-architecture.sh` rule banning a bare `} catch {` in `*-gate-check.ts`.
 */

import { RefBaselineError } from './ref-baseline';

/** Why a fail-open gate did not run, captured from the thrown error rather than
 *  discarded. Attached to a gate outcome alongside `skipped: 'error'`. */
export interface GateFailure {
  /** The step that threw — a short, stable token (`'base-worktree'`,
   *  `'head-gather'`, `'evaluate'`, …) so the reader knows WHERE it broke, not
   *  just that it broke. */
  readonly step: string;
  /** A clean, human-readable message extracted from the thrown value. */
  readonly message: string;
}

/** True when verbose gate diagnostics are requested (`DXKIT_DEBUG=1`). */
function debugEnabled(): boolean {
  return process.env.DXKIT_DEBUG === '1' || process.env.DXKIT_DEBUG === 'true';
}

/** Extract a clean one-line message from an arbitrary thrown value. Unwraps the
 *  gates' own `RefBaselineError` (message + actionable hint), a plain `Error`,
 *  or stringifies anything else. */
function messageOf(err: unknown): string {
  if (err instanceof RefBaselineError) {
    return err.hint ? `${err.message} (${err.hint})` : err.message;
  }
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Turn a caught error into a `GateFailure` for a fail-open gate. Call this from
 * the gate's catch, passing the `step` the try body was in when it threw. Under
 * `DXKIT_DEBUG=1` the full stack is written to stderr so a swallowed throw is
 * never truly lost; the returned failure is what the outcome carries and the
 * renderers surface in normal runs.
 */
export function captureGateFailure(step: string, err: unknown): GateFailure {
  if (debugEnabled()) {
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`    [gate] fail-open at step '${step}':\n${stack}\n`);
  }
  return { step, message: messageOf(err) };
}
