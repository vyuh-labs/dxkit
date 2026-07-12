/**
 * Landing enumeration for the zero-write trial: the last N first-parent
 * commits of a branch, each paired with its first parent — the "what did
 * this landing change" ref pair the trial replays through the gate.
 *
 * First-parent (not `--merges`) so every merge strategy yields pairs:
 *   - merge commits: (parent1, merge) is exactly the PR's cumulative diff;
 *   - squash merges: the squash commit IS the PR, paired with its parent;
 *   - rebase merges: each landed commit becomes its own pair (a coarser
 *     but honest unit — there is no PR boundary in the history).
 * PR numbers are best-effort parsed from the subject line ("Merge pull
 * request #N" and the squash suffix "(#N)") so the trial stays offline —
 * no `gh` dependency, no network.
 */
import { execFileSync } from 'node:child_process';

export interface LandingPair {
  /** The landing commit (merge / squash / rebase-landed commit). */
  readonly headSha: string;
  /** Its first parent — the tree the landing changed. */
  readonly baseSha: string;
  /** Commit subject line, for display. */
  readonly subject: string;
  /** Commit timestamp (ISO-8601). */
  readonly committedAt: string;
  /** Best-effort PR number parsed from the subject; absent when the
   *  subject carries no recognizable marker. */
  readonly prNumber?: number;
}

const MERGE_SUBJECT = /^Merge pull request #(\d+)/;
const SQUASH_SUFFIX = /\(#(\d+)\)\s*$/;

/** Parse a PR number out of a commit subject, if one is recognizable. */
export function prNumberFromSubject(subject: string): number | undefined {
  const merge = MERGE_SUBJECT.exec(subject);
  if (merge) return Number(merge[1]);
  const squash = SQUASH_SUFFIX.exec(subject);
  if (squash) return Number(squash[1]);
  return undefined;
}

/**
 * The last `count` first-parent landings of `ref` (default `HEAD`),
 * newest first. Root commits (no parent) are skipped — there is no base
 * side to diff against. Throws on git failure (not a repo, unknown ref);
 * the CLI surfaces the message.
 */
export function enumerateLandings(cwd: string, count: number, ref: string = 'HEAD'): LandingPair[] {
  // %x1f (unit separator) cannot appear in a subject; %x1e separates records.
  const out = execFileSync(
    'git',
    ['log', '--first-parent', `-n`, String(count), '--format=%H%x1f%P%x1f%cI%x1f%s%x1e', ref],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const pairs: LandingPair[] = [];
  for (const record of out.split('\x1e')) {
    const line = record.trim();
    if (!line) continue;
    const [sha, parents, committedAt, subject] = line.split('\x1f');
    if (!sha || !parents) continue; // root commit or malformed record
    const firstParent = parents.split(' ')[0];
    if (!firstParent) continue;
    pairs.push({
      headSha: sha,
      baseSha: firstParent,
      subject: subject ?? '',
      committedAt: committedAt ?? '',
      prNumber: prNumberFromSubject(subject ?? ''),
    });
  }
  return pairs;
}
