/**
 * The post-merge landed update (impact surface P2): after the reports lane
 * publishes a merge's snapshot, update the merged PR's EXISTING guardrail
 * comment with "Landed: security 40 -> 46 (actual; projection was 46)".
 *
 * One comment identity: the guardrail workflow finds-and-patches its PR
 * comment by the `<!-- dxkit-guardrails -->` marker; this update PATCHes the
 * SAME comment (found by the same marker), appending/replacing a landed
 * section delimited by its own inner marker so re-runs are idempotent. It
 * never posts a second comment.
 *
 * Calibration is the point: the projection the pre-merge comment carried (in
 * the hidden `dxkit-impact-projection` marker) is rendered BESIDE the actual,
 * deliberately: quiet honest calibration over marketing.
 *
 * Degradation contract: every failure (no merged PR for the sha, no
 * guardrail comment, a token without `pull-requests: write`) returns a
 * disclosed `skipped` outcome the lane surfaces in its summary. This module
 * never throws and never fails the snapshot lane.
 */

import { execFileSync } from 'child_process';
import { scoreDeltas, type ReportHistoryEntry, type ScoreDelta } from './history';
import {
  parseImpactProjectionMarker,
  PROJECTION_DIMENSION_KEYS,
  type ImpactProjectionRecord,
} from '../baseline/impact-projection';

/**
 * The guardrail PR comment's identity marker. The rendered workflow template
 * (`src-templates/.github/workflows/dxkit-guardrails.yml`) writes the same
 * literal in shell; `test/reports/landed-comment.test.ts` pins the two equal
 * so the identities cannot fork.
 */
export const GUARDRAIL_COMMENT_MARKER = '<!-- dxkit-guardrails -->';

/** The landed section's inner marker: everything from here to the end of the
 *  comment is the landed section, replaced whole on a re-run. */
export const IMPACT_LANDED_MARKER = '<!-- dxkit-impact-landed -->';

/** Injected `gh` executor (tests stub it; production shells out). Must throw
 *  on a non-zero exit, with the CLI's message on the error. */
export type GhExec = (args: ReadonlyArray<string>, opts?: { readonly input?: string }) => string;

/** Production executor: `gh` with the ambient GH_TOKEN. */
export function defaultGhExec(args: ReadonlyArray<string>, opts?: { input?: string }): string {
  return execFileSync('gh', [...args], {
    encoding: 'utf8',
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    stdio: [opts?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
}

export interface LandedCommentInputs {
  /** `owner/repo` slug. */
  readonly slug: string;
  /** The merge commit the snapshot was computed at. */
  readonly sha: string;
  /** The snapshot just published (the actual). */
  readonly entry: ReportHistoryEntry;
  /** The snapshot before it (the base the org had seen). Absent on the
   *  first-ever snapshot. */
  readonly prev?: ReportHistoryEntry;
  readonly exec: GhExec;
}

export interface LandedCommentOutcome {
  readonly status: 'updated' | 'skipped';
  /** Disclosed cause when skipped (the lane summary renders it). */
  readonly reason?: string;
  readonly prNumber?: number;
}

/** One landed line per dimension, one phrasing:
 *  `security 40 -> 46 (actual; projection was 46)`. */
function landedLine(delta: ScoreDelta, projected?: { readonly to: number }): string {
  const suffix = projected !== undefined ? `; projection was ${projected.to}` : '';
  return `${delta.key} ${delta.from} -> ${delta.to} (actual${suffix})`;
}

/**
 * Render the landed section body (pure; exported for tests). Honesty rules
 * mirror the projection line's: actual labeled actual, zero reported as
 * zero, cross-methodology disclosed instead of diffed, and a dimension is
 * listed when it MOVED or when a projection existed for it (a flat actual
 * against a moving projection is exactly the calibration signal).
 */
export function renderLandedSection(
  entry: ReportHistoryEntry,
  prev: ReportHistoryEntry | undefined,
  projection: ImpactProjectionRecord | null,
): string {
  const lines: string[] = [IMPACT_LANDED_MARKER, '', '### Landed', ''];
  if (!prev) {
    lines.push(
      `First score snapshot on record at ${entry.sha.slice(0, 12)}` +
        (typeof entry.scores.overall === 'number' ? ` (overall ${entry.scores.overall})` : '') +
        '; movement becomes reportable from the next merge.',
    );
    return lines.join('\n');
  }
  if (prev.methodology === undefined || prev.methodology !== entry.methodology) {
    lines.push(
      'Scores not comparable across these snapshots: the prior snapshot was scored under ' +
        `${prev.methodology !== undefined ? `methodology '${prev.methodology}'` : 'an unstamped methodology'} ` +
        `and this one under '${entry.methodology ?? 'unstamped'}'. The trend realigns from this snapshot on.`,
    );
    return lines.join('\n');
  }
  const deltas = scoreDeltas(prev.scores, entry.scores).filter((d) =>
    PROJECTION_DIMENSION_KEYS.includes(d.key),
  );
  const listed = deltas.filter(
    (d) => d.delta !== null && (d.delta !== 0 || projection?.scores[d.key] !== undefined),
  );
  const parts = listed.map((d) => landedLine(d, projection?.scores[d.key]));
  const measured = deltas.filter((d) => d.delta !== null);
  if (parts.length === 0) parts.push('scores unchanged (actual)');
  else if (listed.length < measured.length) parts.push('other dimensions unchanged');
  lines.push(`Landed: ${parts.join(' · ')}`);
  const overall = scoreDeltas(prev.scores, entry.scores).find((d) => d.key === 'overall');
  if (overall && overall.delta !== null && overall.delta !== 0) {
    lines.push('');
    lines.push(`Repo overall: ${overall.from} -> ${overall.to}.`);
  }
  return lines.join('\n');
}

/** Strip any previous landed section so a re-run replaces, never stacks. */
function withoutLandedSection(body: string): string {
  const at = body.indexOf(IMPACT_LANDED_MARKER);
  return at === -1 ? body : body.slice(0, at).replace(/\s+$/, '');
}

interface PrRef {
  readonly number: number;
}
interface CommentRef {
  readonly id: number;
  readonly body: string;
}

/**
 * Find the merged PR for the sha, find the guardrail comment on it, and
 * PATCH the landed section into the same comment. Disclosed skip on every
 * missing precondition or API refusal (a `GITHUB_TOKEN` without
 * `pull-requests: write` lands here), never a throw.
 */
export function updateLandedComment(inputs: LandedCommentInputs): LandedCommentOutcome {
  const { slug, sha, exec } = inputs;
  let prNumber: number;
  try {
    const raw = exec(['api', `repos/${slug}/commits/${sha}/pulls`]);
    const prs = JSON.parse(raw) as ReadonlyArray<PrRef>;
    if (!Array.isArray(prs) || prs.length === 0 || typeof prs[0]?.number !== 'number') {
      return {
        status: 'skipped',
        reason: `no merged pull request found for ${sha.slice(0, 12)} (direct push or squash outside a PR)`,
      };
    }
    prNumber = prs[0].number;
  } catch (err) {
    return {
      status: 'skipped',
      reason: `could not look up the merged pull request: ${(err as Error).message}`,
    };
  }

  let comment: CommentRef | undefined;
  try {
    const raw = exec(['api', '--paginate', `repos/${slug}/issues/${prNumber}/comments`]);
    const comments = JSON.parse(raw) as ReadonlyArray<CommentRef>;
    comment = comments.find(
      (c) => typeof c.body === 'string' && c.body.startsWith(GUARDRAIL_COMMENT_MARKER),
    );
  } catch (err) {
    return {
      status: 'skipped',
      reason: `could not list PR #${prNumber} comments: ${(err as Error).message}`,
      prNumber,
    };
  }
  if (!comment) {
    return {
      status: 'skipped',
      reason: `PR #${prNumber} has no dxkit guardrail comment to update`,
      prNumber,
    };
  }

  const projection = parseImpactProjectionMarker(comment.body);
  const section = renderLandedSection(inputs.entry, inputs.prev, projection);
  const body = `${withoutLandedSection(comment.body)}\n\n${section}\n`;
  try {
    exec(['api', '-X', 'PATCH', `repos/${slug}/issues/comments/${comment.id}`, '-F', 'body=@-'], {
      input: body,
    });
  } catch (err) {
    return {
      status: 'skipped',
      reason:
        `could not update the guardrail comment on PR #${prNumber}: ${(err as Error).message} ` +
        `(the reports workflow needs 'pull-requests: write' for this step)`,
      prNumber,
    };
  }
  return { status: 'updated', prNumber };
}

/** Resolve the `owner/repo` slug: the Actions env first, else `gh`. Null when
 *  neither answers (a local run outside any GitHub remote). */
export function resolveRepoSlug(exec: GhExec, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv && /^[^/\s]+\/[^/\s]+$/.test(fromEnv)) return fromEnv;
  try {
    const slug = exec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
    return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}
