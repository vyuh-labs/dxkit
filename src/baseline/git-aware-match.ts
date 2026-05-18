/**
 * Git-aware match — pairs prior-run identities with current-run
 * identities through the lens of `git diff baseSha headSha`.
 *
 * The line-bucket identity scheme used by code/secret/config/hygiene
 * findings tolerates ±2 lines of vertical drift. Anything past that
 * appears to a naive set-diff as "removed + added" even though
 * semantically the finding hasn't changed — it just moved with the
 * surrounding code. This module closes the gap.
 *
 * Algorithm:
 *
 *   1. Exact identity match — every finding present in both runs
 *      under the same fingerprint is `persisted` immediately.
 *
 *   2. For each finding in the `removed` set that carries a file +
 *      line locator: ask git to map its base-line through the diff
 *      to the corresponding head-line. If the `added` set contains
 *      a finding at the same `(file, rule, mappedLine)`, the two
 *      represent the same underlying issue moved by the diff —
 *      move both to `persisted`.
 *
 *   3. Whatever remains in `added` and `removed` is genuinely new
 *      or genuinely gone.
 *
 * Fallback: when git history is unavailable (no `.git`, baseSha not
 * reachable, file deleted, etc.) the module degrades to plain
 * set-diff matching — the same behavior `matchAcrossRuns` produces
 * on its own. Callers in shallow-clone CI or non-git workflows get
 * a working (if less precise) result.
 *
 * Known limitations (Sprint 0 v1):
 *   - File renames are not auto-tracked. A renamed file looks like
 *     "removed prior + added current"; future iterations will use
 *     `git log --follow` or `git diff -M` rename detection to close
 *     this gap.
 *   - Cross-file refactors (function extracted to a new file) are
 *     reported as removed-and-added.
 *   - When the line-bucket mapping fails on context edits (tool
 *     reports finding at a slightly different line in head than the
 *     diff predicts), we fall back to "unmatched." Sprint 0.x adds
 *     a content-hash fallback for this class.
 */

import { execFileSync } from 'child_process';
import { matchAcrossRuns } from './finding-identity';
import type { FindingId, MatchPair, MatchReason, MatchResult } from './types';

/** Confidence assigned to a git-mapped pair when the candidate sits
 *  on exactly the mapped line. Slightly below 1.0 so consumers can
 *  tell apart "exact identity match" (1.0) from "different identity
 *  but same finding through diff" (0.95). */
const CONFIDENCE_GIT_EXACT = 0.95;
/** Confidence when the candidate sits within ±2 lines of the mapped
 *  line — scanners often shift the reported line slightly across
 *  re-runs even when nothing semantic changed. */
const CONFIDENCE_GIT_FUZZ = 0.88;
/** Range of the line-fuzz lookup window. */
const LINE_FUZZ_RANGE = 2;
/** Confidence assigned to a content-hash pair. Below git-line-fuzz
 *  so the policy's per-severity confidence thresholds naturally
 *  distinguish "matched via git diff" from "matched via context
 *  bytes alone." For low-severity findings (default threshold 0.90),
 *  a content-hash pair demotes to `'uncertain'`; for critical
 *  findings (threshold 0.75), it passes through cleanly. */
const CONFIDENCE_CONTENT_HASH = 0.8;

/**
 * Per-finding identity plus the locator info needed to query git.
 * Producers convert `BaselineEntry` (or any equivalent stored form)
 * into this shape before calling `gitAwareMatch`.
 *
 * `file`, `line`, and `rule` are optional only because some finding
 * kinds (dep-vuln, license) have no file-line locator. Those kinds
 * are handled entirely by step-1 exact-identity match and skipped
 * by the step-2 git fallback.
 */
export interface LocatedIdentity {
  readonly id: FindingId;
  readonly file?: string;
  readonly line?: number;
  readonly rule?: string;
  /** Optional content-hash for the finding's surrounding context.
   *  Producer (Phase 3 baseline-create) computes via
   *  `computeContentHash` and stamps on the entry. When present on
   *  both prior and current sides for a `(canonical-rule, hash)`
   *  pair, the matcher's content-hash pass uses it as a fallback
   *  after the git-aware location pass exhausts. Absent when the
   *  producer can't read the file (binary, deleted, missing). */
  readonly contentHash?: string;
}

export interface GitAwareMatchOptions {
  /** Working directory of the repository under check. */
  readonly cwd: string;
  /** Commit SHA the baseline was created against. The matcher
   *  requires this SHA to be reachable in `cwd`'s git history. */
  readonly baseSha: string;
  /** Commit SHA (or revision spec) to compare against. Defaults to
   *  `'HEAD'` — the current working-tree's last commit. */
  readonly headSha?: string;
}

/**
 * Map a 1-based line number in `baseSha`'s version of `file` to its
 * corresponding 1-based line in `headSha`. Returns `null` when the
 * line was deleted, the file was removed, or git couldn't produce a
 * diff for any reason.
 *
 * Implementation runs `git diff --unified=0 baseSha headSha -- file`
 * and walks the resulting `@@ -A,B +C,D @@` hunks. Pure-ish: the
 * only impurity is the git subprocess; the parser is deterministic
 * over its input.
 */
export function mapLineThroughDiff(opts: {
  readonly cwd: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Path at `baseSha`. May differ from `newFile` if the caller
   *  resolved a rename. Pass-through compat: callers that don't
   *  track renames can use the same value for both. */
  readonly oldFile?: string;
  /** Path at `headSha`. */
  readonly newFile?: string;
  /** Legacy single-file form. When supplied, both `oldFile` and
   *  `newFile` default to this value. Kept for back-compat with
   *  call-sites that pre-date rename support. */
  readonly file?: string;
  readonly baseLine: number;
}): number | null {
  const oldFile = opts.oldFile ?? opts.file;
  const newFile = opts.newFile ?? opts.file ?? oldFile;
  if (!oldFile || !newFile) {
    throw new Error('mapLineThroughDiff requires `file` or both `oldFile` + `newFile`');
  }
  let diff: string;
  try {
    diff = execFileSync(
      'git',
      [
        'diff',
        '--unified=0',
        '--no-color',
        '--find-renames',
        opts.baseSha,
        opts.headSha,
        '--',
        oldFile,
        ...(newFile !== oldFile ? [newFile] : []),
      ],
      { cwd: opts.cwd, encoding: 'utf8' },
    );
  } catch {
    // File missing in one revision, git not available, sha unreachable — any
    // of these defeats the mapping. Caller treats null as "unmatched."
    return null;
  }
  if (!diff.trim()) {
    // Identical between revisions: line numbers are 1:1.
    return opts.baseLine;
  }
  return walkHunks(diff, opts.baseLine);
}

/**
 * Parse `@@ -oldStart,oldCount +newStart,newCount @@` hunk headers
 * and resolve `baseLine` to its post-diff line number. Pure
 * function over the diff text.
 *
 * A line falls into one of three regions:
 *   - Before any hunk that affects it: shifted only by the
 *     accumulated net delta of earlier hunks.
 *   - Inside a hunk's deletion span: removed by this diff,
 *     returns null.
 *   - After all hunks: shifted by the full accumulated net delta.
 */
function walkHunks(diff: string, baseLine: number): number | null {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  let cumulativeShift = 0;
  while ((match = hunkRe.exec(diff)) !== null) {
    const oldStart = parseInt(match[1], 10);
    const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
    const oldEnd = oldStart + oldCount - 1;

    if (baseLine < oldStart) {
      // Line lies before this hunk — earlier shifts apply, this hunk doesn't.
      return baseLine + cumulativeShift;
    }
    if (oldCount > 0 && baseLine >= oldStart && baseLine <= oldEnd) {
      // Line was deleted by this hunk.
      return null;
    }
    cumulativeShift += newCount - oldCount;
  }
  return baseLine + cumulativeShift;
}

/**
 * Composite matcher. Three passes, decreasing in match strength:
 *
 *   1. Location-aware pairing (when git is available): for each
 *      line-anchored prior finding, map its base line to the
 *      corresponding head line via `git diff`, then look up a
 *      current finding at `(effectivePath, rule, mappedLine)`. The
 *      effective path is the prior path translated through the
 *      rename map; status is `'relocated'` when the path changed,
 *      `'persisted'` when it didn't.
 *      Lookups try the exact mapped line first (confidence 0.95),
 *      then a ±2 fuzz window (confidence 0.88).
 *
 *   1.5. Content-hash pairing (when both sides carry content
 *      hashes): match prior+current by `(canonicalRule,
 *      contentHash)`. Runs regardless of git reachability — the
 *      hash is file-content-derived and doesn't need git. Catches
 *      cases git can't (shallow clone, force-pushed baseline) and
 *      cases git misses (line-bucket boundary shifts where the
 *      surrounding context survived intact). Confidence 0.80 — the
 *      policy's per-severity thresholds naturally tune whether to
 *      trust this layer.
 *
 *   2. Multiset exact-identity diff over whatever remains. Catches:
 *        - findings without a file-line locator (dep-vuln, license,
 *          symbol-based coverage-gap, duplication)
 *        - line-anchored findings whose locations didn't survive
 *          the diff but whose fingerprints happen to coincide
 *          across runs
 *        - everything when git history is unreachable (`baseSha`
 *          missing) and pass 1 was skipped
 *
 * Why location-first: the line-bucket fingerprint scheme can produce
 * spurious "persisted" matches when two findings of the same rule
 * in the same file naturally shift into each other's buckets. Pass 1
 * pairs them by real diff position, which is what a developer
 * intuitively expects. Pass 1.5 catches the cases where pass 1 isn't
 * available; pass 2 handles content-independent identity kinds.
 */
export function gitAwareMatch(
  prior: ReadonlyArray<LocatedIdentity>,
  current: ReadonlyArray<LocatedIdentity>,
  opts: GitAwareMatchOptions,
): MatchResult {
  const headSha = opts.headSha ?? 'HEAD';
  const reachability = checkShaReachable(opts.cwd, opts.baseSha);

  const pairs: MatchPair[] = [];
  const priorMatched = new Set<LocatedIdentity>();
  const currentMatched = new Set<LocatedIdentity>();

  if (reachability.ok) {
    const renames = readRenameMap(opts.cwd, opts.baseSha, headSha);

    // Index current findings by (file, rule, line). One key holds at
    // most one entry — the multiset diff in pass 2 picks up any
    // collisions left after location pairing.
    const currentByLocation = new Map<string, LocatedIdentity[]>();
    for (const c of current) {
      if (!c.file || c.line === undefined || !c.rule) continue;
      const key = locationKey(c.file, c.rule, c.line);
      const bucket = currentByLocation.get(key);
      if (bucket) bucket.push(c);
      else currentByLocation.set(key, [c]);
    }

    const takeAt = (key: string): LocatedIdentity | undefined => {
      const bucket = currentByLocation.get(key);
      if (!bucket || bucket.length === 0) return undefined;
      const head = bucket.shift();
      if (bucket.length === 0) currentByLocation.delete(key);
      return head;
    };

    for (const p of prior) {
      if (!p.file || p.line === undefined || !p.rule) continue;
      const effectivePath = renames.get(p.file) ?? p.file;
      const pathChanged = effectivePath !== p.file;
      const mappedLine = mapLineThroughDiff({
        cwd: opts.cwd,
        baseSha: opts.baseSha,
        headSha,
        oldFile: p.file,
        newFile: effectivePath,
        baseLine: p.line,
      });
      if (mappedLine === null) continue;

      // Exact mapped line first.
      let candidate = takeAt(locationKey(effectivePath, p.rule, mappedLine));
      let confidence = CONFIDENCE_GIT_EXACT;
      let fuzzDelta = 0;
      // Line-fuzz fallback: scanners drift the reported line by 1-2
      // lines on re-runs. Walk outward from the mapped line.
      if (!candidate) {
        for (let delta = 1; delta <= LINE_FUZZ_RANGE; delta++) {
          for (const offset of [-delta, delta]) {
            const c2 = takeAt(locationKey(effectivePath, p.rule, mappedLine + offset));
            if (c2) {
              candidate = c2;
              confidence = CONFIDENCE_GIT_FUZZ;
              fuzzDelta = offset;
              break;
            }
          }
          if (candidate) break;
        }
      }
      if (!candidate) continue;

      priorMatched.add(p);
      currentMatched.add(candidate);
      const reasons: MatchReason[] = [
        {
          code: 'git-line-' + (fuzzDelta === 0 ? 'exact' : 'fuzz'),
          detail:
            fuzzDelta === 0
              ? `git diff mapped ${p.file}:${p.line} to ${effectivePath}:${mappedLine}`
              : `git diff mapped ${p.file}:${p.line} to ${effectivePath}:${mappedLine}; ` +
                `current finding sits ${fuzzDelta > 0 ? '+' : ''}${fuzzDelta} line(s) off (within fuzz window)`,
        },
      ];
      if (pathChanged) {
        reasons.unshift({
          code: 'git-rename',
          detail: `file renamed: ${p.file} → ${effectivePath}`,
        });
      }
      pairs.push({
        priorId: p.id,
        currentId: candidate.id,
        status: pathChanged ? 'relocated' : 'persisted',
        confidence,
        reasons,
      });
    }
  }

  // Pass 1.5 — content-hash fallback. Pairs prior+current findings
  // by `(canonicalRule, contentHash)` when both sides carry a
  // content hash (stamped by the producer). Runs regardless of git
  // reachability — content hashes are file-content-derived and
  // don't need git to compare. Confidence is below the git-line
  // tier so the policy classifier's per-severity thresholds tune
  // whether to trust the match.
  {
    const currentByContent = new Map<string, LocatedIdentity[]>();
    for (const c of current) {
      if (currentMatched.has(c)) continue;
      if (!c.contentHash || !c.rule) continue;
      const key = contentKey(c.rule, c.contentHash);
      const bucket = currentByContent.get(key);
      if (bucket) bucket.push(c);
      else currentByContent.set(key, [c]);
    }
    const takeContent = (key: string): LocatedIdentity | undefined => {
      const bucket = currentByContent.get(key);
      if (!bucket || bucket.length === 0) return undefined;
      const head = bucket.shift();
      if (bucket.length === 0) currentByContent.delete(key);
      return head;
    };
    for (const p of prior) {
      if (priorMatched.has(p)) continue;
      if (!p.contentHash || !p.rule) continue;
      const candidate = takeContent(contentKey(p.rule, p.contentHash));
      if (!candidate) continue;
      priorMatched.add(p);
      currentMatched.add(candidate);
      const pathChanged = !!(p.file && candidate.file && p.file !== candidate.file);
      pairs.push({
        priorId: p.id,
        currentId: candidate.id,
        status: pathChanged ? 'relocated' : 'persisted',
        confidence: CONFIDENCE_CONTENT_HASH,
        reasons: [
          {
            code: 'content-hash',
            detail: pathChanged
              ? `content-hash match across rename: ${p.file ?? '?'} → ${candidate.file ?? '?'}`
              : 'content-hash match (surrounding code byte-identical after whitespace normalization)',
          },
        ],
      });
    }
  }

  // Pass 2 — multiset exact-id diff over leftovers.
  const priorRemaining: FindingId[] = [];
  const currentRemaining: FindingId[] = [];
  for (const p of prior) if (!priorMatched.has(p)) priorRemaining.push(p.id);
  for (const c of current) if (!currentMatched.has(c)) currentRemaining.push(c.id);
  const exactRemaining = matchAcrossRuns(priorRemaining, currentRemaining);
  for (const pair of exactRemaining.pairs) pairs.push(pair);

  // Flatten the legacy views from the pair list.
  const persisted: FindingId[] = [];
  const added: FindingId[] = [];
  const removed: FindingId[] = [];
  for (const pair of pairs) {
    switch (pair.status) {
      case 'persisted':
      case 'relocated':
        if (pair.priorId) persisted.push(pair.priorId);
        if (pair.currentId && pair.currentId !== pair.priorId) persisted.push(pair.currentId);
        break;
      case 'added':
        if (pair.currentId) added.push(pair.currentId);
        break;
      case 'removed':
        if (pair.priorId) removed.push(pair.priorId);
        break;
    }
  }

  return {
    pairs,
    persisted,
    added,
    removed,
    gitAware: reachability.ok,
    degradedReason: reachability.ok ? undefined : reachability.reason,
  };
}

function locationKey(file: string, rule: string, line: number): string {
  return `${file}\0${rule}\0${line}`;
}

function contentKey(rule: string, contentHash: string): string {
  return `content\0${rule}\0${contentHash}`;
}

/**
 * Build a Map<oldPath, newPath> for files renamed between baseSha
 * and headSha. Uses git's rename detection (`--find-renames`,
 * default similarity threshold). Files that weren't renamed don't
 * appear in the map; callers fall back to using the prior path as
 * the effective path.
 */
function readRenameMap(cwd: string, baseSha: string, headSha: string): Map<string, string> {
  const renames = new Map<string, string>();
  let output: string;
  try {
    output = execFileSync('git', ['diff', '--name-status', '--find-renames', baseSha, headSha], {
      cwd,
      encoding: 'utf8',
    });
  } catch {
    return renames;
  }
  for (const line of output.split('\n')) {
    // Rename lines look like:  R100\told/path\tnew/path
    // M / A / D / C lines have only one path column and are ignored here.
    if (!line.startsWith('R')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    renames.set(parts[1], parts[2]);
  }
  return renames;
}

/**
 * Check whether the SHA exists in the repo and return a structured
 * verdict. Distinguishes "not a git repo," "git not installed,"
 * "valid repo but commit unreachable" — every non-ok case produces
 * a human-readable reason for `MatchResult.degradedReason`.
 */
function checkShaReachable(cwd: string, sha: string): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'cwd is not a git repository (or git is not installed)' };
  }
  try {
    execFileSync('git', ['cat-file', '-e', sha], { cwd, stdio: 'ignore' });
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `baseline commit ${sha} is not reachable in this checkout (shallow clone or force-push?)`,
    };
  }
}
