/**
 * The ONE merge-writer for `.dxkit/policy.json` (CLAUDE.md Rule 2). Every code
 * path that records configuration into the policy file — `configure --apply`,
 * the flow setup, the loop-preset seed, the anchor-transport persist — routes
 * its write through `mergeIntoPolicyFile` so the non-clobber discipline lives
 * in one place:
 *
 *   - existing keys are PRESERVED (deep merge; the patch only adds/overrides
 *     the keys it names),
 *   - a malformed existing file is never overwritten (reported, left intact),
 *   - the write is idempotent (byte-equal merge result → file untouched).
 *
 * Domain decisions (WHAT to write, whether an existing value should win) stay
 * with the callers — this module owns only the read-merge-write mechanics.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PolicyMergeOutcome {
  readonly changed: boolean;
  /** Why nothing was written when `changed` is false. */
  readonly reason?: 'no-change' | 'malformed-policy';
}

/** True for a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `patch` over `base`, returning a NEW object. Nested plain
 * objects merge key-by-key (so a patch that sets `flow.mode` preserves a
 * sibling `flow.specs`); arrays and primitives are replaced by the patch value.
 * Deterministic and pure over its inputs.
 */
export function deepMergePolicy(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = out[key];
    out[key] =
      isPlainObject(baseVal) && isPlainObject(patchVal)
        ? deepMergePolicy(baseVal, patchVal)
        : patchVal;
  }
  return out;
}

/** Best-effort parse of the existing policy file. `{}` when absent; `null`
 *  when present but malformed (the caller must not overwrite it). */
export function readPolicyFileRaw(cwd: string): Record<string, unknown> | null {
  const abs = path.join(cwd, '.dxkit', 'policy.json');
  if (!fs.existsSync(abs)) return {};
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Deep-merge `patch` into `.dxkit/policy.json`, preserving every existing key.
 * Creates the file (and `.dxkit/`) when absent. Refuses to touch a malformed
 * existing file. Returns whether the file changed.
 */
export function mergeIntoPolicyFile(
  cwd: string,
  patch: Record<string, unknown>,
): PolicyMergeOutcome {
  const policy = readPolicyFileRaw(cwd);
  if (policy === null) return { changed: false, reason: 'malformed-policy' };

  const merged = deepMergePolicy(policy, patch);
  if (JSON.stringify(policy) === JSON.stringify(merged)) {
    return { changed: false, reason: 'no-change' };
  }

  const abs = path.join(cwd, '.dxkit', 'policy.json');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return { changed: true };
}
