/**
 * Assemble the `vyuh-dxkit pr` output — a ready-to-review PR body computed from
 * the branch's commits, the receipt, the reviewer model, the diff-derived
 * checklist, and the structural-duplicate seam prompts. Pure: takes the already-
 * computed `PrData` and emits markdown (or the JSON projection). The one thing
 * NOT computed is the "What & why" narrative — the author writes that; the
 * command leaves a labelled placeholder so the body is otherwise complete.
 */
import type { ChangeBucket } from './commits';
import type { DuplicateGroup } from '../analyzers/duplication/findings';
import type { ReviewersResult } from '../reviewers-cli';

export interface PrData {
  /** Suggested title (single-commit verbatim, else `type(scope): headline`). */
  readonly title: string;
  /** Changes bucketed by commit type (Features / Fixes / …). */
  readonly buckets: readonly ChangeBucket[];
  /** The receipt markdown block (verdict + allowlist [+ score]) — null when the
   *  receipt could not be produced (no baseline, etc.). */
  readonly receiptMarkdown: string | null;
  /** Ranked reviewer suggestions — null when no changed files / no signal. */
  readonly reviewers: ReviewersResult | null;
  /** Structural-duplicate prompts the diff introduced (verified tier, grouped). */
  readonly seams: readonly DuplicateGroup[];
  /** The diff-derived reviewer-checklist rows. */
  readonly checklist: readonly string[];
  /** The base ref the body was computed against (for provenance). */
  readonly base: string;
}

function anchorLabel(a: { symbol: string; file: string }): string {
  return `\`${a.symbol}\` (${a.file})`;
}

/** One structural-drift prompt per added function: the added function and every
 *  existing function it structurally matches, phrased as a reviewer question. */
function renderSeamPrompts(seams: readonly DuplicateGroup[]): string[] {
  if (seams.length === 0) return [];
  const lines = [
    '## Structural review (dxkit)',
    '',
    `dxkit found ${seams.length} function${seams.length === 1 ? '' : 's'} this change adds or edits ` +
      `that structurally match existing code. Not a block — confirm each parallel is intentional, ` +
      `or consolidate:`,
    '',
  ];
  for (const g of seams) {
    const twins = g.twins
      .map((t) => `${anchorLabel(t.anchor)} (${Math.round(t.score * 100)}% similar)`)
      .join(', ');
    lines.push(`- [ ] ${anchorLabel(g.added)} matches ${twins}`);
  }
  return lines;
}

function renderChanges(buckets: readonly ChangeBucket[]): string[] {
  if (buckets.length === 0) return [];
  const lines = ['## Changes', ''];
  for (const b of buckets) {
    lines.push(`### ${b.label}`);
    for (const c of b.commits) {
      const scope = c.scope ? `**${c.scope}:** ` : '';
      const breaking = c.breaking ? ' ⚠️ breaking' : '';
      lines.push(`- ${scope}${c.subject}${breaking}`);
    }
    lines.push('');
  }
  return lines;
}

function renderReviewers(reviewers: ReviewersResult): string[] {
  const lines = ['## Suggested reviewers', ''];
  if (reviewers.reviewers.length === 0) {
    lines.push(
      reviewers.note ? `_${reviewers.note}_` : '_No active-owner signal for the touched files._',
    );
    return lines;
  }
  for (const r of reviewers.reviewers) {
    const who = r.handle ? `@${r.handle}` : r.name;
    const tag = r.isCodeowner ? ' [CODEOWNERS]' : '';
    lines.push(`- ${who}${tag} — ${r.reason}`);
  }
  if (reviewers.busFactor === 1) {
    lines.push(
      '',
      '_Bus factor 1: a single active owner covers these files — consider spreading knowledge._',
    );
  }
  if (reviewers.note) lines.push('', `_${reviewers.note}_`);
  return lines;
}

/** Render the full PR body as markdown. */
export function renderPrBody(data: PrData): string {
  const parts: string[] = [];
  parts.push(`# ${data.title || '<title>'}`, '');
  parts.push(
    '## What & why',
    '',
    '<!-- Describe the problem this solves and the approach, in 1–3 sentences. -->',
    '',
  );

  parts.push(...renderChanges(data.buckets));

  if (data.receiptMarkdown) {
    parts.push('## dxkit signals', '', data.receiptMarkdown.trimEnd(), '');
  }

  if (data.reviewers) parts.push(...renderReviewers(data.reviewers), '');

  const seamLines = renderSeamPrompts(data.seams);
  if (seamLines.length > 0) parts.push(...seamLines, '');

  parts.push('## Reviewer checklist', '');
  for (const row of data.checklist) parts.push(`- [ ] ${row}`);

  parts.push('', `<!-- dxkit pr: computed against \`${data.base}\` -->`);
  return parts.join('\n');
}

/** The JSON projection — every computed field, for programmatic consumers. */
export function renderPrJson(data: PrData): unknown {
  return {
    schema: 'pr.v1',
    base: data.base,
    title: data.title,
    changes: data.buckets.map((b) => ({
      bucket: b.label,
      commits: b.commits.map((c) => ({
        type: c.type,
        ...(c.scope ? { scope: c.scope } : {}),
        subject: c.subject,
        breaking: c.breaking,
      })),
    })),
    reviewers: data.reviewers
      ? {
          suggestions: data.reviewers.reviewers.map((r) => ({
            name: r.name,
            ...(r.handle ? { handle: r.handle } : {}),
            isCodeowner: r.isCodeowner,
            reason: r.reason,
          })),
          busFactor: data.reviewers.busFactor,
          ...(data.reviewers.note ? { note: data.reviewers.note } : {}),
        }
      : null,
    structuralDuplicates: data.seams.map((g) => ({
      added: { symbol: g.added.symbol, file: g.added.file },
      topScore: g.topScore,
      twins: g.twins.map((t) => ({
        symbol: t.anchor.symbol,
        file: t.anchor.file,
        score: t.score,
        id: t.id,
      })),
    })),
    checklist: data.checklist,
    markdown: renderPrBody(data),
  };
}
