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

import { computeChangedFiles, createChangedLineIndex } from './changed-files';
import type { ChangedLineIndex } from './changed-files';
import { withRefWorktree } from './ref-baseline';
import type { DuplicateAnchor } from './types';
import { gatherDuplicateFindings, type DuplicateFinding } from '../analyzers/duplication/findings';
import { readDuplicationConfig, type DuplicationGateMode } from '../analyzers/duplication/config';
import { allSourceExtensions } from '../languages';
import { findEntry, isEntryActive } from '../allowlist/file';
import type { AllowlistFile } from '../allowlist/file';
import { captureGateFailure, type GateFailure } from './gate-failopen';

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
  /** Populated when `skipped === 'error'` — the step that threw + a clean
   *  message, so a fail-open error is never a silent black hole. */
  readonly error?: GateFailure;
  /** The effective mode after the preset override (`block` / `warn` / `off`).
   *  `block` does NOT make a lone duplicate block — it authorizes seam
   *  convergence (downstream) to escalate a duplicate that is also reliably
   *  dead. A lone duplicate is always warn-tier. */
  readonly mode: DuplicationGateMode;
  /** Net-new structural duplicates that count toward the verdict (active — NOT
   *  waived by an allowlist entry). Warn-tier by default. */
  readonly findings: readonly DuplicateFinding[];
  /** Net-new duplicates an active allowlist entry accepted — surfaced for
   *  audit, excluded from `warns`. */
  readonly suppressed: readonly DupGateSuppression[];
  /** True ONLY under the explicit `duplication.loneSeams: "block"` opt-in
   *  (with `mode: "block"`): a lone net-new duplicate fails the build, with
   *  the `code-reimplementation` allowlist as the typed escape hatch. Default
   *  posture keeps this false — the tier-3 precision floor. */
  readonly blocks: boolean;
  /** True when at least one active net-new duplicate warns (and the gate is
   *  not already blocking on them). */
  readonly warns: boolean;
}

// A fail-open 'error' skip MUST carry the captured failure — the overload makes
// a silent `skip(mode, 'error')` a compile error (the swallow class).
function skip(mode: DuplicationGateMode, reason: 'error', failure: GateFailure): DupGateOutcome;
function skip(mode: DuplicationGateMode, reason: Exclude<DupGateSkip, 'error'>): DupGateOutcome;
function skip(
  mode: DuplicationGateMode,
  reason: DupGateSkip,
  failure?: GateFailure,
): DupGateOutcome {
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

/** Line-independent pair key: the two (file, symbol) endpoints, sorted. The
 *  same two functions remain the same structural relation wherever an edit
 *  moved them in the file — the relocation half of pair identity that the
 *  line-window fingerprint (kept stable for allowlist/baseline continuity)
 *  cannot provide. */
function pairEndpointsKey(f: Pick<DuplicateFinding, 'anchors'>): string {
  const k = (a: DuplicateAnchor) => `${a.file}\0${a.symbol}`;
  return [k(f.anchors[0]), k(f.anchors[1])].sort().join('\0\0');
}

/** Did the diff touch THIS anchor's function? Intersects the anchor's span
 *  with the canonical changed-line index; falls back to the file-level claim
 *  when line attribution is unavailable (unknown must never read as
 *  "untouched" — but equally a merely-same-file sibling must not read as
 *  added when line truth IS available). */
function anchorTouched(
  index: ChangedLineIndex | null,
  focusFiles: ReadonlySet<string>,
  anchor: DuplicateAnchor,
  endLine: number | undefined,
): boolean {
  if (!focusFiles.has(anchor.file)) return false;
  if (!index) return true; // no line attribution at all — file-level fallback
  const lines = index.linesFor(anchor.file);
  if (lines === 'all' || lines === null) return true;
  const end = endLine ?? anchor.line;
  for (const ln of lines) {
    if (ln >= anchor.line && ln <= end) return true;
  }
  return false;
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
    opts: { minScore: number; focusFiles?: ReadonlySet<string>; minBodyTokens?: number },
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

  // The step the try body is in — carried into a fail-open error.
  let step = 'changed-files';
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
    step = 'head-gather';
    const headFindings = await gatherDuplicates(cwd, {
      minScore: config.minScore,
      ...(focusFiles ? { focusFiles } : {}),
      ...(config.minBodyTokens > 0 ? { minBodyTokens: config.minBodyTokens } : {}),
    });
    // No diff-scoped duplicate on the HEAD side → nothing to gate. Skip WITHOUT
    // scanning the base ref — the primary cost guard (one scan, not two).
    if (headFindings.length === 0) return skip(gateMode, 'no-candidates');

    // Base side — the duplicate-pair set at the base ref, gathered from a
    // detached worktree (Rule 11). A pair present here is grandfathered.
    step = 'base-worktree';
    const baseFindings = await withRefWorktree({ cwd, ref }, async (wt) =>
      gatherDuplicates(wt, {
        minScore: config.minScore,
        ...(focusFiles ? { focusFiles } : {}),
        ...(config.minBodyTokens > 0 ? { minBodyTokens: config.minBodyTokens } : {}),
      }),
    );

    // Net-new = a HEAD pair whose RELATION is new — matched in two passes, the
    // matchAcrossRuns multiset discipline. Pass 1: exact fingerprint. Pass 2:
    // the line-INDEPENDENT pair key (the two (file, symbol) endpoints). The
    // fingerprint hashes each anchor's line window, so an edit that shifts
    // lines re-mints every pre-existing pair in the file — the class that
    // reported a bindings module's 7 untouched wrapper pairs as "both added"
    // after one sibling gained a kwarg. A base pair with the same endpoints
    // grandfathers ONE head pair (multiset-counted, so a genuinely-new twin
    // joining an existing parallel family still exceeds the base count and is
    // flagged).
    const baseIds = new Set(baseFindings.map((f) => f.id));
    const headIds = new Set(headFindings.map((f) => f.id));
    const relocatable = new Map<string, number>();
    for (const bf of baseFindings) {
      if (headIds.has(bf.id)) continue; // consumed by an exact match in pass 1
      const k = pairEndpointsKey(bf);
      relocatable.set(k, (relocatable.get(k) ?? 0) + 1);
    }

    // Function-level "which side did the change introduce" — the canonical
    // changed-LINE index intersected with each anchor's span, so an untouched
    // sibling in a modified file is never labeled added. Falls back to the
    // file-level claim when line attribution is unavailable (null = UNKNOWN,
    // never "nothing changed").
    const lineIndex = focusFiles ? createChangedLineIndex(cwd, ref) : null;

    const netNew: DuplicateFinding[] = [];
    for (const hf of headFindings) {
      if (baseIds.has(hf.id)) continue; // pass 1: exact identity persisted
      const k = pairEndpointsKey(hf);
      const avail = relocatable.get(k) ?? 0;
      if (avail > 0) {
        relocatable.set(k, avail - 1); // pass 2: relocated by a line shift
        continue;
      }
      netNew.push(
        focusFiles
          ? {
              ...hf,
              changed: [
                anchorTouched(lineIndex, focusFiles, hf.anchors[0], hf.anchorEnds?.[0]),
                anchorTouched(lineIndex, focusFiles, hf.anchors[1], hf.anchorEnds?.[1]),
              ] as const,
            }
          : hf,
      );
    }

    const { active, suppressed } = partitionByAllowlist(
      netNew,
      opts.allowlist,
      opts.now ?? new Date(),
    );
    // Default: a lone duplicate is warn-tier (block confidence comes only from
    // seam convergence, downstream). The explicit `loneSeams: "block"` opt-in
    // (under mode "block") escalates a lone net-new seam to a build failure —
    // the allowlist is the typed escape hatch.
    const blocks = gateMode === 'block' && config.loneSeams === 'block' && active.length > 0;
    const warns = active.length > 0 && !blocks;

    if (opts.verbose && active.length > 0) {
      process.stderr.write(
        `    [seam] ${active.length} net-new structural duplicate(s) — ${blocks ? 'blocking (loneSeams: block)' : 'warning'}\n`,
      );
    }
    return { ran: true, mode: gateMode, findings: active, suppressed, blocks, warns };
  } catch (err) {
    // Fail-open: a ref that can't be checked out, an unparseable tree, a
    // graphify error — none of these should fail the guardrail. The gate did
    // not run, but it says WHY rather than swallowing the throw.
    return skip(gateMode, 'error', captureGateFailure(step, err));
  }
}
