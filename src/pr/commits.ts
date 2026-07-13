/**
 * Conventional-commit parsing for `vyuh-dxkit pr` — turns the branch's commit
 * log into the two things a PR body needs computed rather than improvised: a
 * suggested title (the dominant commit type + scope) and the "Changes" section
 * bucketed by type.
 *
 * Pure and git-free: the caller hands in the raw `git log` subjects for
 * `base..HEAD`; every function here is a deterministic transform over that list.
 * A subject that isn't conventional-commit shaped is still kept (as an
 * `other`-typed commit) so nothing is silently dropped.
 */

/** The conventional-commit types we recognize, in headline priority order — the
 *  dominant-type tiebreak walks this list, so a branch mixing a feat and a
 *  chore titles as the feat. `other` catches non-conventional subjects. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'style',
  'chore',
  'revert',
  'other',
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

export interface ParsedCommit {
  readonly type: CommitType;
  /** The `(scope)` when present, else undefined. */
  readonly scope?: string;
  /** The subject line with the `type(scope): ` prefix stripped. */
  readonly subject: string;
  /** Whether the commit marked a breaking change (`!` or `BREAKING`). */
  readonly breaking: boolean;
  /** The original subject, verbatim. */
  readonly raw: string;
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Parse one `git log --format=%s` subject into a ParsedCommit. A subject that
 *  doesn't match the conventional-commit grammar becomes `type: 'other'` with
 *  the whole line as its subject — kept, never dropped. */
export function parseCommitSubject(raw: string): ParsedCommit {
  const m = CONVENTIONAL.exec(raw.trim());
  if (!m) {
    return { type: 'other', subject: raw.trim(), breaking: /BREAKING[ -]CHANGE/.test(raw), raw };
  }
  const [, typeRaw, scope, bang, subject] = m;
  const type = (COMMIT_TYPES as readonly string[]).includes(typeRaw.toLowerCase())
    ? (typeRaw.toLowerCase() as CommitType)
    : 'other';
  return {
    type,
    ...(scope ? { scope } : {}),
    subject: subject.trim(),
    breaking: bang === '!' || /BREAKING[ -]CHANGE/.test(raw),
    raw,
  };
}

/** Parse a list of subjects (newest-first from `git log`). */
export function parseCommits(subjects: readonly string[]): ParsedCommit[] {
  return subjects
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCommitSubject);
}

/** The display bucket a commit type rolls up into for the "Changes" section. */
export const TYPE_BUCKET: Record<CommitType, string> = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Refactors',
  refactor: 'Refactors',
  docs: 'Docs',
  test: 'Tests',
  build: 'Chore',
  ci: 'Chore',
  style: 'Chore',
  chore: 'Chore',
  revert: 'Fixes',
  other: 'Other',
};

/** Bucket order in the rendered "Changes" section. */
const BUCKET_ORDER = ['Features', 'Fixes', 'Refactors', 'Docs', 'Tests', 'Chore', 'Other'];

export interface ChangeBucket {
  readonly label: string;
  readonly commits: readonly ParsedCommit[];
}

/** Group commits into display buckets, dropping empty buckets, in a stable
 *  reviewer-facing order (Features first). */
export function bucketCommits(commits: readonly ParsedCommit[]): ChangeBucket[] {
  const byBucket = new Map<string, ParsedCommit[]>();
  for (const c of commits) {
    const b = TYPE_BUCKET[c.type];
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(c);
  }
  return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((label) => ({
    label,
    commits: byBucket.get(label)!,
  }));
}

/**
 * The dominant commit type — the highest-priority type present, weighted by
 * count. We pick the type with the most commits; ties break by `COMMIT_TYPES`
 * priority (feat over fix over chore). `other`-only branches return `other`.
 */
export function dominantType(commits: readonly ParsedCommit[]): CommitType {
  if (commits.length === 0) return 'other';
  const counts = new Map<CommitType, number>();
  for (const c of commits) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  let best: CommitType = 'other';
  let bestCount = -1;
  for (const t of COMMIT_TYPES) {
    const n = counts.get(t) ?? 0;
    // Strictly-greater keeps the first (highest-priority) type on a tie.
    if (n > bestCount) {
      best = t;
      bestCount = n;
    }
  }
  return best;
}

/** The most common scope among commits of the given type (undefined when none
 *  carry a scope). Ties break toward the first-seen scope for determinism. */
export function dominantScope(
  commits: readonly ParsedCommit[],
  type: CommitType,
): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const c of commits) {
    if (c.type !== type || !c.scope) continue;
    if (!counts.has(c.scope)) order.push(c.scope);
    counts.set(c.scope, (counts.get(c.scope) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const s of order) {
    const n = counts.get(s)!;
    if (n > bestCount) {
      best = s;
      bestCount = n;
    }
  }
  return best;
}

/**
 * A suggested PR title, computed from the commits. A single-commit branch uses
 * that commit's subject verbatim (already the canonical shape). A multi-commit
 * branch synthesizes `type(scope): <subject-of-the-headline-commit>` — the
 * headline being the first commit of the dominant type (so it reads as a real
 * change, not a count). Falls back to a bare type prefix when nothing usable is
 * present. The title is a SUGGESTION the author refines — never invented detail.
 */
export function suggestTitle(commits: readonly ParsedCommit[]): string {
  if (commits.length === 0) return '';
  if (commits.length === 1) return commits[0].raw.trim();
  const type = dominantType(commits);
  const scope = dominantScope(commits, type);
  const headline = commits.find((c) => c.type === type) ?? commits[0];
  const prefix = scope ? `${type}(${scope})` : type;
  const bang = commits.some((c) => c.breaking) ? '!' : '';
  return `${prefix}${bang}: ${headline.subject}`;
}
