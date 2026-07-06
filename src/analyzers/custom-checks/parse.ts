/**
 * Turn a check's captured output into findings.
 *
 * Pure module — no I/O. The runner decides WHICH of these to call based on the
 * check's parse mode + exit code (see run.ts):
 *   - `parseLocated` extracts one located finding per matching output line. It is
 *     called REGARDLESS of exit code, because many linters exit 0 even when they
 *     report findings (C#/Java analyzers via a build, eslint with warnings only).
 *     Net-new-ness is judged per finding downstream, so "clean" is simply "zero
 *     matches", not "exit 0".
 *   - `binaryFinding` is the one whole-command finding used for a binary
 *     (`exit`-mode) check, or as the fallback when a regex-mode check FAILED
 *     (non-expected exit) yet produced nothing parseable — so a failing check
 *     never silently yields zero findings.
 */

import type { CustomCheckFinding } from './types';

/** Cap on located findings per check — a catastrophic run (thousands of lint
 *  errors) shouldn't balloon the baseline. Beyond this we keep the first N PLUS
 *  a binary catch-all so the overflow still gates. */
const MAX_LOCATED = 500;

/**
 * Parse a regex `pattern` (with named `file` / `line` / `rule` / `message`
 * groups) over `output`, one finding per matching line. `file` is required for a
 * match to count. Dedupes identical (file, line, rule) within one run.
 * A malformed pattern yields a single binary finding flagging the misconfig
 * (never crashes the gate).
 */
export function parseLocated(
  check: string,
  blocking: boolean,
  pattern: string,
  output: string,
): CustomCheckFinding[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return [
      binaryFinding(
        check,
        blocking,
        `custom-check '${check}': invalid parse regex — reporting as a whole-command failure.`,
      ),
    ];
  }

  const located: CustomCheckFinding[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const groups = re.exec(line)?.groups;
    if (!groups || groups.file === undefined) continue;
    const file = groups.file.trim();
    if (!file) continue;
    const lineNo = groups.line !== undefined ? parseIntSafe(groups.line) : undefined;
    const rule = groups.rule?.trim() || undefined;
    const message = groups.message?.trim() || line.trim() || undefined;
    const key = `${file}\0${lineNo ?? ''}\0${rule ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    located.push({
      check,
      blocking,
      file,
      ...(lineNo !== undefined ? { line: lineNo } : {}),
      ...(rule !== undefined ? { rule } : {}),
      ...(message !== undefined ? { message } : {}),
    });
    if (located.length >= MAX_LOCATED) {
      located.push(
        binaryFinding(
          check,
          blocking,
          `custom-check '${check}': more than ${MAX_LOCATED} findings — only the first ${MAX_LOCATED} are itemized; this catch-all gates the overflow.`,
        ),
      );
      break;
    }
  }
  return located;
}

/** One whole-command finding (binary check, or a failing regex check that parsed
 *  nothing). `message` is the captured output tail (display only). */
export function binaryFinding(
  check: string,
  blocking: boolean,
  outputTail: string,
): CustomCheckFinding {
  const message = outputTail.trim() || undefined;
  return { check, blocking, ...(message !== undefined ? { message } : {}) };
}

/** Parse a line number, tolerating trailing punctuation. Undefined for a
 *  non-numeric capture (the finding stays file-only). */
function parseIntSafe(s: string): number | undefined {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
