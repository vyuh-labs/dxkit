/**
 * Inline allowlist annotations.
 *
 * Grammar:
 *
 *   <lineComment> dxkit-allow:<category> reason="<text>"
 *
 * Examples:
 *
 *   # dxkit-allow:test-fixture reason="placeholder in unit test"
 *   // dxkit-allow:false-positive reason="regex matches our intentional placeholder"
 *
 * Two positions:
 *
 *   - **Same-line** — annotation appears on the same source line as
 *     the finding, separated by at least one space:
 *
 *       api_key = "sk_test_xxxx"  # dxkit-allow:test-fixture reason="..."
 *
 *   - **Above-line** — annotation occupies its own line, immediately
 *     preceding the finding (matching its indentation):
 *
 *       # dxkit-allow:test-fixture reason="..."
 *       api_key = "sk_test_xxxx"
 *
 * The position is chosen at insert time by `insertAnnotation`: short
 * source lines (under the configurable threshold) get same-line
 * annotation; longer lines get above-line so the result stays
 * readable.
 *
 * The grammar applies uniformly across every language; only the
 * `<lineComment>` token varies (`#` for python/ruby, `//` for
 * typescript/go/rust/csharp/kotlin/java). Each language pack
 * declares its token via `LanguageSupport.commentSyntax`.
 *
 * # Quoting + escaping
 *
 * The reason is a JSON-style string. To embed a literal `"`, escape
 * as `\"`; to embed a literal `\`, escape as `\\`. The parser
 * un-escapes both on read; the writer escapes both on insert. No
 * other escape sequences are supported (no `\n`, `\t`, etc.) — keep
 * the reason single-line for human review.
 */

import * as fs from 'fs';
import type { LanguageSupport } from '../languages/types';
import { ALL_CATEGORIES, INLINE_COMPATIBLE_CATEGORIES, type AllowlistCategory } from './categories';

export interface InlineAnnotation {
  readonly category: AllowlistCategory;
  /** Free-form rationale. `undefined` when the annotation is
   *  syntactically valid but the `reason="..."` clause was omitted —
   *  callers typically treat this as a "malformed annotation"
   *  warning. */
  readonly reason?: string;
}

export interface AnnotationMatch {
  readonly annotation: InlineAnnotation;
  readonly position: 'same-line' | 'above';
  /** 1-indexed line where the annotation comment LIVES (not the
   *  finding's line — though they're the same for `same-line`). */
  readonly annotationLine: number;
}

export interface InsertOptions {
  /**
   * Maximum source-line length that still gets a same-line annotation.
   * Longer lines get above-line annotation to keep the result
   * readable. The annotation itself is typically 50-80 characters,
   * so totaling source + annotation around 120-140 characters at
   * this threshold.
   */
  readonly sameLineThreshold?: number;
}

const DEFAULT_SAME_LINE_THRESHOLD = 60;

/**
 * Build the annotation comment body (no leading whitespace, no
 * comment marker). The caller composes the full comment by
 * prepending the language's `lineComment` token.
 */
function annotationBody(annotation: InlineAnnotation): string {
  let body = `dxkit-allow:${annotation.category}`;
  if (annotation.reason !== undefined) {
    body += ` reason="${escapeReason(annotation.reason)}"`;
  }
  return body;
}

/**
 * Render a complete annotation comment for a given language.
 * Exposed so callers (the CLI, the block-time hint formatter) can
 * surface the exact string a developer would paste, without going
 * through the file-mutation path.
 */
export function renderAnnotation(annotation: InlineAnnotation, lang: LanguageSupport): string {
  const marker = lang.commentSyntax?.lineComment;
  if (!marker) {
    throw new Error(
      `language ${lang.id} has no commentSyntax.lineComment; inline annotations unsupported`,
    );
  }
  return `${marker} ${annotationBody(annotation)}`;
}

/**
 * Parse a single line for an allowlist annotation. Returns `null`
 * when no annotation marker is found OR when the category isn't
 * one of the canonical values.
 *
 * Tolerates the `reason="..."` clause being absent — callers decide
 * whether a missing reason invalidates the suppression.
 *
 * False-positive surface: a string literal containing the literal
 * substring `<lineComment> dxkit-allow:<category>` would match.
 * Discriminating "is this inside a string" requires real language
 * parsing and isn't worth the complexity — the worst case is a
 * legitimate finding gets suppressed when a developer wrote the
 * grammar literally inside a string. Vanishingly rare in practice.
 */
export function parseAnnotation(line: string, lang: LanguageSupport): InlineAnnotation | null {
  const marker = lang.commentSyntax?.lineComment;
  if (!marker) return null;

  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The annotation prefix may appear at the start of the line
  // (above-line case) or after at least one whitespace following
  // the source code (same-line case). Trailing whitespace after the
  // prefix is tolerated.
  const re = new RegExp(
    `(?:^|\\s)${escaped}\\s*dxkit-allow:(\\S+?)(?:\\s+reason="((?:[^"\\\\]|\\\\.)*)")?(?:\\s|$)`,
  );
  const match = re.exec(line);
  if (!match) return null;

  const category = match[1];
  if (!isCanonicalCategory(category)) return null;

  const reasonRaw = match[2];
  return {
    category: category as AllowlistCategory,
    reason: reasonRaw !== undefined ? unescapeReason(reasonRaw) : undefined,
  };
}

/**
 * Look for an annotation matching a finding at `filePath:lineNumber`
 * (1-indexed). Checks two positions:
 *
 *   1. Same-line: the finding's line itself carries the annotation.
 *   2. Above-line: the immediately-preceding line is a standalone
 *      annotation comment.
 *
 * Returns `null` when neither position has a parseable annotation.
 * Throws when the file doesn't exist or `lineNumber` is out of
 * range — callers are typically operating on findings whose line
 * numbers came from a fresh scan, so an out-of-range value
 * indicates a bug worth surfacing.
 */
export function findAnnotationAt(
  filePath: string,
  lineNumber: number,
  lang: LanguageSupport,
): AnnotationMatch | null {
  if (lineNumber < 1) {
    throw new Error(`lineNumber must be >= 1, got ${lineNumber}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  if (lineNumber > lines.length) {
    throw new Error(`lineNumber ${lineNumber} exceeds file length ${lines.length} (${filePath})`);
  }

  // 1. Same-line check
  const targetLine = lines[lineNumber - 1];
  const sameLine = parseAnnotation(targetLine, lang);
  if (sameLine) {
    return { annotation: sameLine, position: 'same-line', annotationLine: lineNumber };
  }

  // 2. Above-line check — only when a previous line exists
  if (lineNumber > 1) {
    const prev = lines[lineNumber - 2];
    if (isStandaloneAnnotationLine(prev, lang)) {
      const above = parseAnnotation(prev, lang);
      if (above) {
        return { annotation: above, position: 'above', annotationLine: lineNumber - 1 };
      }
    }
  }

  return null;
}

/**
 * Insert an allowlist annotation at `filePath:lineNumber`. Chooses
 * same-line vs above-line based on the target line's length:
 *
 *   - Target shorter than `sameLineThreshold` → append to target.
 *   - Target longer than threshold → prepend a new comment line
 *     above target, copying its indentation.
 *
 * Returns the chosen position + the 1-indexed line where the
 * annotation comment ended up (useful for the CLI to print "added
 * at file:line").
 *
 * Refuses to insert when the category is not inline-compatible —
 * the caller should route accepted-risk + deferred suppressions
 * through the file-level allowlist instead.
 *
 * Preserves CRLF vs LF line endings: the file is read, split, and
 * re-joined using the detected style. Files without a trailing
 * newline keep that property.
 */
export function insertAnnotation(
  filePath: string,
  lineNumber: number,
  annotation: InlineAnnotation,
  lang: LanguageSupport,
  options: InsertOptions = {},
): { position: 'same-line' | 'above'; annotationLine: number } {
  if (!INLINE_COMPATIBLE_CATEGORIES.has(annotation.category)) {
    throw new Error(
      `category ${JSON.stringify(annotation.category)} is file-only — ` +
        `use the file-level allowlist via 'vyuh-dxkit allowlist add'`,
    );
  }
  const marker = lang.commentSyntax?.lineComment;
  if (!marker) {
    throw new Error(
      `language ${lang.id} has no commentSyntax.lineComment; cannot render inline annotation`,
    );
  }
  if (lineNumber < 1) {
    throw new Error(`lineNumber must be >= 1, got ${lineNumber}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith(eol);
  const lines = raw.split(/\r?\n/);
  // `split('\n')` on a trailing newline produces an empty final
  // element; track and preserve it.
  if (hadTrailingNewline && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lineNumber > lines.length) {
    throw new Error(`lineNumber ${lineNumber} exceeds file length ${lines.length} (${filePath})`);
  }

  const threshold = options.sameLineThreshold ?? DEFAULT_SAME_LINE_THRESHOLD;
  const targetLine = lines[lineNumber - 1];
  const commentText = `${marker} ${annotationBody(annotation)}`;

  let position: 'same-line' | 'above';
  let resultLine: number;
  if (targetLine.length < threshold) {
    // Same-line: append with two-space separator
    lines[lineNumber - 1] = `${targetLine}  ${commentText}`;
    position = 'same-line';
    resultLine = lineNumber;
  } else {
    // Above-line: insert a new line BEFORE target with matching indent
    const indent = (targetLine.match(/^[\t ]*/) ?? [''])[0];
    lines.splice(lineNumber - 1, 0, `${indent}${commentText}`);
    position = 'above';
    resultLine = lineNumber;
  }

  const out = lines.join(eol) + (hadTrailingNewline ? eol : '');
  fs.writeFileSync(filePath, out, 'utf8');
  return { position, annotationLine: resultLine };
}

// ─── Internals ───────────────────────────────────────────────────────────

function isCanonicalCategory(category: string): boolean {
  return (ALL_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Whether a line is a "standalone annotation comment" — meaning it
 * contains nothing but leading whitespace + the comment marker +
 * the annotation body. Used to distinguish an above-line annotation
 * from a same-line annotation on a different finding's line.
 *
 * Example (python):
 *   `    # dxkit-allow:test-fixture reason="..."`   ← standalone
 *   `x = 1  # dxkit-allow:test-fixture reason="..."`  ← NOT standalone
 */
function isStandaloneAnnotationLine(line: string, lang: LanguageSupport): boolean {
  const marker = lang.commentSyntax?.lineComment;
  if (!marker) return false;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*dxkit-allow:`);
  return re.test(line);
}

function escapeReason(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeReason(text: string): string {
  // Process left-to-right: each `\<x>` collapses to `<x>`.
  return text.replace(/\\(.)/g, '$1');
}
