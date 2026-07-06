/**
 * Turn one failing check's captured output into findings.
 *
 * Pure module — no I/O. The runner has already decided the check FAILED (exit
 * code ≠ expectedExit); this only decides the finding GRANULARITY:
 *   - `exit` mode → one binary finding for the whole check.
 *   - `regex` mode → one located finding per matching output line, with a
 *     binary fallback if the pattern matched nothing (a failing check must never
 *     yield zero findings, or its failure would be invisible to the gate).
 */

import type { CustomCheckFinding, CustomCheckParse } from './types';

/** Cap on located findings per check — a catastrophic run (thousands of lint
 *  errors) shouldn't balloon the baseline. Beyond this we keep the first N
 *  located findings PLUS a binary catch-all so the overflow still gates. */
const MAX_LOCATED = 500;

/**
 * Extract findings from a failed check's output.
 *
 * `blocking` is threaded onto every finding (the check's declared block intent).
 * `outputTail` is the captured stdout+stderr tail (already length-bounded by the
 * exec primitive); it becomes a binary finding's `message` and is scanned line
 * by line in regex mode.
 */
export function extractFindings(
  check: string,
  blocking: boolean,
  parse: CustomCheckParse,
  outputTail: string,
): CustomCheckFinding[] {
  if (parse.mode === 'exit') {
    return [binaryFinding(check, blocking, outputTail)];
  }

  let re: RegExp;
  try {
    // `g` so we can pull every match; the pattern itself carries the anchors.
    re = new RegExp(parse.pattern, 'g');
  } catch {
    // A malformed pattern must not crash the gate — fall back to a binary
    // finding so the failure still registers, and surface the misconfig.
    return [
      binaryFinding(
        check,
        blocking,
        `custom-check '${check}': invalid parse regex — reporting as a whole-command failure.\n${outputTail}`,
      ),
    ];
  }

  const located: CustomCheckFinding[] = [];
  const seen = new Set<string>();
  for (const line of outputTail.split('\n')) {
    re.lastIndex = 0;
    const m = re.exec(line);
    const groups = m?.groups;
    if (!groups || groups.file === undefined) continue;
    const file = groups.file.trim();
    if (!file) continue;
    const lineNo = groups.line !== undefined ? parseIntSafe(groups.line) : undefined;
    const rule = groups.rule?.trim() || undefined;
    const message = groups.message?.trim() || line.trim() || undefined;
    // Dedupe identical (file, line, rule) within one run — a linter that prints
    // the same diagnostic twice shouldn't mint two entries; the matcher's
    // multiset pass would otherwise treat the second as net-new.
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
    if (located.length >= MAX_LOCATED) break;
  }

  if (located.length === 0) {
    // The check failed but nothing parsed — don't lose the signal. One binary
    // finding keeps the failure visible to the gate.
    return [binaryFinding(check, blocking, outputTail)];
  }
  if (located.length >= MAX_LOCATED) {
    located.push(
      binaryFinding(
        check,
        blocking,
        `custom-check '${check}': more than ${MAX_LOCATED} findings — only the first ${MAX_LOCATED} are itemized; this catch-all gates the overflow.`,
      ),
    );
  }
  return located;
}

function binaryFinding(check: string, blocking: boolean, outputTail: string): CustomCheckFinding {
  const message = outputTail.trim() || undefined;
  return { check, blocking, ...(message !== undefined ? { message } : {}) };
}

/** Parse a line number, tolerating a linter that emits `12` or `12:` etc.
 *  Returns undefined for a non-numeric capture (the finding stays file-only). */
function parseIntSafe(s: string): number | undefined {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
