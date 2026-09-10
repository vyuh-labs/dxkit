/**
 * What the task's STANDING PR currently holds: the ONE reader (Rule 2.30)
 * of the open PR on `dxkit/remediate-<task>` and the ledger outcome its
 * body records. Two consumers, one parse:
 *
 *   - resume (`resume.ts`) asks "may the next run continue from it?";
 *   - the lander (`land.ts`) asks "may this run REPLACE it?" (#372: a
 *     guardrail-red salvage force-pushed over a verified, reviewed partial
 *     landing because the landing side never read what the branch held).
 *
 * The outcome is extracted from the PR body, which is the run ledger
 * verbatim (the lane PR-body assembler never paraphrases it), anchored to
 * the ledger's own emitted line shapes. Leaf module by design: nothing here
 * imports from the lander or the resume seam, so both can import it.
 */
import type { Exec } from '../land-refresh';

/** The open standing PR and the ledger facts read from its body. */
export interface StandingPrState {
  readonly url: string;
  /** The ledger's outcome word (`verified`, `guardrail-red`, ...), or
   *  undefined when the body carries no ledger outcome line. */
  readonly outcome?: string;
  /** The ledger's "Blocking findings" list, bounded (a guardrail-red
   *  salvage's record of WHY it was blocked). */
  readonly blockingContext?: string;
}

/** Extract the ledger's outcome word from a PR body. Anchored to the
 *  ledger's own emitted line shapes (the runner's `Task: **<task>** ...
 *  outcome: **<word>**` header, or the executor's bare `outcome: **<word>**`
 *  refusal line), never a prose mention of the word elsewhere in the body.
 *  Undefined when no ledger outcome line exists. */
export function extractLedgerOutcome(body: string | undefined): string | undefined {
  if (!body) return undefined;
  return (
    body.match(/^Task: \*\*[^\n]*outcome: \*\*([a-z-]+)\*\*/m)?.[1] ??
    body.match(/^outcome: \*\*([a-z-]+)\*\*/m)?.[1]
  );
}

/** Extract the ledger's "Blocking findings" list from a PR body, bounded:
 *  the durable record of WHY the prior attempt was blocked. */
export function extractBlockingContext(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const idx = body.indexOf('Blocking findings:');
  if (idx === -1) return undefined;
  const section = body
    .slice(idx)
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().startsWith('- '));
  if (section.length === 0) return undefined;
  return section.join('\n').slice(0, 1500);
}

/**
 * Read the OPEN PR for a standing branch, with the ledger facts its body
 * records. Null when no open PR exists (a merged or closed one means the
 * work was decided on). THROWS when gh itself fails: each consumer owns
 * its fail-open policy and discloses it in its own words (resume: "resume
 * unavailable, fresh run"; the lander: "could not read the standing PR,
 * rebuilding as before"), so a silent "no PR" can never stand in for an
 * unreadable one.
 */
export function readOpenStandingPr(exec: Exec, branch: string): StandingPrState | null {
  const prJson = exec('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'url,body',
  ]);
  const open = JSON.parse(prJson || '[]') as Array<{ url?: string; body?: string }>;
  if (!Array.isArray(open) || open.length === 0) return null;
  const first = open[0] ?? {};
  const outcome = extractLedgerOutcome(first.body);
  const blockingContext = extractBlockingContext(first.body);
  return {
    url: first.url ?? '',
    ...(outcome !== undefined ? { outcome } : {}),
    ...(blockingContext !== undefined ? { blockingContext } : {}),
  };
}
