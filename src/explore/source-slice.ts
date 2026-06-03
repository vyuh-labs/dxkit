/**
 * Pure source-slicing for `vyuh-dxkit context <file:line>`. The graph
 * carries declaration lines but no source text, so the CLI reads the
 * file from disk and hands the raw text here to carve out a focused,
 * budget-bounded chunk centered on the requested line.
 *
 * This module is deliberately fs-free: it takes the already-read file
 * text + a span and returns the slice, so the windowing math is
 * unit-testable without touching the filesystem. The CLI layer
 * (`cli/context.ts`) owns the `readFileSync`.
 *
 * The window is CENTERED on the requested line, not anchored to the
 * span's top. That matters: a 700-line symbol whose budget only fits
 * 60 lines must still show the line the caller asked about — anchoring
 * to the declaration could fill the budget before ever reaching it.
 */

/** Default chars-per-token estimate for the budget→chars conversion. */
const CHARS_PER_TOKEN = 4;

export interface ExtractOpts {
  /** Soft token ceiling on the rendered chunk. */
  budgetTokens: number;
  /** 1-based inclusive line the chunk may start at (defaults to 1). */
  spanStart?: number;
  /** 1-based EXCLUSIVE line the chunk must stop before (defaults to EOF+1). */
  spanEndExclusive?: number;
  /** Override the chars-per-token estimate (tests / tuning). */
  charsPerToken?: number;
}

export interface SourceChunk {
  /** First line shown (1-based, inclusive). */
  startLine: number;
  /** Last line shown (1-based, inclusive). */
  endLine: number;
  /** The raw source lines shown, in order — no line-number prefix. */
  lines: string[];
  /** Span the chunk was drawn from (symbol body or whole file), 1-based inclusive. */
  spanStart: number;
  spanEnd: number;
  /** Total lines in the span. */
  spanLines: number;
  /** True when the budget forced us to show only part of the span. */
  truncated: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Carve a budget-bounded window out of `fileText`, centered on
 * `targetLine`, clamped to `[spanStart, spanEndExclusive)`. Always
 * returns at least the target line itself (even when that single line
 * already exceeds the budget) so the caller never gets an empty chunk
 * for a valid location. `truncated` is true iff the returned window is
 * a strict subset of the span (budget cut it short).
 */
export function extractWindow(
  fileText: string,
  targetLine: number,
  opts: ExtractOpts,
): SourceChunk {
  const all = fileText.split('\n');
  const total = Math.max(1, all.length);
  const charsPerToken = opts.charsPerToken ?? CHARS_PER_TOKEN;

  const spanStart = clamp(opts.spanStart ?? 1, 1, total);
  const spanEnd = clamp((opts.spanEndExclusive ?? total + 1) - 1, spanStart, total);
  const spanLines = spanEnd - spanStart + 1;

  const target = clamp(targetLine, spanStart, spanEnd);
  const budgetChars = Math.max(1, opts.budgetTokens) * charsPerToken;

  // +1 per line approximates the stripped newline so the char budget
  // tracks the rendered size rather than the raw slice length.
  const lineLen = (oneBased: number): number => (all[oneBased - 1]?.length ?? 0) + 1;

  let lo = target;
  let hi = target;
  let used = lineLen(target);

  // Alternate expansion (down first, then up) so the window stays
  // roughly symmetric around the target. Stop when neither neighbor
  // fits the remaining budget — lines only grow the total, so once
  // both immediate neighbors overflow, nothing further can fit.
  let preferDown = true;
  while (true) {
    const canDown = hi < spanEnd;
    const canUp = lo > spanStart;
    if (!canDown && !canUp) break;

    const tryOrder: Array<'down' | 'up'> = preferDown ? ['down', 'up'] : ['up', 'down'];
    let advanced = false;
    for (const dir of tryOrder) {
      if (dir === 'down' && canDown && used + lineLen(hi + 1) <= budgetChars) {
        hi++;
        used += lineLen(hi);
        advanced = true;
        break;
      }
      if (dir === 'up' && canUp && used + lineLen(lo - 1) <= budgetChars) {
        lo--;
        used += lineLen(lo);
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
    preferDown = !preferDown;
  }

  return {
    startLine: lo,
    endLine: hi,
    lines: all.slice(lo - 1, hi),
    spanStart,
    spanEnd,
    spanLines,
    truncated: lo > spanStart || hi < spanEnd,
  };
}
