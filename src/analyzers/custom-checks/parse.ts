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

/**
 * Safety ceiling on located findings per check. Reaching it does NOT truncate
 * the list — it converts the check to a single BINARY finding.
 *
 * That distinction is the whole point. The previous cap (500) kept the FIRST
 * 500 findings, which made the itemized set a function of the output's content:
 * fix one pre-existing error and the 501st slid into the window, was never
 * baselined, and read as NET-NEW. A developer got blocked for fixing lint. Same
 * shape as the 4 KB output tail that shadowed this cap — a limit chosen for a
 * resource reason (baseline size) silently deciding what dxkit CLAIMS.
 *
 * A binary finding's identity is the check NAME, so it is stable no matter how
 * many findings there are: it grandfathers as one unit and can never slide.
 * Below the ceiling every finding is itemized and grandfathered individually,
 * which is what lets a net-new diagnostic gate while real backlog stays quiet.
 *
 * The ceiling is deliberately far above real brownfield backlogs (a large legacy
 * repo measured ~19k lint findings, ~400 KB of baseline in git — the "balloon
 * the baseline" cost the old cap guarded against was never measured, and is
 * small). It exists only to bound a pathological run; `bounded-exec`'s capture
 * ceiling already bounds the input that feeds it.
 */
const MAX_LOCATED = 50_000;

/**
 * Parse a regex `pattern` (with named `file` / `line` / `rule` / `message`
 * groups) over `output`, one finding per matching line. `file` is required for a
 * match to count. Dedupes identical (file, line, rule) within one run.
 * A malformed pattern yields a single binary finding flagging the misconfig
 * (never crashes the gate).
 *
 * Returns EVERY match — a repo's whole lint backlog is itemized so the baseline
 * can grandfather it finding-by-finding, which is what lets a net-new diagnostic
 * gate while thousands of pre-existing ones stay quiet. Only a pathological run
 * (> `MAX_LOCATED`) collapses to a binary finding; it never returns a truncated
 * PREFIX, because a content-dependent prefix makes identity slide.
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
  }

  // Pathological run: collapse to ONE binary finding rather than itemize a
  // content-dependent PREFIX of the list. Truncating here would make identity
  // slide (see MAX_LOCATED). The whole check still gates, on a stable identity.
  if (located.length > MAX_LOCATED) {
    return [
      binaryFinding(
        check,
        blocking,
        `custom-check '${check}': ${located.length} findings, above the ${MAX_LOCATED} itemization ceiling — gating as a whole check rather than per finding.`,
      ),
    ];
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
