/**
 * Parse the augmented lint tool label produced by the lint dispatcher
 * when one or more language packs returned null silently.
 *
 * Augmented shape: `<tool> (not run: <pack> — <reason>[, <pack> — <reason>])`
 * (the suffix is appended in `analyzeHealth`'s lint augmentation block).
 *
 * The Tools-used footer wants only `<tool>` (anything else reads as
 * "<tool> didn't run because of <pack>"). The Lint coverage gap row
 * wants the inverse — the not-run packs with their per-pack reasons.
 * Centralizing the parse here keeps the two consumers from drifting.
 */
export interface ParsedLintLabel {
  /** The tool that actually ran, with the suffix stripped. */
  tool: string;
  /**
   * Raw "not run" contents (the inside of the parenthetical), or null
   * when the label carries no suffix. Form: `<pack> — <reason>[, ...]`.
   */
  notRunPacks: string | null;
}

const NOT_RUN_RE = /\s*\(not run:\s*([^)]*)\)/;

export function parseLintLabel(label: string): ParsedLintLabel {
  const match = NOT_RUN_RE.exec(label);
  if (!match) return { tool: label.trim(), notRunPacks: null };
  return {
    tool: label.replace(NOT_RUN_RE, '').trim(),
    notRunPacks: match[1].trim() || null,
  };
}

/**
 * Convenience: just the tool name, suffix stripped. Equivalent to
 * `parseLintLabel(label).tool`. Common case at Tools-used-footer
 * construction sites.
 */
export function stripNotRunSuffix(label: string): string {
  return parseLintLabel(label).tool;
}
