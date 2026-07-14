/**
 * The model-schema drift-gate pass for the guardrail check — an ADDITIVE,
 * fail-open layer over `runGuardrailCheck` (mirror of `flow-gate-check.ts`,
 * layer for layer).
 *
 * Guardrail-integration glue, not analysis: it composes the pure drift gate
 * (`analyzers/model-schema/gate.ts`) with the ref-based gather primitive
 * (`withRefWorktree`, Rule 11) to answer "does this diff change a declared
 * data model in a breaking way?" without touching the existing net-new
 * finding matcher.
 *
 * Mode-agnostic like the flow gate: it needs only a base COMMIT — the
 * resolved git ref in ref-based mode, the committed baseline's anchor
 * `repo.commitSha` in committed modes — and gathers both sides fresh, so
 * `model-schema-drift` needs no committed prior side (a deferred baseline
 * kind, minted here at gate time). Extraction is pure static analysis (no
 * toolchain), so it is ref-RELIABLE; the day it wants a compiled
 * type-checker, that half stops being ref-gateable (see
 * `REF_UNRELIABLE_KINDS` in check.ts for the contrast class).
 *
 * Every failure path degrades to "did not gate": a missing base ref, an
 * unparseable tree, a repo with no recognizable models on either side — all
 * yield an empty, non-blocking outcome. A gate must never wedge a build on
 * its own uncertainty.
 */

import * as path from 'path';
import { changedFilesTouchModelSurface, detectActiveLanguages } from '../languages';
import { computeChangedFiles } from './changed-files';
import { withRefWorktree } from './ref-baseline';
import { gatherModelSet } from '../analyzers/model-schema/gather';
import { evaluateSchemaDriftGate, type SchemaDriftFinding } from '../analyzers/model-schema/gate';
import { readSchemaConfig, type SchemaGateMode } from '../analyzers/model-schema/config';
import { findEntry, isEntryActive } from '../allowlist/file';
import type { AllowlistFile } from '../allowlist/file';
import { captureGateFailure, type GateFailure } from './gate-failopen';

/** Why the gate produced no verdict, when it didn't run. */
export type SchemaDriftGateSkip =
  | 'off' // policy `schema.mode: off` (the default — the gate is opt-in)
  | 'no-base-ref' // no base commit resolvable
  | 'no-model-surface-change' // the diff touched no model-capable source / spec
  | 'no-models' // neither side declares any model — nothing to compare
  | 'error'; // any failure — fail-open

/** A drift finding an active allowlist entry waived from the verdict —
 *  surfaced for audit, excluded from blocks/warns. */
export interface SchemaDriftSuppression {
  readonly finding: SchemaDriftFinding;
  readonly fingerprint: string;
  readonly category: string;
  readonly expiresAt?: string;
}

/** Outcome of the drift-gate pass, folded additively into the guardrail
 *  verdict. */
export interface SchemaDriftGateOutcome {
  /** True when the gate actually evaluated a base↔HEAD comparison. */
  readonly ran: boolean;
  /** Populated when `ran` is false — why no verdict was produced. */
  readonly skipped?: SchemaDriftGateSkip;
  /** Populated when `skipped === 'error'` — the step that threw + a clean
   *  message, so a fail-open error is never a silent black hole. */
  readonly error?: GateFailure;
  /** The effective mode after the loop-seam override. */
  readonly mode: SchemaGateMode;
  /** Active findings (not allowlist-waived). `info` findings are disclosure
   *  only; in `warn` mode every block verdict is demoted to warn. */
  readonly findings: readonly SchemaDriftFinding[];
  /** Findings an active allowlist entry accepted — audit surface. */
  readonly suppressed: readonly SchemaDriftSuppression[];
  /** True when at least one active finding blocks (only in `block` mode). */
  readonly blocks: boolean;
  /** True when at least one active finding warns. */
  readonly warns: boolean;
}

// A fail-open 'error' skip MUST carry the captured failure — the overload makes
// a silent `skip(mode, 'error')` a compile error (the swallow class).
function skip(mode: SchemaGateMode, reason: 'error', failure: GateFailure): SchemaDriftGateOutcome;
function skip(
  mode: SchemaGateMode,
  reason: Exclude<SchemaDriftGateSkip, 'error'>,
): SchemaDriftGateOutcome;
function skip(
  mode: SchemaGateMode,
  reason: SchemaDriftGateSkip,
  failure?: GateFailure,
): SchemaDriftGateOutcome {
  return {
    ran: false,
    skipped: reason,
    mode,
    findings: [],
    suppressed: [],
    blocks: false,
    warns: false,
    ...(failure ? { error: failure } : {}),
  };
}

/** Partition active vs allowlist-suppressed findings — the per-finding
 *  escape hatch (an accepted deliberate breaking change), mirroring the flow
 *  gate's partition. Expired entries do not waive. */
function partitionByAllowlist(
  findings: readonly SchemaDriftFinding[],
  allowlist: AllowlistFile | null | undefined,
  now: Date,
): { active: SchemaDriftFinding[]; suppressed: SchemaDriftSuppression[] } {
  if (!allowlist) return { active: [...findings], suppressed: [] };
  const active: SchemaDriftFinding[] = [];
  const suppressed: SchemaDriftSuppression[] = [];
  for (const f of findings) {
    const entry = findEntry(allowlist, f.id);
    if (entry && entry.kind === 'model-schema-drift' && isEntryActive(entry, now)) {
      suppressed.push({
        finding: f,
        fingerprint: entry.fingerprint,
        category: entry.category,
        ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
      });
    } else {
      active.push(f);
    }
  }
  return { active, suppressed };
}

/**
 * Run the drift gate for a guardrail check. Never throws — the caller ORs
 * `blocks` / `warns` into the overall verdict and attaches the outcome for
 * rendering.
 *
 * @param baseRef the base commit to diff HEAD against (resolved ref in
 *   ref-based mode, the baseline anchor SHA in committed modes). Absent →
 *   the gate skips.
 * @param modeOverride the loop Stop-gate's posture-derived mode — wins over
 *   `.dxkit/policy.json:schema.mode` (the `security-only` preset maps to
 *   `warn` so an unattended loop never wedges on a schema false positive).
 * @param allowlist active `model-schema-drift` entries waive matching
 *   findings from the verdict (the per-finding escape hatch).
 * @param now the clock for allowlist-expiry checks (testability).
 */
export async function evaluateSchemaDriftGateForGuardrail(opts: {
  readonly cwd: string;
  readonly baseRef?: string;
  readonly modeOverride?: SchemaGateMode;
  readonly verbose?: boolean;
  readonly allowlist?: AllowlistFile | null;
  readonly now?: Date;
}): Promise<SchemaDriftGateOutcome> {
  const cwd = path.resolve(opts.cwd);
  const config = readSchemaConfig(cwd);
  // The override softens/hardens an ENABLED gate; it never activates one.
  // Unlike flow (default block), schema defaults to off — an opt-in
  // capability — so a loop preset's `warn` must not switch it on for a repo
  // that never configured it.
  const gateMode: SchemaGateMode =
    config.mode === 'off' ? 'off' : (opts.modeOverride ?? config.mode);

  if (gateMode === 'off') return skip(gateMode, 'off');
  if (!opts.baseRef) return skip(gateMode, 'no-base-ref');
  const ref = opts.baseRef;

  // The step the try body is in — carried into a fail-open error.
  let step = 'changed-files';
  try {
    // Trigger-skip: net-new drift requires a change to a model-capable
    // source file or a configured spec. Null changed-set = can't prove the
    // diff is model-free → fall through and run (safe default).
    const changed = computeChangedFiles(cwd, ref) ?? undefined;
    if (
      changed &&
      !changedFilesTouchModelSurface(changed, detectActiveLanguages(cwd), config.specs)
    ) {
      return skip(gateMode, 'no-model-surface-change');
    }

    // HEAD side (the working tree), repo-relative locators so display
    // metadata is environment-independent and the base side lines up.
    step = 'head-gather';
    const headModels = await gatherModelSet({
      roots: [cwd],
      specs: config.specs.map((s) => path.resolve(cwd, s)),
      relativeTo: cwd,
    });

    // Base side from a detached worktree at the ref (Rule 11), with the SAME
    // config — the HEAD checkout's policy governs both sides so a policy
    // edit in the PR cannot split the comparison.
    step = 'base-worktree';
    const baseModels = await withRefWorktree({ cwd, ref }, async (wt) =>
      gatherModelSet({
        roots: [wt],
        specs: config.specs.map((s) => path.resolve(wt, s)),
        relativeTo: wt,
      }),
    );

    // Neither side declares any model → nothing to compare; gating would be
    // pure noise on a repo the capability cannot see.
    if (headModels.models.length === 0 && baseModels.models.length === 0) {
      return skip(gateMode, 'no-models');
    }

    step = 'evaluate';
    const found = evaluateSchemaDriftGate({
      baseModels,
      headModels,
      blockThreshold: config.blockThreshold,
    });

    // Posture: `warn` demotes block verdicts (info stays disclosure-only).
    const posture =
      gateMode === 'warn'
        ? found.map((f) => (f.verdict === 'block' ? { ...f, verdict: 'warn' as const } : f))
        : found;

    const { active, suppressed } = partitionByAllowlist(
      posture,
      opts.allowlist,
      opts.now ?? new Date(),
    );
    const blocks = gateMode === 'block' && active.some((f) => f.verdict === 'block');
    const warns = active.some((f) => f.verdict === 'warn');

    if (opts.verbose && active.length > 0) {
      process.stderr.write(
        `    [schema] ${active.length} net-new schema drift finding(s) — ${blocks ? 'blocking' : warns ? 'warning' : 'informational'}\n`,
      );
    }
    return { ran: true, mode: gateMode, findings: active, suppressed, blocks, warns };
  } catch (err) {
    // Fail-open: a ref that can't be checked out, a git error — the gate did
    // not run, but it says WHY (step + clean message) rather than swallowing.
    return skip(gateMode, 'error', captureGateFailure(step, err));
  }
}
