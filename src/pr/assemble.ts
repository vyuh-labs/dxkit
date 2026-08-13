/**
 * The ONE lane PR-body assembler (#288, 4.4.1 WP4).
 *
 * A lane-landed PR's body was the verification ledger alone: strong on
 * proof, silent on content — a reviewer of a several-thousand-line draft
 * had to read the raw diff to learn what was written, while the human
 * flow already had `vyuh-dxkit pr` computing exactly that narrative.
 * Two PR-composition paths, no shared code: the Rule-2.30 setup.
 *
 * This module composes both landers' bodies from the SAME canonical
 * pieces the human `pr` flow uses (`./commits`: parseCommits +
 * bucketCommits — never a second commit parser):
 *
 *   - a diff-scoped NARRATIVE rides on top, clearly labeled as generated
 *     prose about the change (regenerated each time a lander rebuilds
 *     the standing PR, so a reviewer sees what moved since their last
 *     look);
 *   - the lane's LEDGER follows VERBATIM, uncut — the prompt disclosure,
 *     budget/salvage rationale, and verification claims are contractual
 *     and never paraphrased.
 *
 * Fail-open: no commits in range, git unavailable, anything throws → the
 * body is the ledger alone, byte-identical to the pre-#288 output. The
 * narrative is additive, never a gate.
 */

import { execFileSync } from 'child_process';
import { bucketCommits, parseCommits } from './commits';

export interface LaneBodyOptions {
  readonly cwd: string;
  /** The verbatim verification ledger — the contractual section. */
  readonly ledger: string;
  /** The PR's target branch; the narrative describes `base..HEAD`. */
  readonly base: string;
  /** Injectable for tests: replaces the git-derived narrative. Return
   *  null to exercise the ledger-only path. */
  readonly narrative?: (cwd: string, base: string) => string | null;
}

/** The label the narrative section always carries — a reviewer must never
 *  mistake generated prose for the lane's contractual claims. */
const NARRATIVE_HEADER = '## What changed (generated)';

export function assembleLanePrBody(opts: LaneBodyOptions): string {
  let narrative: string | null = null;
  try {
    narrative = (opts.narrative ?? buildLaneNarrative)(opts.cwd, opts.base);
  } catch {
    narrative = null; // additive, never a gate
  }
  if (!narrative || narrative.trim() === '') return opts.ledger;
  return [
    NARRATIVE_HEADER,
    '',
    '_Diff-scoped summary computed by dxkit from the branch commits and files.',
    'The verification ledger below is the contractual record._',
    '',
    narrative.trim(),
    '',
    '---',
    '',
    opts.ledger,
  ].join('\n');
}

/** The default narrative: the `pr` pipeline's commit buckets over
 *  `base..HEAD` plus a one-line files summary. Null when the range is
 *  empty or unreadable. */
export function buildLaneNarrative(cwd: string, base: string): string | null {
  const subjects = gitLines(cwd, ['log', '--format=%s', `${base}..HEAD`]);
  if (subjects === null || subjects.length === 0) return null;
  const files = gitLines(cwd, ['diff', '--name-only', `${base}...HEAD`]) ?? [];

  const lines: string[] = [];
  for (const bucket of bucketCommits(parseCommits(subjects))) {
    lines.push(`**${bucket.label}**`);
    for (const c of bucket.commits) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  if (files.length > 0) {
    const dirs = new Set(files.map((f) => f.split('/')[0]));
    lines.push(
      `_${files.length} file${files.length === 1 ? '' : 's'} touched across ` +
        `${dirs.size} top-level area${dirs.size === 1 ? '' : 's'}._`,
    );
  }
  return lines.join('\n');
}

function gitLines(cwd: string, args: readonly string[]): string[] | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}
