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
 * File renames are auto-tracked via git's rename detection
 * (`--find-renames`): line-anchored findings relocate through Pass 1
 * (the rename map feeds `mapLineThroughDiff`), and whole-file findings
 * (test-gap, large-file, …) relocate through Pass 1b. A renamed file
 * therefore reports `relocated`, not removed+added.
 *
 * Known limitations:
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
export const CONFIDENCE_CONTENT_HASH = 0.8;
/** Confidence for a SAME-FILE (or git-rename-mapped) content-hash pair:
 *  same rule + identical normalized window + same file. Sits at the
 *  strictest per-severity threshold (low: 0.90) so a pure reformat reads
 *  persisted on every severity, never demoted to `uncertain`. */
export const CONFIDENCE_CONTENT_HASH_SAME_FILE = 0.9;
/** Confidence assigned to a modified-hunk endpoint pair (#271): the
 *  line itself changed, so there is no line-map image and no byte
 *  identity — the evidence is the hunk STRUCTURE plus an unambiguous
 *  same-rule 1:1 within it. Below git-line-fuzz (the line survived
 *  there; here it was rewritten), so low-severity pairs demote to
 *  `'uncertain'` under the default thresholds while the pairing still
 *  prevents the false net-new BLOCK that split pairs produced. */
const CONFIDENCE_HUNK_PAIR = 0.85;

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
  const diff = fetchFileDiff(opts.cwd, opts.baseSha, opts.headSha, oldFile, newFile);
  if (diff === null) {
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

/** The ONE per-file diff fetch both the line mapper and the hunk-pair pass
 *  read (`--unified=0`, rename-aware). Null when git cannot produce it. */
function fetchFileDiff(
  cwd: string,
  baseSha: string,
  headSha: string,
  oldFile: string,
  newFile: string,
): string | null {
  try {
    return execFileSync(
      'git',
      [
        'diff',
        '--unified=0',
        '--no-color',
        '--find-renames',
        baseSha,
        headSha,
        '--',
        oldFile,
        ...(newFile !== oldFile ? [newFile] : []),
      ],
      { cwd, encoding: 'utf8' },
    );
  } catch {
    return null;
  }
}

interface HunkSpan {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** All `@@ -A,B +C,D @@` spans of a `--unified=0` diff, in order. Pure
 *  function over the diff text (the same header grammar `walkHunks` walks). */
function parseHunkSpans(diff: string): HunkSpan[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const spans: HunkSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(diff)) !== null) {
    spans.push({
      oldStart: parseInt(match[1], 10),
      oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3], 10),
      newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    });
  }
  return spans;
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
 *   1.75. Modified-hunk endpoint pairing (#271): a prior finding ON a
 *      line the diff modified (a -/+ replacement hunk — no line-map
 *      image, no surviving context bytes) pairs with a current finding
 *      of the same rule inside the same hunk's new span, conservative
 *      1:1 (an ambiguous bucket stays split). Confidence 0.85 — below
 *      git-line-fuzz: the line was rewritten, not moved.
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
  // Shared by Pass 1, 1b, and the hunk-pair pass below.
  const renames = reachability.ok
    ? readRenameMap(opts.cwd, opts.baseSha, headSha)
    : new Map<string, string>();

  if (reachability.ok) {
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

    // Pass 1b — whole-file rename relocation. Whole-file findings
    // (test-gap, large-file, stale-file, test-file-degradation, …) are
    // file-anchored with no line, so Pass 1's line mapping can't reach
    // them. Their identity is path-based, so a pure file rename makes a
    // naive diff read them as removed+added → false net-new debt on a
    // rename. Here we remap each unmatched prior whole-file finding's
    // file through the rename map and pair it with an unmatched current
    // whole-file finding of the SAME kind at the renamed path. The key
    // is (renamed-path, kind) — `entryToLocated` carries the kind in
    // `rule` — so two different whole-file kinds on one renamed file
    // never cross-pair (which would mask a genuinely new finding as
    // relocated). Acts only on files git detected as renamed; same-path
    // whole-file findings are left to Pass 2's exact-id match.
    if (renames.size > 0) {
      const currentWholeFile = new Map<string, LocatedIdentity[]>();
      for (const c of current) {
        if (currentMatched.has(c)) continue;
        if (!c.file || c.line !== undefined) continue; // whole-file only
        const key = wholeFileKey(c.file, c.rule);
        const bucket = currentWholeFile.get(key);
        if (bucket) bucket.push(c);
        else currentWholeFile.set(key, [c]);
      }
      const takeWholeFile = (key: string): LocatedIdentity | undefined => {
        const bucket = currentWholeFile.get(key);
        if (!bucket || bucket.length === 0) return undefined;
        const head = bucket.shift();
        if (bucket.length === 0) currentWholeFile.delete(key);
        return head;
      };
      for (const p of prior) {
        if (priorMatched.has(p)) continue;
        if (!p.file || p.line !== undefined) continue; // whole-file only
        const renamedPath = renames.get(p.file);
        if (renamedPath === undefined || renamedPath === p.file) continue; // renamed only
        const candidate = takeWholeFile(wholeFileKey(renamedPath, p.rule));
        if (!candidate) continue;
        priorMatched.add(p);
        currentMatched.add(candidate);
        pairs.push({
          priorId: p.id,
          currentId: candidate.id,
          status: 'relocated',
          confidence: CONFIDENCE_GIT_EXACT,
          reasons: [
            {
              code: 'git-rename',
              detail: `whole-file finding relocated across rename: ${p.file} → ${renamedPath}`,
            },
          ],
        });
      }
    }
  }

  // Pass 1.5 — content-hash fallback. Pairs prior+current findings
  // by `(canonicalRule, contentHash)` when both sides carry a
  // content hash (stamped by the orchestrator). Runs regardless of git
  // reachability — content hashes are file-content-derived and
  // don't need git to compare.
  //
  // Two phases, so the outcome never depends on prior iteration order:
  // identical boilerplate windows in different files (copied components,
  // generated code) hash identically under one rule, and a greedy
  // first-come take would let a prior whose own file lost its candidate
  // steal another file's twin. Phase 1 pairs every prior that has a
  // candidate in its OWN file (or, when the git pass saw the file renamed,
  // in the renamed file — git evidence outranks a same-old-path twin).
  // Phase 2 pairs the leftovers cross-file (a rename git could not see).
  // A same-file/renamed pair carries higher confidence than a cross-file
  // one: same rule + identical normalized window + same file is strong
  // evidence, and it must clear the per-severity thresholds so a pure
  // reformat reads persisted, not demoted to uncertain.
  {
    interface ContentBucket {
      byFile: Map<string, LocatedIdentity[]>;
      order: LocatedIdentity[];
    }
    const buckets = new Map<string, ContentBucket>();
    const taken = new Set<LocatedIdentity>();
    for (const c of current) {
      if (currentMatched.has(c)) continue;
      if (!c.contentHash || !c.rule) continue;
      const key = contentKey(c.rule, c.contentHash);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { byFile: new Map(), order: [] };
        buckets.set(key, bucket);
      }
      bucket.order.push(c);
      if (c.file !== undefined) {
        const files = bucket.byFile.get(c.file);
        if (files) files.push(c);
        else bucket.byFile.set(c.file, [c]);
      }
    }
    const pairUp = (p: LocatedIdentity, c: LocatedIdentity, confidence: number): void => {
      priorMatched.add(p);
      currentMatched.add(c);
      taken.add(c);
      const pathChanged = !!(p.file && c.file && p.file !== c.file);
      pairs.push({
        priorId: p.id,
        currentId: c.id,
        status: pathChanged ? 'relocated' : 'persisted',
        confidence,
        reasons: [
          {
            code: 'content-hash',
            detail: pathChanged
              ? `content-hash match across rename: ${p.file ?? '?'} → ${c.file ?? '?'}`
              : 'content-hash match (surrounding code byte-identical after whitespace normalization)',
          },
        ],
      });
    };
    const takeFromFile = (bucket: ContentBucket, file: string): LocatedIdentity | undefined => {
      const files = bucket.byFile.get(file);
      while (files && files.length > 0) {
        const c = files.shift()!;
        if (!taken.has(c)) return c;
      }
      return undefined;
    };
    // Phase 1: same-file (git-rename-mapped first).
    for (const p of prior) {
      if (priorMatched.has(p)) continue;
      if (!p.contentHash || !p.rule || p.file === undefined) continue;
      const bucket = buckets.get(contentKey(p.rule, p.contentHash));
      if (!bucket) continue;
      const renamedTo = renames.get(p.file);
      const candidate =
        (renamedTo !== undefined ? takeFromFile(bucket, renamedTo) : undefined) ??
        takeFromFile(bucket, p.file);
      if (candidate) pairUp(p, candidate, CONFIDENCE_CONTENT_HASH_SAME_FILE);
    }
    // Phase 2: cross-file leftovers.
    for (const p of prior) {
      if (priorMatched.has(p)) continue;
      if (!p.contentHash || !p.rule) continue;
      const bucket = buckets.get(contentKey(p.rule, p.contentHash));
      if (!bucket) continue;
      let candidate: LocatedIdentity | undefined;
      while (bucket.order.length > 0) {
        const c = bucket.order.shift()!;
        if (!taken.has(c)) {
          candidate = c;
          break;
        }
      }
      if (candidate) pairUp(p, candidate, CONFIDENCE_CONTENT_HASH);
    }
  }

  // Pass 1.75 — modified-hunk endpoint pairing (#271). A located finding ON
  // a line the diff MODIFIED cannot relocate through the line map: a
  // modified line is a -/+ hunk pair with no image, so Pass 1 maps it to
  // null and the finding splits into removed + added — and the added side
  // false-blocks as net-new (Rule 19 cause #4, "the finding MOVED", read as
  // cause #1, "the developer introduced it"). Bites any bulk formatter or
  // codemod. Content hashes don't reach it either: the surrounding bytes
  // changed by definition. Here the two endpoints re-pair through the hunk
  // STRUCTURE: an unmatched prior finding inside a hunk's replaced span
  // pairs with an unmatched current finding of the SAME rule inside the
  // SAME hunk's new span — and ONLY when the pairing is unambiguous
  // (exactly one candidate on each side of that hunk+rule bucket). An
  // ambiguous or unmatched candidate stays split: bias hard toward false
  // NEGATIVE on the pairing, never invent a match. Pure deletions
  // (newCount 0) never pair — there is nothing on the other side.
  if (reachability.ok) {
    const priorsByFile = new Map<string, LocatedIdentity[]>();
    for (const p of prior) {
      if (priorMatched.has(p)) continue;
      if (!p.file || p.line === undefined || !p.rule) continue;
      const bucket = priorsByFile.get(p.file);
      if (bucket) bucket.push(p);
      else priorsByFile.set(p.file, [p]);
    }
    const currentsByFile = new Map<string, LocatedIdentity[]>();
    for (const c of current) {
      if (currentMatched.has(c)) continue;
      if (!c.file || c.line === undefined || !c.rule) continue;
      const bucket = currentsByFile.get(c.file);
      if (bucket) bucket.push(c);
      else currentsByFile.set(c.file, [c]);
    }
    for (const [file, priors] of priorsByFile) {
      const effectivePath = renames.get(file) ?? file;
      const pathChanged = effectivePath !== file;
      const currents = currentsByFile.get(effectivePath);
      if (!currents || currents.length === 0) continue;
      const diff = fetchFileDiff(opts.cwd, opts.baseSha, headSha, file, effectivePath);
      if (!diff || !diff.trim()) continue;
      // Replacement hunks only: a -/+ pair with both sides non-empty.
      const hunks = parseHunkSpans(diff).filter((h) => h.oldCount > 0 && h.newCount > 0);
      if (hunks.length === 0) continue;

      const bucketKey = (hunkIdx: number, rule: string): string => `${hunkIdx}\0${rule}`;
      const priorBuckets = new Map<string, LocatedIdentity[]>();
      for (const p of priors) {
        const idx = hunks.findIndex(
          (h) => p.line! >= h.oldStart && p.line! <= h.oldStart + h.oldCount - 1,
        );
        if (idx === -1) continue;
        const key = bucketKey(idx, p.rule!);
        const bucket = priorBuckets.get(key);
        if (bucket) bucket.push(p);
        else priorBuckets.set(key, [p]);
      }
      if (priorBuckets.size === 0) continue;
      const currentBuckets = new Map<string, LocatedIdentity[]>();
      for (const c of currents) {
        const idx = hunks.findIndex(
          (h) => c.line! >= h.newStart && c.line! <= h.newStart + h.newCount - 1,
        );
        if (idx === -1) continue;
        const key = bucketKey(idx, c.rule!);
        const bucket = currentBuckets.get(key);
        if (bucket) bucket.push(c);
        else currentBuckets.set(key, [c]);
      }

      for (const [key, ps] of priorBuckets) {
        const cs = currentBuckets.get(key);
        // The conservative 1:1: a singleton on BOTH sides, or no pair.
        if (!cs || ps.length !== 1 || cs.length !== 1) continue;
        const p = ps[0];
        const c = cs[0];
        priorMatched.add(p);
        currentMatched.add(c);
        const reasons: MatchReason[] = [
          {
            code: 'git-hunk-pair',
            detail:
              `finding sits on a MODIFIED line: git pairs ${p.file}:${p.line} with ` +
              `${c.file}:${c.line} through the same replacement hunk (same rule, ` +
              `unambiguous 1:1) — a modified line has no line-map image, so without ` +
              `this pass the pair reads as removed+added`,
          },
        ];
        if (pathChanged) {
          reasons.unshift({
            code: 'git-rename',
            detail: `file renamed: ${file} → ${effectivePath}`,
          });
        }
        pairs.push({
          priorId: p.id,
          currentId: c.id,
          status: pathChanged ? 'relocated' : 'persisted',
          confidence: CONFIDENCE_HUNK_PAIR,
          reasons,
        });
      }
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

/** Key for the whole-file rename pass: renamed path + the finding's
 *  kind (carried in `rule` by `entryToLocated`). The kind component
 *  stops two different whole-file kinds on one renamed file from
 *  cross-pairing. `rule` is always present for produced whole-file
 *  findings; the `?? ''` guards a hand-built identity that omits it. */
function wholeFileKey(file: string, rule: string | undefined): string {
  return `${file}\0${rule ?? ''}`;
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
