/**
 * The EFFECTIVE allowlist for a repo — the ONE construction of "what this repo
 * currently suppresses" (CLAUDE.md Rule 2).
 *
 * "The effective allowlist" = the committed file-level `allowlist.json`
 * augmented with ephemeral entries synthesized from inline `dxkit-allow:`
 * annotations covering the current findings. Every finding-consuming surface
 * needs it: the guardrail check (to waive a net-new block), the security
 * aggregate/score (to lift accepted findings), and `baseline create` (to keep
 * an allowlisted finding OUT of the grandfathered set — gh #155).
 *
 * Before this module each surface built the effective allowlist inline
 * (`augmentAllowlistWithInline(loadAllowlist(cwd), synthesizeInlineEntries(...))`)
 * — a copy-paste of the SAME three-call recipe — and `baseline create` simply
 * forgot it, so an allowlisted finding grandfathered into the baseline as
 * `persisted`: it never lifted from the score AND its allowlist expiry could
 * never re-expose it (a `persisted` finding never blocks). Routing every
 * surface through this one function is what makes a new finding-consumer
 * unable to silently ignore the allowlist. The arch-check bans
 * `augmentAllowlistWithInline(` outside this file so the recipe cannot be
 * re-inlined.
 */

import type { IdentityKind } from '../baseline/producers';
import type { AllowlistFile } from './file';
import { loadAllowlist } from './file';
import { gatherInlineAllowlistAnnotations, type InlineAllowlistOccurrence } from './gather';
import { augmentAllowlistWithInline, synthesizeInlineEntries } from './inline-synth';

/**
 * The minimal finding shape the effective-allowlist construction needs. A
 * finding with a resolvable `file` + `line` can be covered by an inline
 * annotation sitting on/above it; one without still matters for file-level
 * suppression (matched later by fingerprint + kind). `fingerprint` is the
 * finding's durable identity (Rule 9).
 */
export interface AllowlistableFinding {
  readonly fingerprint: string;
  readonly kind: IdentityKind;
  readonly file?: string;
  readonly line?: number;
}

export interface EffectiveAllowlistInput {
  /** Current findings — used only to know which findings an inline annotation
   *  covers, so the synth can mint a fingerprint-keyed ephemeral entry. */
  readonly findings: readonly AllowlistableFinding[];
  /**
   * Committed file-level allowlist. Pass it explicitly (the pure aggregator
   * loads it once and threads it in so it does no I/O of its own); OMIT it to
   * have this function `loadAllowlist(cwd)` — then `cwd` is required. `null`
   * means "no file-level allowlist" and is distinct from omitted.
   */
  readonly base?: AllowlistFile | null;
  /**
   * Inline `dxkit-allow:` occurrences. Pass them when already gathered (the
   * baseline producer context + the aggregator carry them); OMIT to gather
   * from `cwd`.
   */
  readonly inlineAnnotations?: readonly InlineAllowlistOccurrence[];
  /** Repo root. Required only when `base` or `inlineAnnotations` is omitted. */
  readonly cwd?: string;
}

function requireCwd(input: EffectiveAllowlistInput, missing: string): string {
  if (input.cwd === undefined) {
    throw new Error(
      `resolveEffectiveAllowlist: '${missing}' was omitted, so 'cwd' is required to derive it.`,
    );
  }
  return input.cwd;
}

/**
 * Build the effective allowlist (file-level ∪ inline). Returns `null` only when
 * there is neither a file-level allowlist nor any inline suppression — the same
 * "nothing to suppress" signal `loadAllowlist` returns, so callers keep their
 * existing null-handling.
 */
export function resolveEffectiveAllowlist(input: EffectiveAllowlistInput): AllowlistFile | null {
  const base = input.base !== undefined ? input.base : loadAllowlist(requireCwd(input, 'base'));
  const annotations =
    input.inlineAnnotations !== undefined
      ? input.inlineAnnotations
      : gatherInlineAllowlistAnnotations(requireCwd(input, 'inlineAnnotations'));

  const synth = synthesizeInlineEntries(
    annotations,
    input.findings
      .filter((f): f is AllowlistableFinding & { file: string; line: number } => {
        return f.file !== undefined && f.line !== undefined;
      })
      .map((f) => ({ file: f.file, line: f.line, fingerprint: f.fingerprint, kind: f.kind })),
  );
  return augmentAllowlistWithInline(base, synth);
}
