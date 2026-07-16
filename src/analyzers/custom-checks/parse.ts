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

import * as path from 'path';
import type { RawLocatedFinding } from '../../languages/capabilities/lint-gate';
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
 *
 * This is a VALIDATING boundary, not a passthrough: whatever shape a linter
 * prints, every finding that leaves here satisfies the post-condition `file` is
 * a repo-relative POSIX path (relative to `cwd`) — see `toRepoRelativePosix`.
 */
export function parseLocated(
  check: string,
  blocking: boolean,
  pattern: string,
  output: string,
  cwd: string,
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

  const raw: RawLocatedFinding[] = [];
  for (const line of output.split('\n')) {
    const groups = re.exec(line)?.groups;
    if (!groups || groups.file === undefined) continue;
    const lineNo = groups.line !== undefined ? parseIntSafe(groups.line) : undefined;
    raw.push({
      file: groups.file,
      ...(lineNo !== undefined ? { line: lineNo } : {}),
      ...(groups.rule !== undefined ? { rule: groups.rule } : {}),
      message: groups.message?.trim() || line.trim(),
    });
  }
  return validateLocated(check, blocking, raw, cwd);
}

/**
 * Turn a pack parser's output over the tool's native machine-readable format
 * into located findings, through the SAME validating boundary as the regex
 * path (one post-condition, two producers — Rule 2.30). A parser throw is a
 * check misconfiguration, reported as one binary finding, never a crash: the
 * output it choked on is untrusted linter output, and a gate must degrade,
 * not take the guardrail down.
 */
export function parseStructuredLocated(
  check: string,
  blocking: boolean,
  parse: (output: string) => readonly RawLocatedFinding[],
  output: string,
  cwd: string,
): CustomCheckFinding[] {
  let raw: readonly RawLocatedFinding[];
  try {
    raw = parse(output);
  } catch {
    return [
      binaryFinding(
        check,
        blocking,
        `custom-check '${check}': structured output parse failed — reporting as a whole-command failure.`,
      ),
    ];
  }
  return validateLocated(check, blocking, raw, cwd);
}

/**
 * The one validating boundary both parse modes exit through: enforce the
 * repo-relative-POSIX `file` post-condition, sanitize line/rule/message,
 * dedupe identical (file, line, rule), and apply the itemization ceiling.
 */
function validateLocated(
  check: string,
  blocking: boolean,
  raw: readonly RawLocatedFinding[],
  cwd: string,
): CustomCheckFinding[] {
  const located: CustomCheckFinding[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry?.file !== 'string' || entry.file.trim() === '') continue;
    const file = toRepoRelativePosix(entry.file.trim(), cwd);
    if (!file) continue;
    const lineNo =
      typeof entry.line === 'number' && Number.isFinite(entry.line) && entry.line > 0
        ? Math.floor(entry.line)
        : undefined;
    const rule = typeof entry.rule === 'string' ? entry.rule.trim() || undefined : undefined;
    const message =
      typeof entry.message === 'string' ? entry.message.trim() || undefined : undefined;
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

/**
 * Enforce the located-finding path post-condition: `file` is a repo-relative
 * POSIX path — the same contract the frozen SDK wire format states for
 * extension findings (`WireFinding.file`: "Repo-relative POSIX path"). dxkit
 * must hold its own parsers to the standard it holds third parties to.
 *
 * Identity-load-bearing, not cosmetic: `file` feeds the finding's fingerprint
 * (Rule 9), and an identity input must be reproducible from one environment to
 * the next. Several linters print ABSOLUTE paths (ktlint, MSBuild via
 * `dotnet build`, rubocop's emacs formatter), so without this the identity
 * embeds the checkout directory and none of those findings survive a
 * checkout-path change — the whole grandfathered backlog false-blocks in CI
 * (proven: 0 of 453 ktlint identities survived a two-path A/B on one machine).
 * The packs whose linters happen to print relative paths were safe by their
 * linters' convention, not by design; this boundary makes it design. Sibling
 * parsers already relativize (`parseCoberturaXml`, `normalizeCommandForRecall`)
 * — this closes the one consumer that didn't (CLAUDE.md 2.30: one concept, a
 * divergent sibling, no shared token for grep to find).
 *
 * A path OUTSIDE the repo is left verbatim: it cannot be expressed
 * repo-relative, and a `../..` rewrite would embed the layout above the repo —
 * the same bug wearing a relative disguise.
 */
function toRepoRelativePosix(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return normalizeSeparators(file);
  const rel = path.relative(cwd, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return normalizeSeparators(rel);
}

/** POSIX separators in the output path. Only rewrites `\` when it IS the host
 *  separator (win32) — on POSIX a backslash is a legal filename character. */
function normalizeSeparators(p: string): string {
  return path.sep === '\\' ? p.replaceAll('\\', '/') : p;
}
