/**
 * The gate engine's request vocabulary (4.4.0 WP1).
 *
 * Every gate dxkit runs is the same judgment: a SUBJECT (the tree being
 * judged) against a PRIOR (what was already true) under a POLICY. The
 * engine (`./engine.ts:runGate`) is the ONE implementation of that
 * judgment; the surfaces (`guardrail check` today, `gate <dir>` in WP2,
 * `gate --workspace` in WP7) are thin parameterizations of it — never
 * parallel pipelines (CLAUDE.md Rule 2 applied to the gate itself).
 *
 * The PRIOR is expressed as a `ResolvedMode` (Rule 11's one resolver):
 * `committed-full` / `committed-sanitized` read a baseline file,
 * `ref-based` materializes a git ref. WP2 extends the same union with
 * `fresh` (empty prior — everything net-new by construction) and
 * `tree-baseline` (gather of a supplied directory), so prior acquisition
 * keeps exactly one home (`./prior.ts`).
 */

import type { AnalysisTrustContext } from '../analysis-trust';
import type { GatherScope } from '../baseline/gather-scope';
import type { DuplicationGateMode } from '../analyzers/duplication/config';
import type { SchemaGateMode } from '../analyzers/model-schema/config';
import type { FlowGateMode } from '../analyzers/flow/config';

/**
 * What is being judged. `repo` is a git working tree (the only subject
 * until WP2): the engine may read git history for changed-line
 * attribution, run the git-aware matcher's relocation passes, and
 * resolve refs. The `tree` subject (WP2 — a bare directory, no git) and
 * the `workspace` subject (WP7 — member trees + a composed flow model)
 * join this union; engine steps that need git degrade DECLARATIVELY per
 * subject kind (disclosed skip, never a silent one).
 */
export interface RepoSubject {
  readonly kind: 'repo';
  /** Absolute path to the repo root. */
  readonly cwd: string;
}

export type GateSubject = RepoSubject;

/**
 * Engine-level options — the subset of the guardrail surface's options
 * the engine itself consumes. The guardrail wrapper's own concerns
 * (policy resolution inputs, mode-resolution flags) live on
 * `RunGuardrailCheckOptions` in `src/baseline/check.ts`, which extends
 * this interface so callers keep one flat options object.
 */
export interface GateEngineOptions {
  /** Baseline name to read from `.dxkit/baselines/<name>.json`.
   *  Defaults to `'main'`. */
  readonly name?: string;
  /** Explicit baseline file path. Overrides `name` when supplied —
   *  lets callers diff against a baseline stored outside the default
   *  directory (e.g. an artifact downloaded from CI). */
  readonly baselinePath?: string;
  /** When true, drop pairs whose locator falls outside the diff.
   *  Non-locator findings (dep-vuln, duplication, etc.) are always
   *  kept. */
  readonly changedOnly?: boolean;
  /** Forwarded to the underlying analyzers for per-tool timing logs. */
  readonly verbose?: boolean;
  /**
   * Restrict both sides of the gather to the analyzers a scope needs.
   * Defaults to `FULL_SCOPE`, so CI / `baseline check` gather everything
   * and still render every warning. The loop Stop-gate passes a
   * policy-derived scope (`scopeForPolicy`) so a `security-only` posture
   * skips the analyzers it can never block on. Both the current side and
   * the ref side are scoped identically so the cross-run diff stays
   * balanced. Opt-in by construction: only callers that pass a scope
   * change what is gathered.
   */
  readonly scope?: GatherScope;
  /**
   * Incremental scanning (opt 3): when true, semgrep scans only files that
   * changed vs the comparison base, instead of the whole tree. Sound for a
   * net-new gate (semgrep is intraprocedural — a net-new code finding only
   * appears in a changed file). Scope by mode:
   *   - committed: only the CURRENT side is scoped (the prior side is the
   *     on-disk, already-full baseline), against the baseline's commit.
   *   - ref-based: the changed set is fully computable (`diff(ref, HEAD)`),
   *     so BOTH the ref side and the current side are scoped to the SAME
   *     set, keeping the cross-run diff symmetric. This makes a ref-based
   *     guardrail (CI, pre-push, the hosted PR gate) scale with PR size
   *     rather than repo size.
   * Falls back to a full scan when the changed set can't be computed
   * completely. Opt-in: the loop Stop-gate sets it, and `guardrail check
   * --incremental` exposes it on the CLI; otherwise it stays false so the
   * full report is unaffected.
   */
  readonly incremental?: boolean;
  /**
   * Treat the scanned source as untrusted (a hosted PR gate on
   * attacker-controlled code): dependency audits must not execute it. The
   * Python pack drops `pip-audit .` project mode (its build backend can run
   * code) and audits only a requirements file. Exposed as
   * `guardrail check --untrusted`; off by default (trusted local runs and the
   * loop on your own repo keep full coverage).
   */
  readonly trust: AnalysisTrustContext;
  /**
   * Loop-seam override for the flow integration gate's posture (`block` /
   * `warn` / `off`), winning over `.dxkit/policy.json:flow.mode`. The loop
   * Stop-gate derives it from the active preset (`security-only` → `warn`,
   * `full-debt` → `block`) so an unattended loop doesn't wedge on a cross-repo
   * integration false positive, while CI / `guardrail check` (which don't set
   * it) honor the repo's configured mode. The gate runs only in ref-based mode
   * regardless.
   */
  readonly flowMode?: FlowGateMode;
  /**
   * Loop-seam override for the model-schema drift gate's posture, mirroring
   * `flowMode` with one difference: schema defaults to OFF (opt-in), so the
   * override softens/hardens an enabled gate but never activates one the
   * repo did not configure.
   */
  readonly schemaMode?: SchemaGateMode;
  /**
   * Loop-seam override for the structural-duplicate (seam) gate's posture,
   * mirroring `schemaMode`: the seam gate defaults to OFF (opt-in — it builds
   * the code graph), so the override softens/hardens an enabled gate but never
   * activates one the repo did not configure.
   */
  readonly duplicationMode?: DuplicationGateMode;
}
