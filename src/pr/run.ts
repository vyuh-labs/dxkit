/**
 * `vyuh-dxkit pr` — compute a reviewable PR body from the branch, not a template.
 *
 * The command is the deterministic core of the dxkit-pr skill: it reads the real
 * commits + diff for `base..HEAD` and computes the title, the bucketed Changes
 * section, the dxkit signals block (via the receipt), the suggested reviewers
 * (active-owner model), a diff-derived reviewer checklist, and the structural-
 * duplicate seam prompts — leaving only the "What & why" narrative for the
 * author. Every embedded signal comes from its canonical source (Rule 2): the
 * receipt from `buildReceipt`, reviewers from `computeReviewers`, duplicates from
 * dxkit's AST detector.
 *
 * Zero side effects beyond reading git + the (cache-backed) guardrail; it never
 * opens a PR — that's an explicit `gh pr create` the author runs after review.
 */
import { execFileSync } from 'child_process';
import { detectActiveLanguages } from '../languages/index';
import { buildReceipt } from '../receipt-cli';
import { computeReviewers } from '../reviewers-cli';
import { parseCommits, bucketCommits, suggestTitle } from './commits';
import { deriveFacts, buildChecklist } from './checklist';
import { gatherPrSeams } from './seams';
import { renderPrBody, renderPrJson, type PrData } from './render';

export interface PrOptions {
  readonly base?: string;
  /** Add health-score movement vs the base ref to the signals block (a base-ref
   *  analysis — omit for verdict + allowlist only, which is cache-instant). */
  readonly since?: string;
  readonly json?: boolean;
  /** Skip the structural-duplicate seam pass (the AST gather). */
  readonly noSeams?: boolean;
}

function git(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/** Resolve the base ref: explicit flag, else the remote default branch, else
 *  `origin/main`. */
function resolveBase(cwd: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const remoteHead = git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
  return remoteHead || 'origin/main';
}

/** Repo-relative files changed in `base...HEAD` (merge-base three-dot). */
function changedFiles(cwd: string, base: string): string[] {
  const out = git(['diff', '--name-only', `${base}...HEAD`], cwd);
  return out.split('\n').filter(Boolean);
}

/** The lines the diff ADDED (the `+` side, prefix stripped), skipping the
 *  `+++` file headers. Used only for intrinsic marker detection. */
function addedLines(cwd: string, base: string): string[] {
  const diff = git(['diff', '--unified=0', `${base}...HEAD`], cwd);
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

export async function runPr(cwd: string, opts: PrOptions = {}): Promise<string> {
  const base = resolveBase(cwd, opts.base);

  const subjects = git(['log', '--format=%s', `${base}..HEAD`], cwd)
    .split('\n')
    .filter(Boolean);
  const commits = parseCommits(subjects);

  const files = changedFiles(cwd, base);
  const packs = detectActiveLanguages(cwd);
  const facts = deriveFacts({ changedFiles: files, addedLines: addedLines(cwd, base), packs });

  // The receipt needs a baseline; fail-open to no signals block if it can't run.
  let receiptMarkdown: string | null = null;
  try {
    receiptMarkdown = (await buildReceipt(cwd, { ...(opts.since ? { since: opts.since } : {}) }))
      .markdown;
  } catch {
    receiptMarkdown = null;
  }

  const reviewers = computeReviewers(cwd, { base });

  const seams = opts.noSeams ? [] : await gatherPrSeams(cwd, new Set(files));

  const data: PrData = {
    title: suggestTitle(commits),
    buckets: bucketCommits(commits),
    receiptMarkdown,
    reviewers,
    seams,
    checklist: buildChecklist(facts),
    base,
  };

  return opts.json ? JSON.stringify(renderPrJson(data), null, 2) : renderPrBody(data);
}
