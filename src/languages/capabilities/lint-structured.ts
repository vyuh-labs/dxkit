/**
 * Shared helpers for pack lint parsers over native machine-readable linter
 * output (`LintOutputParse.kind === 'structured'`).
 *
 * The runner captures a check's COMBINED output: on a non-zero exit (the
 * normal case for a linter with findings) that is the full stdout followed by
 * the full stderr — concatenated whole streams, not interleaved. So a JSON
 * payload on stdout arrives intact but may be FOLLOWED by stderr noise
 * (deprecation warnings, npx banners), and may be PRECEDED by stdout noise
 * from a wrapper. A bare `JSON.parse(output)` therefore fails on real runs
 * that a terminal makes look clean; every blob-JSON pack parser goes through
 * `extractJsonBlob` instead, and NDJSON linters (cargo's message format)
 * through `jsonLines`. One extraction discipline, every pack (Rule 2).
 */

/**
 * Parse the first complete JSON array/object embedded in `output`, tolerating
 * text before and after it. Returns null when no parseable payload exists —
 * the pack parser then reports no findings and the runner's failed-exit
 * fallback surfaces the run as one binary finding, so a broken linter is
 * never silently read as "clean".
 *
 * Candidate starts are tried in order until one PARSES: the first bracket in
 * the stream is often not the payload — ktlint logs to STDOUT before its
 * JSON (`10:36:22 [main] INFO … patterns [**\/*.kt]`), so anchoring on the
 * first `[` reads `[main]`, fails, and silently downgrades the whole run to
 * one binary finding (found live on a real Kotlin repo). Attempts are capped:
 * genuine linter noise carries a handful of brackets, and an output whose
 * first hundred candidates all fail is not a payload with a bad prefix.
 */
export function extractJsonBlob(output: string): unknown {
  const MAX_ATTEMPTS = 100;
  let attempts = 0;
  for (let start = nextPayloadStart(output, 0); start !== -1 && attempts < MAX_ATTEMPTS; ) {
    attempts++;
    const end = matchingClose(output, start);
    if (end !== -1) {
      try {
        return JSON.parse(output.slice(start, end + 1));
      } catch {
        // Balanced but not JSON (a bracketed log token) — try the next candidate.
      }
    }
    start = nextPayloadStart(output, start + 1);
  }
  return null;
}

/** Next `[` or `{` at or after `from` that could start the payload. */
function nextPayloadStart(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '{') return i;
  }
  return -1;
}

/** Index of the bracket closing the payload opened at `start`, honoring JSON
 *  string literals and escapes. -1 when the payload never closes (a fragment). */
function matchingClose(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse newline-delimited JSON (cargo/clippy's `--message-format json`),
 * skipping lines that are not JSON — which is exactly what makes NDJSON
 * robust to interleaved diagnostics: a stray stderr line costs that line,
 * never the whole payload.
 */
export function jsonLines(output: string): unknown[] {
  const out: unknown[] = [];
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // not JSON — skip the line, keep the stream
    }
  }
  return out;
}

/** Narrow an unknown to a record for defensive field access. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** A string field, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** A finite positive number field, or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
