/**
 * Content-hash identity — drift-tolerant matching via the actual
 * source code around a finding rather than its line position.
 *
 * The line-bucket identity scheme tolerates ±2 lines of drift; the
 * git-aware matcher tolerates any line shift git can describe.
 * Neither helps when git history is unavailable (shallow clone,
 * force-pushed baseline commit) or when the line-bucket boundary
 * straddles a context-stable region. The content-hash layer is the
 * third fallback: pair findings whose surrounding code is byte-
 * identical, regardless of where in the file they live.
 *
 * Pipeline:
 *
 *   1. The producer (Phase 3 baseline-create) reads each finding's
 *      surrounding context lines, normalizes whitespace, and
 *      computes a SHA-1[0:16] hash. The hash is stamped on the
 *      finding entry in the baseline file.
 *   2. At guardrail-check time, the current scan computes content
 *      hashes the same way for its own findings.
 *   3. The matcher's content-hash pass pairs prior + current
 *      findings with matching `(canonical-rule, contentHash)` after
 *      location-based pairing has exhausted what git can do.
 *
 * Trade-offs vs. line-bucket / git-aware match:
 *
 *   - Survives any vertical drift (the line number is irrelevant).
 *   - Survives file rename + reformat + cross-file refactor when
 *     the immediate context survives.
 *   - Fails when the surrounding context changes — even a single
 *     adjacent variable rename invalidates the hash.
 *   - Vulnerable to collisions when two findings have identical
 *     context (rare for code-pattern findings, more likely for
 *     hygiene markers in similar boilerplate).
 *
 * The matcher tags content-hash matches with confidence 0.80 — below
 * git-line-fuzz (0.88) so the brownfield policy's per-severity
 * thresholds naturally distinguish them. For low-severity findings
 * (threshold 0.90 by default), a content-hash match demotes to
 * `'uncertain'` rather than silently pairing; for critical findings
 * (threshold 0.75), the same match passes through cleanly.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Width of the context window read on each side of the finding's
 * reported line. Three lines above + three lines below + the line
 * itself = a seven-line window that captures the immediate
 * surrounding code without being so wide that unrelated edits
 * invalidate the hash.
 */
export const CONTENT_HASH_CONTEXT_LINES = 3;

/**
 * Pure function: compute the content hash for a finding at `line`
 * inside `fileContent`. Whitespace is normalized — trailing
 * whitespace stripped, internal runs collapsed to a single space,
 * empty lines preserved as empty — so reformat-only edits don't
 * churn the hash.
 *
 * `line` is 1-based to match every other dxkit line-number contract.
 * `contextLines` defaults to `CONTENT_HASH_CONTEXT_LINES`. Lines
 * before the start of the file or past the end are clamped (the
 * window is smaller near the file edges; that's fine — hashing a
 * shorter window is still deterministic).
 */
export function computeContentHash(
  fileContent: string,
  line: number,
  contextLines: number = CONTENT_HASH_CONTEXT_LINES,
): string {
  const lines = fileContent.split('\n');
  const startIdx = Math.max(0, line - 1 - contextLines);
  const endIdx = Math.min(lines.length, line + contextLines);
  const window = lines.slice(startIdx, endIdx);
  const normalized = window.map(normalizeLine).join('\n');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Collapse internal whitespace runs to a single space + strip
 * leading / trailing whitespace. Tab vs spaces, mixed indentation,
 * and trailing whitespace become equivalent. Empty lines pass
 * through as empty (no normalization needed) so they preserve their
 * position-information in the window.
 */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Read a file's content at a specific commit. Returns null when git
 * can't resolve the path-at-commit pair — file didn't exist at
 * `sha`, file is binary, sha is unreachable. Callers treat null
 * the same as "content-hash unavailable for this path."
 *
 * Uses `git show <sha>:<path>` which does not require checking out
 * the commit — safe to call repeatedly in a tight loop without
 * touching the working tree.
 */
export function readFileFromCommit(cwd: string, sha: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], {
      cwd,
      encoding: 'utf8',
      // Cap output size — git show on a 100MB committed binary would
      // otherwise blow the default stdio buffer. 10MB is generous for
      // any real source file.
      maxBuffer: 10 * 1024 * 1024,
      // Silence the "fatal: path X does not exist" message git emits
      // to stderr when the file/sha pair doesn't resolve. Callers
      // expect a null return, not a stderr message bleeding through.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Combined helper: read the file at a commit and compute its
 * content hash at the given line. Returns null when the file
 * couldn't be read. Used by the producer (Phase 3 baseline-create)
 * to stamp content hashes on baseline entries.
 */
export function computeContentHashFromCommit(
  cwd: string,
  sha: string,
  file: string,
  line: number,
  contextLines: number = CONTENT_HASH_CONTEXT_LINES,
): string | null {
  const content = readFileFromCommit(cwd, sha, file);
  if (content === null) return null;
  return computeContentHash(content, line, contextLines);
}
