/**
 * The ONE PR-body size guard (#374). GitHub caps a pull request body at
 * 65,536 bytes; a body over it makes `gh pr create` fail outright and
 * `gh pr edit --body` fail or truncate. The live class: a 698-order
 * remediation ledger rendered one line per order (688,909 bytes) was handed
 * to `gh pr create` as the body, the create failed, the branch existed with
 * no PR, and the lane reported success.
 *
 * Two layers close it. The remediate ledger renderer collapses what does
 * not belong in a body (the SUMMARY: counts instead of one line per kept
 * recipe order; every line lives in the committed ledger file). This module
 * is the HARD guard beneath it, applied at the one place a body reaches
 * `gh` (`openOrUpdateStandingPr`, both `create` and `edit`), so no lane and
 * no renderer can hand GitHub an oversized body: the body is measured in
 * UTF-8 BYTES (the unit GitHub counts, not characters) against the cap
 * minus a safety margin, and when it still exceeds the budget the largest
 * markdown section is cut from its tail with an explicit marker naming
 * where the full record lives. A body is NEVER rejected for size.
 */

/** GitHub's documented pull request body limit, in bytes. */
export const PR_BODY_MAX_BYTES = 65_536;

/** Headroom under the cap: the remediate lander prefixes an attempt PR's
 *  body with the preserved-standing-branch disclosure (a few hundred
 *  bytes), and a margin keeps a body capped here from landing exactly on
 *  the limit after any such framing. */
export const PR_BODY_SAFETY_MARGIN_BYTES = 4_096;

/** The byte budget a rendered body must fit in. */
export const PR_BODY_BUDGET_BYTES = PR_BODY_MAX_BYTES - PR_BODY_SAFETY_MARGIN_BYTES;

/** The one byte measure (GitHub counts bytes; `String.length` counts UTF-16
 *  code units, which under-reads any multi-byte character). */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface PrBodyTruncation {
  /** The heading of the section that was cut (or `(preamble)`). */
  readonly section: string;
  /** Lines dropped from that section's tail. */
  readonly droppedLines: number;
}

export interface CappedPrBody {
  readonly body: string;
  /** Present exactly when the input exceeded the budget: what was cut,
   *  for the caller's disclosure. Absent = the body is byte-identical to
   *  the input. */
  readonly truncated?: readonly PrBodyTruncation[];
}

interface Section {
  readonly heading: string;
  lines: string[];
}

const HEADING_RE = /^#{1,6}\s/;

/** The marker line that stands in for cut content, naming where the whole
 *  record is. Rendered as emphasis so it reads as the renderer's note, not
 *  as one of the ledger's own lines. */
function marker(dropped: number, fullRecord: string): string {
  return `_… ${dropped} more line${dropped === 1 ? '' : 's'} omitted here (GitHub caps a PR body at ${PR_BODY_MAX_BYTES} bytes); the full record is ${fullRecord}._`;
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [{ heading: '(preamble)', lines: [] }];
  for (const line of body.split('\n')) {
    if (HEADING_RE.test(line)) {
      sections.push({ heading: line, lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

function joinSections(sections: readonly Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading !== '(preamble)') out.push(s.heading);
    out.push(...s.lines);
  }
  return out.join('\n');
}

/**
 * Cap a body to the budget. `fullRecord` names where the uncut record
 * lives (the committed ledger file for the remediate lane, the job step
 * summary otherwise) so every marker points a reader at it.
 *
 * Deterministic: the largest section (by bytes) loses lines from its tail
 * until the whole body fits, then the next largest, bounded by the number
 * of sections. A body whose one remaining line is itself over budget is
 * cut by bytes at a character boundary, so the guarantee holds for any
 * input.
 */
export function capPrBody(body: string, opts: { readonly fullRecord: string }): CappedPrBody {
  if (utf8Bytes(body) <= PR_BODY_BUDGET_BYTES) return { body };
  const sections = splitSections(body);
  const truncated: PrBodyTruncation[] = [];
  const cut = new Set<Section>();
  for (let round = 0; round < sections.length; round += 1) {
    let current = joinSections(sections);
    let over = utf8Bytes(current) - PR_BODY_BUDGET_BYTES;
    if (over <= 0) break;
    // The largest section not yet cut carries the most removable bytes.
    const target = sections
      .filter((s) => !cut.has(s) && s.lines.length > 0)
      .sort((a, b) => utf8Bytes(b.lines.join('\n')) - utf8Bytes(a.lines.join('\n')))[0];
    if (!target) break;
    cut.add(target);
    let dropped = 0;
    // Reserve the marker's own bytes (an upper bound: the count only grows
    // by digits as more lines drop, which the loop re-measures anyway).
    const reserve = utf8Bytes(marker(target.lines.length, opts.fullRecord)) + 1;
    while (target.lines.length > 0 && over + reserve > 0) {
      const removed = target.lines.pop() as string;
      dropped += 1;
      over -= utf8Bytes(removed) + 1; // the newline it carried
    }
    if (dropped > 0) {
      target.lines.push(marker(dropped, opts.fullRecord));
      truncated.push({ section: target.heading, droppedLines: dropped });
    }
    current = joinSections(sections);
    if (utf8Bytes(current) <= PR_BODY_BUDGET_BYTES) break;
  }
  let result = joinSections(sections);
  if (utf8Bytes(result) > PR_BODY_BUDGET_BYTES) {
    // Every section is cut and the remainder (headings plus single
    // oversized lines) still does not fit: the last-resort byte cut.
    const tail = marker(1, opts.fullRecord);
    const keep = PR_BODY_BUDGET_BYTES - utf8Bytes(tail) - 1;
    let head = Buffer.from(result, 'utf8').subarray(0, Math.max(0, keep)).toString('utf8');
    // A byte cut can split a multi-byte character; the decoder replaces it
    // with U+FFFD, which is dropped so the body ends on real content.
    head = head.replace(/�+$/u, '');
    result = `${head}\n${tail}`;
    truncated.push({ section: '(body)', droppedLines: 1 });
  }
  return { body: result, truncated };
}

/** The one phrasing of a truncation, for every surface that discloses it. */
export function describePrBodyTruncation(truncated: readonly PrBodyTruncation[]): string {
  const parts = truncated.map(
    (t) =>
      `${t.droppedLines} line${t.droppedLines === 1 ? '' : 's'} from ${
        t.section === '(preamble)' || t.section === '(body)'
          ? 'the body'
          : `'${t.section.replace(/^#+\s*/, '')}'`
      }`,
  );
  return (
    `the PR body exceeded GitHub's ${PR_BODY_MAX_BYTES}-byte cap and was cut to fit ` +
    `(${parts.join('; ')}); each cut is marked in the body and the full record is named there.`
  );
}
