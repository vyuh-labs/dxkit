/**
 * The ONE merge-writer for `.dxkit/policy.json` (CLAUDE.md Rule 2). Every code
 * path that records configuration into the policy file — `configure --apply`,
 * the flow setup, the loop-preset seed, the anchor-transport persist — routes
 * its write through `mergeIntoPolicyFile` so the non-clobber discipline lives
 * in one place:
 *
 *   - existing keys are PRESERVED (deep merge; the patch only adds/overrides
 *     the keys it names),
 *   - existing COMMENTS and formatting are PRESERVED (the policy file is
 *     JSONC and the user's file teaches through comments — edits go through
 *     `jsonc-parser`'s `modify`/`applyEdits`, never parse→stringify, which
 *     would strip every comment on first touch),
 *   - a malformed existing file is never overwritten (reported, left intact),
 *   - the write is idempotent (byte-equal result → file untouched).
 *
 * Domain decisions (WHAT to write, whether an existing value should win) stay
 * with the callers — this module owns only the read-merge-write mechanics.
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyEdits, modify } from 'jsonc-parser';
import { policyPathFor, readPolicyRoot } from './policy-text';

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
  const read = readPolicyRoot(policyPathFor(cwd));
  if (read.status === 'absent') return {};
  return read.status === 'ok' ? read.value : null;
}

/**
 * Create-only write of a freshly rendered policy scaffold. Refuses when a
 * policy file already exists — every mutation of an existing file goes through
 * the comment-preserving merge-writer below, never a whole-file overwrite.
 */
export function writeNewPolicyFile(cwd: string, text: string): boolean {
  const abs = policyPathFor(cwd);
  if (fs.existsSync(abs)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return true;
}

/** One leaf edit the deep-merge decomposes into: set `value` at `pathSegs`. */
interface LeafEdit {
  readonly pathSegs: readonly string[];
  readonly value: unknown;
}

/**
 * Decompose `patch` into the leaf edits the deep-merge semantics imply:
 * descend while BOTH sides are plain objects (those merge key-by-key); at the
 * first level where they don't, the patch value replaces wholesale. Edits
 * whose value already equals the base value are dropped (idempotence — an
 * unchanged key must not disturb the file's text around it).
 */
function collectLeafEdits(
  base: unknown,
  patch: Record<string, unknown>,
  prefix: readonly string[],
  out: LeafEdit[],
): void {
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = isPlainObject(base) ? base[key] : undefined;
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      collectLeafEdits(baseVal, patchVal, [...prefix, key], out);
    } else if (JSON.stringify(baseVal) !== JSON.stringify(patchVal)) {
      out.push({ pathSegs: [...prefix, key], value: patchVal });
    }
  }
}

const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/**
 * Deep-merge `patch` into `.dxkit/policy.json`, preserving every existing key,
 * comment, and formatting choice. Creates the file (and `.dxkit/`) when
 * absent. Refuses to touch a malformed existing file. Returns whether the
 * file changed.
 */
export function mergeIntoPolicyFile(
  cwd: string,
  patch: Record<string, unknown>,
): PolicyMergeOutcome {
  const abs = policyPathFor(cwd);
  const read = readPolicyRoot(abs);
  if (read.status === 'malformed') return { changed: false, reason: 'malformed-policy' };

  if (read.status === 'absent') {
    const merged = deepMergePolicy({}, patch);
    if (Object.keys(merged).length === 0) return { changed: false, reason: 'no-change' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return { changed: true };
  }

  const edits: LeafEdit[] = [];
  collectLeafEdits(read.value, patch, [], edits);
  if (edits.length === 0) return { changed: false, reason: 'no-change' };

  let text = read.text;
  for (const edit of edits) {
    text = applyEdits(
      text,
      modify(text, edit.pathSegs as string[], edit.value, { formattingOptions: JSONC_FORMAT }),
    );
  }
  if (!text.endsWith('\n')) text += '\n';
  if (text === read.text) return { changed: false, reason: 'no-change' };

  fs.writeFileSync(abs, text, 'utf8');
  return { changed: true };
}
