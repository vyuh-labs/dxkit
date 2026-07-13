/**
 * The structural-duplicate (seam) gate pass for the guardrail check — an
 * ADDITIVE, fail-open layer over `runGuardrailCheck`, the third sibling of the
 * flow integration gate and the model-schema drift gate.
 *
 * It answers "did this diff ADD a structural code-reimplementation?" — a
 * function the call graph shows to be the same routine written twice, the
 * textbook agent copy-paste. Like flow-binding and model-schema-drift, a
 * duplicate is a two-ref RELATION: the gate gathers the duplicate-pair set at
 * base AND head and mints only the pairs the diff INTRODUCES (a pair present at
 * the base ref is grandfathered). That is why `code-reimplementation` is a
 * DEFERRED baseline kind minted here, not a full-scan producer — so an upgrade
 * adds no backlog to flood the gate.
 *
 * Cost discipline (this gate builds the code graph, the heaviest thing dxkit
 * does — unlike the cheap flow/schema gathers):
 *   - OPT-IN. `.dxkit/policy.json:duplication.mode` defaults to `off`; a repo
 *     that never configured it never pays a graph build (mirror of the schema
 *     gate — a preset softens/hardens but never activates).
 *   - Trigger-skip when the diff touched no source file.
 *   - Diff-SCOPE the HEAD scan to pairs that touch a changed file, and build the
 *     BASE graph ONLY when the HEAD side produced candidates. A change with no
 *     candidate duplicate pays exactly one (HEAD) graph build, never two.
 *   - Zero-write: the graph is taken from the producer IN MEMORY
 *     (`gatherGraphifyGraph({ writeToDisk: false })`) and indexed in-process, so
 *     the gate writes no `graph.json` (the `evaluate` zero-write guarantee).
 *
 * Every failure path degrades to "did not gate": no base ref, an unparseable
 * tree, graphify not installed — all yield an empty, non-blocking outcome. The
 * gate NEVER blocks on its own: a lone duplicate is warn-tier (the anti-slop
 * proof's precision floor). Block confidence comes only from seam CONVERGENCE
 * (duplicate ∩ reliably-dead surface), computed downstream at the verdict stage.
 */

import { computeChangedFiles } from './changed-files';
import { withRefWorktree } from './ref-baseline';
import { gatherDuplicateFindings, type DuplicateFinding } from '../analyzers/duplication/findings';
import { readDuplicationConfig, type DuplicationGateMode } from '../analyzers/duplication/config';
import { allSourceExtensions } from '../languages';
import { findEntry, isEntryActive } from '../allowlist/file';
import type { AllowlistFile } from '../allowlist/file';

/** Why the gate produced no verdict, when it didn't run. */
export type DupGateSkip =
  | 'off' // policy `duplication.mode: off` (the default — the gate is opt-in)
  | 'no-base-ref' // no base commit resolvable (no ref, no baseline anchor SHA)
  | 'no-source-change' // the diff touched no source file — no duplicate possible
  | 'no-candidates' // HEAD produced no diff-scoped duplicate — nothing to gate
  | 'error'; // any failure (unparseable tree, un-checkoutable ref) — fail-open

/** A net-new duplicate an active allowlist entry waived from the verdict.
 *  Mirrors the flow gate's `FlowGateSuppression`: still surfaced for audit,
 *  excluded from `warns`. */
export interface DupGateSuppression {
  readonly finding: DuplicateFinding;
  readonly fingerprint: string;
  readonly category: string;
  readonly expiresAt?: string;
}

/** Outcome of the seam gate pass, folded additively into the guardrail verdict. */
export interface DupGateOutcome {
  /** True when the gate actually evaluated a base↔HEAD comparison. */
  readonly ran: boolean;
  /** Populated when `ran` is false — the reason no verdict was produced. */
  readonly skipped?: DupGateSkip;
  /** The effective mode after the preset override (`block` / `warn` / `off`).
   *  `block` does NOT make a lone duplicate block — it authorizes seam
   *  convergence (downstream) to escalate a duplicate that is also reliably
   *  dead. A lone duplicate is always warn-tier. */
  readonly mode: DuplicationGateMode;
  /** Net-new structural duplicates that count toward the verdict (active — NOT
   *  waived by an allowlist entry). Always warn-tier here. */
  readonly findings: readonly DuplicateFinding[];
  /** Net-new duplicates an active allowlist entry accepted — surfaced for
   *  audit, excluded from `warns`. */
  readonly suppressed: readonly DupGateSuppression[];
  /** Always false for a lone duplicate — the gate never blocks on its own. */
  readonly blocks: boolean;
  /** True when at least one active net-new duplicate warns. */
  readonly warns: boolean;
}

function skip(mode: DuplicationGateMode, reason: DupGateSkip): DupGateOutcome {
  return {
    ran: false,
    skipped: reason,
    mode,
    findings: [],
    suppressed: [],
    blocks: false,
    warns: false,
  };
}

/**
 * Partition net-new duplicates into active (count toward the verdict) and
 * allowlist-suppressed. A `code-reimplementation` allowlist entry whose
 * fingerprint matches a finding's id, is the right kind, and is unexpired waives
 * it — the per-finding escape hatch for a sanctioned by-design parallel, exactly
 * like the flow gate's flow-binding suppression.
 */
function partitionByAllowlist(
  findings: readonly DuplicateFinding[],
  allowlist: AllowlistFile | null | undefined,
  now: Date,
): { active: DuplicateFinding[]; suppressed: DupGateSuppression[] } {
  if (!allowlist) return { active: [...findings], suppressed: [] };
  const active: DuplicateFinding[] = [];
  const suppressed: DupGateSuppression[] = [];
  for (const f of findings) {
    const entry = findEntry(allowlist, f.id);
    if (entry && entry.kind === 'code-reimplementation' && isEntryActive(entry, now)) {
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
 * Run the seam gate for a guardrail check. Never throws — a caller ORs the
 * returned `warns` into the overall verdict and attaches the outcome for
 * rendering + downstream convergence.
 *
 * @param baseRef the base commit to diff HEAD against (resolved ref in ref-based
 *   mode, or the committed baseline's anchor SHA in committed mode). Absent →
 *   the gate skips.
 * @param modeOverride the preset's posture — softens/hardens an ENABLED gate,
 *   never activates one (the schema-gate discipline).
 * @param allowlist an active `code-reimplementation` entry matching a finding
 *   waives it (the per-finding escape hatch). Omit / null for no suppression.
 * @param now the clock for allowlist-expiry checks (passed for testability).
 */
export async function evaluateDupGateForGuardrail(opts: {
  readonly cwd: string;
  readonly baseRef?: string;
  readonly modeOverride?: DuplicationGateMode;
  readonly verbose?: boolean;
  readonly allowlist?: AllowlistFile | null;
  readonly now?: Date;
  /** Duplicate-findings provider, injected for tests. Defaults to the AST-native
   *  `gatherDuplicateFindings` (reads dxkit's own tree-sitter AST — no graphify,
   *  no graph.json write). Called once for HEAD (`dir === cwd`) and once for the
   *  base ref (`dir === the worktree`). */
  readonly gatherDuplicates?: (
    dir: string,
    opts: { minScore: number; focusFiles?: ReadonlySet<string> },
  ) => Promise<DuplicateFinding[]>;
}): Promise<DupGateOutcome> {
  const cwd = opts.cwd;
  const gatherDuplicates = opts.gatherDuplicates ?? ((dir, o) => gatherDuplicateFindings(dir, o));
  const config = readDuplicationConfig(cwd);
  // The override softens/hardens an ENABLED gate; it never activates one (like
  // schema, unlike flow's default-block) — the graph build is too heavy to
  // switch on for a repo that never configured it.
  const gateMode: DuplicationGateMode =
    config.mode === 'off' ? 'off' : (opts.modeOverride ?? config.mode);

  if (gateMode === 'off') return skip(gateMode, 'off');
  if (!opts.baseRef) return skip(gateMode, 'no-base-ref');
  const ref = opts.baseRef;

  try {
    // Trigger-skip: a net-new duplicate requires a change to a source file.
    // A null changed-set = can't prove the diff is source-free → fall through
    // and run unscoped (safe default), the flow/schema-gate discipline.
    const changed = computeChangedFiles(cwd, ref);
    const exts = allSourceExtensions();
    // Diff-scope: only score HEAD pairs that touch a changed SOURCE file. When
    // the changed set is unknown (null), run unscoped — correct, just slower.
    const focusFiles = changed
      ? new Set(changed.filter((f) => exts.some((e) => f.endsWith(e))))
      : undefined;
    if (focusFiles && focusFiles.size === 0) {
      return skip(gateMode, 'no-source-change');
    }

    // HEAD side — duplicate findings from dxkit's own AST (no graph.json write;
    // the zero-write guarantee). Diff-scoped to pairs touching a changed file.
    const headFindings = await gatherDuplicates(cwd, {
      minScore: config.minScore,
      ...(focusFiles ? { focusFiles } : {}),
    });
    // No diff-scoped duplicate on the HEAD side → nothing to gate. Skip WITHOUT
    // scanning the base ref — the primary cost guard (one scan, not two).
    if (headFindings.length === 0) return skip(gateMode, 'no-candidates');

    // Base side — the duplicate-pair ID set at the base ref, gathered from a
    // detached worktree (Rule 11). A pair present here is grandfathered.
    const baseIds = await withRefWorktree({ cwd, ref }, async (wt) => {
      const baseFindings = await gatherDuplicates(wt, {
        minScore: config.minScore,
        ...(focusFiles ? { focusFiles } : {}),
      });
      return new Set(baseFindings.map((f) => f.id));
    });

    // Net-new = a HEAD duplicate whose identity is not present at base.
    // Mark which anchor(s) the change INTRODUCED (file in the changed set) so the
    // remediation is directional — "you added A, which duplicates existing B" —
    // instead of a symmetric pair the agent must disambiguate itself.
    const netNew = headFindings
      .filter((f) => !baseIds.has(f.id))
      .map((f) =>
        focusFiles
          ? {
              ...f,
              changed: [
                focusFiles.has(f.anchors[0].file),
                focusFiles.has(f.anchors[1].file),
              ] as const,
            }
          : f,
      );

    const { active, suppressed } = partitionByAllowlist(
      netNew,
      opts.allowlist,
      opts.now ?? new Date(),
    );
    // A lone duplicate is ALWAYS warn-tier — the gate never blocks on its own.
    // Block confidence is earned only by seam convergence, downstream.
    const warns = active.length > 0;

    if (opts.verbose && active.length > 0) {
      process.stderr.write(
        `    [seam] ${active.length} net-new structural duplicate(s) — warning\n`,
      );
    }
    return { ran: true, mode: gateMode, findings: active, suppressed, blocks: false, warns };
  } catch {
    // Fail-open: a ref that can't be checked out, an unparseable tree, a
    // graphify error — none of these should fail the guardrail.
    return skip(gateMode, 'error');
  }
}
