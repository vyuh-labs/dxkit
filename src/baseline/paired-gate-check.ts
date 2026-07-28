/**
 * The paired-change gate pass for the guardrail check — an ADDITIVE, fail-open
 * layer over `runGuardrailCheck`, the fourth sibling of the flow integration
 * gate, the model-schema drift gate, and the seam (dup) gate.
 *
 * It answers "did this diff touch a declared pairing's `if` surface without
 * touching its `then` surface?" — the repo-committed "changing X requires also
 * changing Y" invariant (a data model changed but no migration did; a public
 * API changed but no docs did). A violation is a property of ONE DIFF, never of
 * a tree, which is why `paired-change` is a DEFERRED baseline kind minted here,
 * not a full-scan producer — there is nothing to capture and nothing to
 * grandfather.
 *
 * Unlike its three siblings this gate is PURE: it evaluates committed policy
 * globs against the changed-PATH set (git metadata only — no spawn, no
 * worktree, no plugin load, no tree content read). That makes it safe on every
 * surface including untrusted fork PRs, and valid in ref-based mode — the
 * restriction that keeps command checks out of ref-based gating
 * (`REF_UNRELIABLE_KINDS`) is about missing toolchains in bare worktrees, and
 * this gate spawns nothing.
 *
 * Every failure path degrades to "did not gate" and says why: no declared
 * rules (`off`), no base commit, an uncomputable changed set, a thrown git
 * error — all yield a disclosed, non-blocking outcome (`GateFailure`
 * discipline). A violating rule blocks when it declared `blocking: true` (the
 * default) and warns otherwise; an active `paired-change` allowlist entry
 * waives it (the per-finding escape hatch, ideally `deferred` with an expiry).
 */

import { computeChangedPaths } from './changed-files';
import { computePairedChangeFingerprint } from '../analyzers/tools/fingerprint-contract';
import { globToRegex } from '../analyzers/tools/suppressions';
import { normalizePairedChecks, type PairedCheckRule } from '../analyzers/custom-checks/config';
import { loadPolicyFromCwd } from './policy';
import { findEntry, isEntryActive } from '../allowlist/file';
import type { AllowlistFile } from '../allowlist/file';
import { captureGateFailure, type GateFailure } from './gate-failopen';

/** Why the gate produced no verdict, when it didn't run. */
export type PairedGateSkip =
  | 'off' // no `pairedChecks` rules declared (the default — the gate is opt-in)
  | 'no-base-ref' // no base commit resolvable — nothing to diff
  | 'no-changed-set' // the changed-path set could not be computed — cannot evaluate
  | 'error'; // any failure — fail-open, with the captured GateFailure

/** One paired-change violation the gate minted. */
export interface PairedChangeFinding {
  /** Canonical fingerprint (`computePairedChangeFingerprint(name)`). */
  readonly id: string;
  /** The declared rule name — the finding's whole identity. */
  readonly check: string;
  /** Whether this violation blocks (rule-declared; default true). */
  readonly blocking: boolean;
  /** The rule's declared message, when present. */
  readonly message?: string;
  /** Changed paths that matched the `if` globs (capped sample — evidence for
   *  the renderer, never identity). */
  readonly ifMatched: readonly string[];
  /** The rule's `then` globs, echoed so the remedy is self-describing. */
  readonly thenGlobs: readonly string[];
}

/** A violation an active allowlist entry waived from the verdict — surfaced
 *  for audit, excluded from blocks/warns (the dup-gate suppression shape). */
export interface PairedGateSuppression {
  readonly finding: PairedChangeFinding;
  readonly fingerprint: string;
  readonly category: string;
  readonly expiresAt?: string;
}

/** Outcome of the paired-change gate, folded additively into the verdict. */
export interface PairedGateOutcome {
  /** True when the gate actually evaluated the rule set against a diff. */
  readonly ran: boolean;
  /** Populated when `ran` is false — the reason no verdict was produced. */
  readonly skipped?: PairedGateSkip;
  /** Populated when `skipped === 'error'` — never a silent black hole. */
  readonly error?: GateFailure;
  /** Rule-normalization warnings (malformed entries dropped) — disclosed so a
   *  silently-ignored rule is visible. */
  readonly warnings: readonly string[];
  /** Active violations that count toward the verdict. */
  readonly findings: readonly PairedChangeFinding[];
  /** Violations an active allowlist entry accepted. */
  readonly suppressed: readonly PairedGateSuppression[];
  /** True when at least one active violation is on a `blocking: true` rule. */
  readonly blocks: boolean;
  /** True when at least one active violation is on a warn-only rule. */
  readonly warns: boolean;
}

/** Cap the per-finding evidence sample so a sweeping diff stays renderable. */
const MAX_IF_MATCHED_SAMPLE = 5;

// A fail-open 'error' skip MUST carry the captured failure — the overload
// makes a silent `skip('error')` a compile error (the swallow class).
function skip(
  reason: 'error',
  warnings: readonly string[],
  failure: GateFailure,
): PairedGateOutcome;
function skip(
  reason: Exclude<PairedGateSkip, 'error'>,
  warnings?: readonly string[],
): PairedGateOutcome;
function skip(
  reason: PairedGateSkip,
  warnings: readonly string[] = [],
  failure?: GateFailure,
): PairedGateOutcome {
  return {
    ran: false,
    skipped: reason,
    warnings,
    findings: [],
    suppressed: [],
    blocks: false,
    warns: false,
    ...(failure ? { error: failure } : {}),
  };
}

/** Evaluate one rule against the changed-path set. Pure. */
export function evaluatePairedRule(
  rule: PairedCheckRule,
  changedPaths: readonly string[],
): PairedChangeFinding | null {
  const ifRes = rule.ifGlobs.map(globToRegex);
  const thenRes = rule.thenGlobs.map(globToRegex);
  const ifMatched = changedPaths.filter((p) => ifRes.some((re) => re.test(p)));
  if (ifMatched.length === 0) return null;
  const thenTouched = changedPaths.some((p) => thenRes.some((re) => re.test(p)));
  if (thenTouched) return null;
  return {
    id: computePairedChangeFingerprint(rule.name),
    check: rule.name,
    blocking: rule.blocking,
    ...(rule.message !== undefined ? { message: rule.message } : {}),
    ifMatched: ifMatched.slice(0, MAX_IF_MATCHED_SAMPLE),
    thenGlobs: rule.thenGlobs,
  };
}

/** Partition violations into active and allowlist-suppressed (the per-finding
 *  escape hatch, exactly like the dup gate's). */
function partitionByAllowlist(
  findings: readonly PairedChangeFinding[],
  allowlist: AllowlistFile | null | undefined,
  now: Date,
): { active: PairedChangeFinding[]; suppressed: PairedGateSuppression[] } {
  if (!allowlist) return { active: [...findings], suppressed: [] };
  const active: PairedChangeFinding[] = [];
  const suppressed: PairedGateSuppression[] = [];
  for (const f of findings) {
    const entry = findEntry(allowlist, f.id);
    if (entry && entry.kind === 'paired-change' && isEntryActive(entry, now)) {
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
 * Run the paired-change gate for a guardrail check. Never throws — the caller
 * ORs `blocks`/`warns` into the overall verdict and attaches the outcome for
 * rendering.
 *
 * @param baseRef the base commit to diff against (resolved ref in ref-based
 *   mode, or the committed baseline's anchor SHA in committed mode). Absent →
 *   the gate skips, disclosed.
 * @param allowlist an active `paired-change` entry matching a rule's
 *   fingerprint waives it. Omit / null for no suppression.
 * @param now the clock for allowlist-expiry checks (passed for testability).
 * @param changedPathsProvider injected for tests; defaults to the ONE
 *   changed-path computation (`computeChangedPaths` — deletions count).
 */
export function evaluatePairedGateForGuardrail(opts: {
  readonly cwd: string;
  readonly baseRef?: string;
  readonly allowlist?: AllowlistFile | null;
  readonly now?: Date;
  readonly verbose?: boolean;
  readonly changedPathsProvider?: (cwd: string, base: string) => ReadonlyArray<string> | null;
}): PairedGateOutcome {
  const cwd = opts.cwd;
  let step = 'policy-read';
  try {
    const policy = loadPolicyFromCwd(cwd);
    const { rules, warnings } = normalizePairedChecks(policy.pairedChecks);
    if (rules.length === 0 && warnings.length === 0) return skip('off');
    if (rules.length === 0) return skip('off', warnings);
    if (!opts.baseRef) return skip('no-base-ref', warnings);

    step = 'changed-paths';
    const changedPaths = (opts.changedPathsProvider ?? computeChangedPaths)(cwd, opts.baseRef);
    // A null changed set means "cannot evaluate", never "nothing changed" —
    // a declared rule silently skipped would be the invisible-gate class, so
    // the skip is disclosed on the outcome.
    if (changedPaths === null) return skip('no-changed-set', warnings);

    step = 'evaluate-rules';
    const violations = rules
      .map((rule) => evaluatePairedRule(rule, changedPaths))
      .filter((f): f is PairedChangeFinding => f !== null);

    const { active, suppressed } = partitionByAllowlist(
      violations,
      opts.allowlist,
      opts.now ?? new Date(),
    );
    const blocks = active.some((f) => f.blocking);
    const warns = active.some((f) => !f.blocking);
    if (opts.verbose && active.length > 0) {
      process.stderr.write(
        `    [paired] ${active.length} paired-change violation(s) — ${blocks ? 'blocking' : 'warning'}\n`,
      );
    }
    return { ran: true, warnings, findings: active, suppressed, blocks, warns };
  } catch (err) {
    // Fail-open: a git failure, an unreadable policy — the gate did not run,
    // but it says WHY rather than swallowing the throw.
    return skip('error', [], captureGateFailure(step, err));
  }
}
