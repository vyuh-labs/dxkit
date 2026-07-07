/**
 * The guardrail verdict cache — one recent verdict, replayable within a session.
 *
 * A single feature session runs the guardrail three times over the SAME tree:
 * the `dxkit-feature` verify step, the pre-push hook, and the `dxkit-pr` receipt.
 * Each gather is ~25s, so two of the three are pure waste. This cache lets a
 * consumer (today: `receipt`) replay the last verdict when the tree it would
 * scan is byte-for-byte identical and the policy is unchanged — and re-run only
 * when something actually moved.
 *
 * The key is deliberately conservative, reusing the loop Stop-gate's
 * content-complete `workingTreeSignature` (HEAD + base ref + every tracked and
 * untracked change, hashed): a cache HIT is only ever a genuinely-identical tree,
 * so a replay can NEVER hide a net-new finding. The policy is hashed too, so
 * tightening `.dxkit/policy.json` invalidates a stale pass. A miss on either =
 * re-gather. The cache lives under `.dxkit/cache/` (gitignored, regenerated), so
 * it is never committed and never a source of drift.
 *
 * Best-effort throughout: a read/write failure degrades to "no cache" (re-run),
 * never an error — the verdict is always recomputable.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { workingTreeSignature } from '../loop/gate-cache';
import type { BrownfieldPolicy } from './policy';

const CACHE_REL = path.join('.dxkit', 'cache', 'verdict.json');

/** A replayable verdict. Stores the rendered signals markdown + the summary
 *  fields a `--json` consumer needs, keyed on the tree signature + policy hash
 *  it was computed under. */
export interface CachedVerdict {
  /** `workingTreeSignature` at cache time — the freshness key. */
  readonly signature: string;
  /** Hash of the resolved policy — a policy change invalidates the pass. */
  readonly policyHash: string;
  readonly blocks: boolean;
  readonly warns: boolean;
  readonly blockingCount: number;
  readonly warningCount: number;
  /** The rendered "## dxkit signals" markdown (verdict + allowlist delta). */
  readonly markdown: string;
  /** ISO timestamp of the run this verdict came from. */
  readonly ranAt: string;
}

/** Stable hash of the resolved policy — the block/warn severity routing that
 *  decides the verdict. A policy edit must not silently reuse a pass computed
 *  under the old routing. */
export function policyHash(policy: BrownfieldPolicy): string {
  // Not a finding identity — a cache-invalidation key for the verdict replay
  // (a policy edit must invalidate a pass computed under the old routing).
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16); // fingerprint-helper-ok
}

/**
 * The fresh cached verdict, or null. "Fresh" means BOTH the working-tree
 * signature AND the policy hash still match — anything else (stale tree, changed
 * policy, no cache, unreadable file, non-git repo) returns null so the caller
 * re-gathers. Never throws.
 */
export function readFreshVerdict(cwd: string, policy: BrownfieldPolicy): CachedVerdict | null {
  const sig = workingTreeSignature(cwd);
  if (!sig) return null; // not a git repo / no commit → never replay
  let parsed: CachedVerdict;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, CACHE_REL), 'utf8')) as CachedVerdict;
  } catch {
    return null;
  }
  if (typeof parsed.signature !== 'string' || typeof parsed.markdown !== 'string') return null;
  if (parsed.signature !== sig) return null; // tree moved
  if (parsed.policyHash !== policyHash(policy)) return null; // policy changed
  return parsed;
}

/**
 * Persist a verdict for later replay. Best-effort: a write failure (read-only
 * FS, no `.dxkit`) is swallowed — caching must never break the check that
 * produced the verdict. `signature` is recomputed here from the same tree the
 * check just scanned; if it can't be computed (non-git), nothing is written.
 */
export function writeVerdict(
  cwd: string,
  policy: BrownfieldPolicy,
  fields: Omit<CachedVerdict, 'signature' | 'policyHash'>,
): void {
  try {
    const sig = workingTreeSignature(cwd);
    if (!sig) return;
    const entry: CachedVerdict = { ...fields, signature: sig, policyHash: policyHash(policy) };
    const abs = path.join(cwd, CACHE_REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort — a cache write must never break the guardrail */
  }
}
