/**
 * Renderer helpers — turn a `ScoreResult`'s structured provenance
 * into markdown the customer can act on.
 *
 * These functions don't know which dimension they're rendering; they
 * read `topActions[]` + `capsApplied[]` from any spec output and
 * produce consistent prose. Per-dimension renderers (the analyzer
 * subdirs) call into here so the "Top Actions" surface looks the
 * same across every dimension's report.
 */

import type { CapApplied, ScoreResult, TopAction } from './result';

/**
 * Subset of `DimensionScore` the formatters need. Lets the health-side
 * `DimensionScore` and any future direct `ScoreResult` consumer share
 * the same renderer without coupling on the full health type.
 */
export interface ScoreResultLike {
  readonly score: number;
  readonly rating: ScoreResult['rating'];
  readonly rawScore?: number;
  readonly rawPenalty?: number;
  readonly capsApplied?: readonly CapApplied[];
  readonly topActions?: readonly TopAction[];
}

/** One-line top-action summary, suitable for table cells / CLI grids. */
export function formatTopActionLine(score: ScoreResultLike): string {
  const top = score.topActions?.[0];
  if (!top) return '';
  const uplift = `+${Math.round(top.upliftIfFixed)}`;
  const transition = top.ratingTransition
    ? ` (${top.ratingTransition.from} → ${top.ratingTransition.to})`
    : '';
  return `${top.reason} ${uplift}${transition}`;
}

/**
 * Markdown block listing the top N actions for a dimension. Returns
 * an empty array (no lines) when the dimension has no actionable
 * items — caller decides whether to suppress the section header in
 * that case.
 */
export function formatTopActionsBlock(score: ScoreResultLike, limit = 5): string[] {
  const actions = (score.topActions ?? []).slice(0, limit);
  const lines: string[] = [];

  // Severe-debt disclosure (closes D129): when the score floors at 0
  // and the raw penalty went past it, say so. Distinguishes
  // "barely bad" from "catastrophic" in the report itself.
  if (score.score === 0 && typeof score.rawScore === 'number' && score.rawScore < 0) {
    lines.push(`> **Severe:** raw penalty ${score.rawScore} (deductions exceed the floor).`);
    lines.push('');
  }

  // Surface the binding cap separately when one fires — it's the
  // bound on the rating, not just one of many penalties.
  if (score.capsApplied && score.capsApplied.length > 0) {
    const cap = score.capsApplied[0];
    lines.push(`> **Rating cap:** ${cap.reason} — bounded at ${cap.ceiling}/100.`);
    lines.push('');
  }

  if (actions.length === 0) return lines;

  lines.push('**Top actions (sorted by score uplift):**');
  lines.push('');
  for (const a of actions) {
    const uplift = `+${Math.round(a.upliftIfFixed)}`;
    const transition = a.ratingTransition
      ? ` — would lift rating ${a.ratingTransition.from} → ${a.ratingTransition.to}`
      : '';
    lines.push(`- ${a.reason} \`${uplift}\`${transition}`);
  }
  lines.push('');
  return lines;
}
