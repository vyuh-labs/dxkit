/**
 * Inline allowlist annotation gather pass.
 *
 * Walks the source tree looking for `<lineComment> dxkit-allow:<category>`
 * comments and records each occurrence as a `(file, line, category)`
 * tuple. The `stale-allow` producer uses this list together with the
 * current scan's secret/code/config findings to detect orphaned
 * annotations — annotations whose underlying finding is no longer
 * present, which the developer should remove.
 *
 * Architectural posture:
 *
 *   - File walk goes through the canonical `walkSourceFiles` helper
 *     so `.gitignore` + `.dxkit-ignore` + bundled defaults are
 *     honored uniformly. No custom recursion / exclusion logic
 *     (per CLAUDE.md G_v4_7).
 *   - Per-language comment marker comes from each pack's
 *     `LanguageSupport.commentSyntax` via the inline annotation
 *     parser. No hardcoded `'//'` / `'#'` literals in this module
 *     (arch-check rule 2 enforces).
 *   - Annotation parsing reuses `parseAnnotation` from `inline.ts`
 *     — single source of grammar truth.
 *
 * Test files ARE walked (intentional — annotations often live in
 * test fixtures suppressing scanner findings against deliberate
 * placeholder credentials). Auto-generated files are NOT walked
 * (the developer doesn't author annotations in generated code, and
 * `walkSourceFiles` already excludes them by default).
 */

import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES } from '../languages';
import type { LanguageSupport } from '../languages/types';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { isStandaloneAnnotationLine, parseAnnotation, type AnnotationPosition } from './inline';

export interface InlineAllowlistOccurrence {
  /** Project-relative POSIX path. */
  readonly file: string;
  /** 1-based line number where the annotation comment LIVES. For
   *  above-line annotations the value is the line just before the
   *  finding's target; for same-line it's the finding's own line. */
  readonly line: number;
  /** Category named in the annotation (`test-fixture` / `false-positive` /
   *  etc.). Free-form at gather level; the producer cross-checks
   *  against the canonical `AllowlistCategory` union. */
  readonly category: string;
  /** Where the annotation sits relative to the suppressed line. */
  readonly position: AnnotationPosition;
}

export interface GatherInlineOpts {
  /** Walk test files too. Default: true (test fixtures legitimately
   *  carry intentional placeholders + suppressions). */
  readonly includeTests?: boolean;
}

/**
 * Walk source files under `cwd` and collect every inline allowlist
 * annotation occurrence. Cheap on small repos; on large ones the
 * `walkSourceFiles` cache amortizes the cost across multiple gather
 * passes within a single baseline-create run.
 *
 * Returns occurrences in stable order (file path lexicographic, then
 * line ascending) so downstream deterministic-output requirements
 * are satisfied automatically.
 */
export function gatherInlineAllowlistAnnotations(
  cwd: string,
  opts: GatherInlineOpts = {},
): InlineAllowlistOccurrence[] {
  const includeTests = opts.includeTests ?? true;
  const files = walkSourceFiles(cwd, { includeTests });
  const out: InlineAllowlistOccurrence[] = [];

  // Build an extension → language lookup once per call. Cheap; the
  // LANGUAGES registry is small (8 packs today).
  const langByExt = buildLanguageByExtension();

  for (const relPath of files) {
    const ext = path.extname(relPath).toLowerCase();
    const lang = langByExt.get(ext);
    if (!lang || !lang.commentSyntax) continue;

    const abs = path.join(cwd, relPath);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      // File disappeared mid-walk (race) or unreadable — skip.
      continue;
    }
    // Fast path: source has no `dxkit-allow:` substring at all.
    // Avoids per-line regex on the vast majority of files.
    if (!raw.includes('dxkit-allow:')) continue;

    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parsed = parseAnnotation(line, lang);
      if (!parsed) continue;
      // `parseAnnotation` returns the category + reason but not
      // the position. Determine position by inspecting whether the
      // line is standalone (only whitespace + comment marker + body)
      // or has source code preceding the comment.
      const position: AnnotationPosition = isStandaloneAnnotationLine(line, lang)
        ? 'above'
        : 'same-line';
      out.push({
        file: relPath,
        line: i + 1,
        category: parsed.category,
        position,
      });
    }
  }
  return out;
}

// ─── Internals ────────────────────────────────────────────────────────────

function buildLanguageByExtension(): Map<string, LanguageSupport> {
  const map = new Map<string, LanguageSupport>();
  for (const lang of LANGUAGES) {
    for (const ext of lang.sourceExtensions) {
      const lower = ext.toLowerCase();
      // First pack wins on duplicate extensions (none today, but
      // the deterministic-order guarantee survives a future overlap).
      if (!map.has(lower)) map.set(lower, lang);
    }
  }
  return map;
}
