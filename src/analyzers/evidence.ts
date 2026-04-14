/**
 * Generic evidence type used across all analyzers for detailed reports.
 *
 * A piece of evidence points at a specific location in the codebase that
 * motivated a score deduction or remediation action. Tools produce evidence;
 * formatters consume it.
 *
 * Distinct from SecurityFinding (security/types.ts) which adds severity + CWE
 * for the security-specific findings pipeline.
 */
export interface Evidence {
  /** Relative or absolute file path. */
  file: string;
  /** 1-indexed line number. Omit for file-level findings. */
  line?: number;
  /** Inclusive end line for a range. */
  endLine?: number;
  /** Optional code excerpt for human readers. Truncated to ~200 chars. */
  snippet?: string;
  /** Short stable id for the rule, e.g. "console-log", "god-file". */
  rule: string;
  /** Tool that produced this, e.g. "grep", "graphify", "jscpd". */
  tool: string;
  /** Optional one-line description shown to humans. */
  message?: string;
}

/** A ranked list of offenders for a single metric (e.g. top god files). */
export interface TopOffenders<T> {
  /** Rule id this list is ranked by. */
  rule: string;
  /** Human-readable title for the list ("Files with most functions"). */
  title: string;
  /** Items sorted by severity/size descending. */
  items: T[];
}
