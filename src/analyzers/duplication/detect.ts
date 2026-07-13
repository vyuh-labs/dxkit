/**
 * The structural-duplicate detector — pure, deterministic scoring over
 * per-function callee signatures (`FunctionSignature[]` from `./signatures.ts`,
 * read from dxkit's own AST). Two functions are structural duplicates when they
 * call the same set of things and share name tokens; the blended Jaccard survives
 * rename and reformat (unlike token duplication), which is the whole point of the
 * seam signal.
 *
 * Moved out of `src/explore/queries.ts`: it no longer traverses the code graph
 * (Rule 12), so it is no longer a graph query. The callee set now comes from the
 * AST, which includes framework calls graphify drops — restoring the dynamic
 * range that made framework handlers coincidentally score 1.00.
 */
import type { FunctionSignature } from './signatures';

// The similarity score IS the structural (callee-set) overlap — that is what a
// "duplicate" means: two functions that call the same things. A shared NAME is
// NOT part of the score, because it's mostly convention (parallel `GET` handlers
// / `load` screens share names without being copies) and, symmetrically, a
// RENAMED copy shares its whole structure without the name — it must still read
// as the near-identical copy it is. Name is used only as a ranking tiebreak.
/** Minimum callee-set size for a function to carry a structural signal — below
 *  this a match is too thin to trust. */
export const DUP_MIN_CALLEES = 3;
/** Default report threshold on the structural-similarity score. */
export const DUP_DEFAULT_MIN_SCORE = 0.5;
/** Confidence tier: at or above this structural similarity the two functions are
 *  a near-identical copy (a "verified" copy-paste) — the tier a surface leads on,
 *  separate from the softer "similar structure" band below it. Keyed on
 *  STRUCTURE, so a renamed copy (identical callees, different name) is verified. */
export const VERIFIED_DUP_MIN_SCORE = 0.9;

export interface DuplicatePair {
  readonly a: FunctionSignature;
  readonly b: FunctionSignature;
  readonly score: number;
  readonly calleeJaccard: number;
  readonly nameJaccard: number;
}

export interface DuplicateDetectOpts {
  /** Structural-signal floor (default `DUP_MIN_CALLEES`). */
  readonly minCallees?: number;
  /** Report threshold on the blended score (default `DUP_DEFAULT_MIN_SCORE`). */
  readonly minScore?: number;
  /** When present, a pair is only emitted if AT LEAST ONE side's file is in this
   *  set — the gate's diff-scoping ("what did THIS change duplicate?") pushed
   *  into the detector so a large repo never scores the full O(pairs) product. */
  readonly focusFiles?: ReadonlySet<string>;
}

/** Split a symbol name into lowercased identifier tokens (camelCase / snake /
 *  dotted), dropping single-char noise. `getDivisions` → {get, divisions}. */
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

/** Plain Jaccard overlap of two sets — |A∩B| / |A∪B|. Used for name tokens. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * IDF-WEIGHTED Jaccard over callee sets. A callee's weight is its inverse
 * document frequency across the corpus, so a call EVERY function makes (`auth`,
 * `json`, a framework error handler) carries almost no signal, while a call few
 * functions make (`getDivisions`) dominates. This is the load-bearing precision
 * mechanism: two handlers that share only the framework skeleton but call
 * DIFFERENT data functions score low (the discriminating callees sit in the
 * union, not the intersection), while a true copy — identical callee set —
 * scores 1.0 regardless of weights. Returns 0 when the union carries no weight
 * (both functions call only ubiquitous helpers → no discriminating signal).
 */
function weightedCalleeJaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
  weight: ReadonlyMap<string, number>,
): number {
  let inter = 0;
  let union = 0;
  const seen = new Set<string>();
  for (const c of a) {
    const w = weight.get(c) ?? 0;
    union += w;
    seen.add(c);
    if (b.has(c)) inter += w;
  }
  for (const c of b) {
    if (seen.has(c)) continue;
    union += weight.get(c) ?? 0;
  }
  return union === 0 ? 0 : inter / union;
}

interface Feature {
  readonly sig: FunctionSignature;
  readonly callees: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
}

/**
 * Rank candidate structural-duplicate pairs across a set of function
 * signatures. Pure, near-linear (inverted index over shared callees so only
 * pairs sharing ≥1 callee are ever scored). Sorted by descending score, then by
 * larger callee-set (a more-evidenced match ranks first).
 */
export function duplicatePairs(
  signatures: readonly FunctionSignature[],
  opts: DuplicateDetectOpts = {},
): DuplicatePair[] {
  const minCallees = opts.minCallees ?? DUP_MIN_CALLEES;
  const minScore = opts.minScore ?? DUP_DEFAULT_MIN_SCORE;
  const focus = opts.focusFiles;

  const feats: Feature[] = [];
  for (const sig of signatures) {
    if (sig.callees.size < minCallees) continue;
    feats.push({ sig, callees: sig.callees, tokens: tokenize(sig.name) });
  }
  const n = feats.length;

  // Document frequency of each callee, and its IDF weight. A callee in every
  // function has df=n → idf=0 (no signal); a callee in few has a high weight.
  const df = new Map<string, number>();
  for (const f of feats) for (const c of f.callees) df.set(c, (df.get(c) ?? 0) + 1);
  // SMOOTHED idf — `log(1 + n/df)`, not `log(n/df)`. A callee in EVERY function
  // (df = n) still carries a little weight (log 2) rather than collapsing to 0,
  // which matters only in a tiny corpus of near-copies (where every callee is
  // ubiquitous); at real repo sizes df ≪ n for a discriminating call, so this is
  // effectively the same down-weighting of framework scaffolding.
  const idf = new Map<string, number>();
  for (const [c, d] of df) idf.set(c, Math.log(1 + n / d));

  // Inverted index callee → [featIndex,…] so we only score pairs that share a
  // callee. Only DISCRIMINATING callees are join keys: a callee shared by a
  // large fraction of functions (framework scaffolding) creates a huge bucket
  // that is all noise AND blows up the pair count on a big repo — a real copy
  // always also shares a rarer callee, so it is still paired. This bound keeps
  // the pass near-linear at scale.
  const joinKeyMaxDf = Math.max(minCallees, Math.floor(n * 0.2));
  const inv = new Map<string, number[]>();
  for (let i = 0; i < feats.length; i++) {
    for (const c of feats[i].callees) {
      if ((df.get(c) ?? 0) > joinKeyMaxDf) continue; // scaffolding — not a join key
      const bucket = inv.get(c);
      if (bucket) bucket.push(i);
      else inv.set(c, [i]);
    }
  }

  const seen = new Set<string>();
  const pairs: DuplicatePair[] = [];
  for (const idxs of inv.values()) {
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const [x, y] = idxs[i] < idxs[j] ? [idxs[i], idxs[j]] : [idxs[j], idxs[i]];
        const key = `${x}\0${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fa = feats[x];
        const fb = feats[y];
        // Diff-scope: at least one side must touch a changed file, when scoped.
        if (focus && !focus.has(fa.sig.file) && !focus.has(fb.sig.file)) continue;
        const calleeJaccard = weightedCalleeJaccard(fa.callees, fb.callees, idf);
        // The score is the STRUCTURAL similarity; name is not part of it.
        if (calleeJaccard < minScore) continue;
        const nameJaccard = jaccard(fa.tokens, fb.tokens);
        pairs.push({ a: fa.sig, b: fb.sig, score: calleeJaccard, calleeJaccard, nameJaccard });
      }
    }
  }
  // Rank by structural similarity, then break ties with the NAME overlap (a
  // same-named copy ranks above a renamed one at equal structure), then by the
  // larger, more-evidenced callee set.
  pairs.sort(
    (p, q) =>
      q.score - p.score ||
      q.nameJaccard - p.nameJaccard ||
      q.a.callees.size + q.b.callees.size - (p.a.callees.size + p.b.callees.size),
  );
  return pairs;
}
