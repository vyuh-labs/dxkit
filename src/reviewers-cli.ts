/**
 * `vyuh-dxkit reviewers` — suggest reviewers for a change, grounded on the
 * active-owner model (dev-report git history) rather than naive last-touch
 * blame, blended with CODEOWNERS.
 *
 * The differentiation over a platform's built-in suggested-reviewers: the
 * candidates are activity-weighted (recent, sustained work ranks highest),
 * scoped to who is still active (a departed owner is never silently
 * suggested), bot-free, exclude the change's own author, and carry a
 * bus-factor signal. CODEOWNERS, when present, is authoritative and merged
 * in. Output renders names + GitHub @handles — never raw emails.
 *
 * Pure helpers (`parseCodeowners`, `matchCodeowners`, `buildSuggestions`)
 * are unit-tested without git; `runReviewers` is the IO entry point.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as logger from './logger';
import { ownersFor, type OwnershipResult } from './analyzers/developer/ownership';
import { normalizeEmail } from './analyzers/developer/gather';

export interface CodeownersRule {
  /** The path pattern (gitignore-ish). */
  readonly pattern: string;
  /** Owner tokens — `@handle`, `@org/team`, or an email. */
  readonly owners: ReadonlyArray<string>;
}

/**
 * Parse a CODEOWNERS file. Each non-comment line is `<pattern> <owner>...`.
 * Returns rules in file order; CODEOWNERS semantics are "last matching rule
 * wins," so callers iterate in reverse.
 */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).filter(Boolean);
    if (pattern && owners.length > 0) rules.push({ pattern, owners });
  }
  return rules;
}

/** Translate a CODEOWNERS pattern to a RegExp (subset: `*`, `**`, leading
 *  `/`, trailing `/`). Good enough for the common cases; unmatched exotic
 *  globs simply don't match (conservative — never over-claims ownership). */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  // Tokenize so `**` -> `.*` and `*` -> `[^/]*` without a fragile placeholder;
  // every other regex-special char is escaped.
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        body += '.*';
        i++;
      } else {
        body += '[^/]*';
      }
    } else if (/[.+^${}()|[\]\\?]/.test(c)) {
      body += '\\' + c;
    } else {
      body += c;
    }
  }
  const full = dirOnly ? `${body}/.*` : `${body}(?:/.*)?`;
  return new RegExp(anchored ? `^${full}$` : `(?:^|/)${full}$`);
}

/** Owners for one file: the LAST matching CODEOWNERS rule wins. Empty when
 *  no rule matches. */
export function matchCodeowners(rules: ReadonlyArray<CodeownersRule>, file: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (patternToRegExp(rules[i].pattern).test(file)) return [...rules[i].owners];
  }
  return [];
}

export interface ReviewerSuggestion {
  /** Display name (from git) or the CODEOWNERS token when git-less. */
  readonly name: string;
  /** GitHub @handle when known (offline-resolved or a CODEOWNERS `@handle`). */
  readonly handle?: string;
  readonly active: boolean;
  readonly isCodeowner: boolean;
  /** Human rationale for the suggestion. */
  readonly reason: string;
  readonly score: number;
}

export interface ReviewersResult {
  readonly touchedFiles: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<ReviewerSuggestion>;
  readonly busFactor: number;
  /** Set when no active git owner was found — suggestions then lean on
   *  CODEOWNERS / a stated fallback rather than naming someone unreachable. */
  readonly note?: string;
}

export interface BuildSuggestionsOptions {
  readonly limit?: number;
  /** CODEOWNERS owner tokens matched to the touched files (deduped). */
  readonly codeowners?: ReadonlyArray<string>;
}

/**
 * Compose the active-owner ranking with CODEOWNERS into a ranked reviewer
 * list. Pure. CODEOWNERS owners are authoritative (always included, flagged);
 * active git owners follow, ranked by score; inactive owners are dropped from
 * the suggestion list (they're surfaced only via the `note` fallback).
 */
export function buildSuggestions(
  ownership: OwnershipResult,
  opts: BuildSuggestionsOptions = {},
): ReviewersResult & { reviewers: ReviewerSuggestion[] } {
  const limit = opts.limit ?? 3;
  const codeowners = dedupe(opts.codeowners ?? []);
  const out: ReviewerSuggestion[] = [];
  const seen = new Set<string>();

  // 1. CODEOWNERS first — authoritative.
  for (const token of codeowners) {
    const handle = token.startsWith('@') ? token.slice(1) : undefined;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: token,
      ...(handle ? { handle } : {}),
      active: true, // CODEOWNERS is a maintained, current declaration
      isCodeowner: true,
      reason: 'listed in CODEOWNERS for the touched paths',
      score: Number.POSITIVE_INFINITY,
    });
  }

  // 2. Active git owners, ranked.
  const activeOwners = ownership.ranked.filter((o) => o.active);
  for (const o of activeOwners) {
    const handle = o.githubHandle;
    const key = (handle ? `@${handle}` : o.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: o.name,
      ...(handle ? { handle } : {}),
      active: true,
      isCodeowner: false,
      reason: `${o.commits} recent commit${o.commits === 1 ? '' : 's'} to the touched files (last ${o.lastTouched})`,
      score: o.score,
    });
  }

  const reviewers = out.slice(0, limit);

  let note: string | undefined;
  if (activeOwners.length === 0 && codeowners.length === 0) {
    note =
      ownership.ranked.length > 0
        ? 'Every contributor who has touched these files is inactive — no current owner to suggest. Route by current team ownership.'
        : 'No git history or CODEOWNERS for the touched files — no reviewer signal.';
  } else if (activeOwners.length === 0) {
    note = 'Original authors are inactive — suggesting by CODEOWNERS only.';
  }

  return {
    touchedFiles: [],
    reviewers,
    busFactor: ownership.busFactor,
    ...(note ? { note } : {}),
  };
}

function dedupe(xs: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

// ─── IO entry point ─────────────────────────────────────────────────────────

export interface ReviewersOptions {
  readonly base?: string;
  readonly staged?: boolean;
  readonly json?: boolean;
  readonly limit?: number;
}

function gitOut(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function touchedFiles(cwd: string, opts: ReviewersOptions): string[] {
  if (opts.staged) {
    return gitOut('git diff --cached --name-only', cwd).split('\n').filter(Boolean);
  }
  const base = opts.base || gitOut('git rev-parse --abbrev-ref origin/HEAD', cwd) || 'origin/main';
  const out = gitOut(`git diff --name-only ${base}...HEAD`, cwd);
  return out.split('\n').filter(Boolean);
}

function readCodeowners(cwd: string): CodeownersRule[] {
  for (const rel of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const p = path.join(cwd, rel);
    if (fs.existsSync(p)) return parseCodeowners(fs.readFileSync(p, 'utf8'));
  }
  return [];
}

/**
 * Compute the reviewer suggestions without printing — the IO gather (touched
 * files, ownership, CODEOWNERS) plus the pure `buildSuggestions` ranking. Both
 * `runReviewers` (prints) and `vyuh-dxkit pr` (embeds the list) call this, so the
 * active-owner model has one entry point (Rule 2). Returns null when no changed
 * files are detected.
 */
export function computeReviewers(cwd: string, opts: ReviewersOptions): ReviewersResult | null {
  const files = touchedFiles(cwd, opts);
  if (files.length === 0) return null;

  // Exclude the change author from suggestions (never review your own PR).
  const authorEmail = gitOut('git config --get user.email', cwd);
  const excludeEmails = authorEmail ? new Set([normalizeEmail(authorEmail)]) : undefined;

  const ownership = ownersFor(cwd, files, { ...(excludeEmails ? { excludeEmails } : {}) });

  // CODEOWNERS owners for the touched files (deduped across files).
  const rules = readCodeowners(cwd);
  const coOwners: string[] = [];
  for (const f of files) coOwners.push(...matchCodeowners(rules, f));

  return {
    ...buildSuggestions(ownership, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      codeowners: coOwners,
    }),
    touchedFiles: files,
  };
}

export function runReviewers(cwd: string, opts: ReviewersOptions): void {
  const result = computeReviewers(cwd, opts);
  if (!result) {
    logger.info('No changed files detected (pass --base <ref> or --staged). Nothing to suggest.');
    return;
  }
  const files = result.touchedFiles;

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  logger.info(
    `Suggested reviewers for ${files.length} changed file${files.length === 1 ? '' : 's'}:`,
  );
  if (result.reviewers.length === 0) {
    logger.info('  (none)');
  }
  for (const r of result.reviewers) {
    const who = r.handle ? `@${r.handle}` : r.name;
    const tag = r.isCodeowner ? ' [CODEOWNERS]' : '';
    logger.info(`  ${who}${tag} — ${r.reason}`);
  }
  if (result.busFactor === 1) {
    logger.warn(
      '  Bus factor 1: a single active owner covers these files — consider spreading knowledge.',
    );
  }
  if (result.note) logger.dim(`  ${result.note}`);
}
