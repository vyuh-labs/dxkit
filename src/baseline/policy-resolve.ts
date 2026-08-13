/**
 * Policy RESOLUTION — the one path from "what the repo/caller declared"
 * to the `BrownfieldPolicy` every surface judges under (split from
 * `policy.ts` at the large-file bar, re-exported there so
 * `from './policy'` stays the single import surface).
 *
 * Resolution order (shared by `createBaseline`, `runGuardrailCheck`,
 * and the gate CLI):
 *
 *   1. `policyPath` (explicit `--policy <p>` flag). Errors if the path
 *      is supplied but unreadable / malformed.
 *   2. `<cwd>/.dxkit/policy.json` (conventional). Silently skipped when
 *      absent so consumers without a policy get the defaults.
 *   3. `fallback` — `DEFAULT_BROWNFIELD_POLICY` unless the surface
 *      declares a different no-policy posture (the tree gate passes the
 *      security-only preset: under a fresh prior EVERY finding is
 *      net-new, so the fully armed compiled default would block any
 *      real tree on test-gap/quality debt no DoD ever asked about).
 *
 * A policy FILE merges over its DECLARED base (WP1b, strategy §7.2):
 * `"extends": "security-only" | "full-debt" | "default"` names the
 * posture the file refines. Absent ⟹ `"default"` — the fully armed
 * compiled default, the pre-4.4.1 behavior, kept so existing files
 * resolve byte-identically. This closes the activation asymmetry an
 * embedder hit live: a MINIMAL explicit file silently armed test-gap
 * blocking because the only reachable base was the compiled default;
 * now a one-line `"extends": "security-only"` pins the intended posture
 * and the scaffold writes it explicitly.
 *
 * Customer fields shallow-merge over the base. The `confidence` /
 * `blockRules` blocks deep-merge by key. Unknown fields are preserved —
 * the classifier ignores what it doesn't know, so forward-compatible
 * policy files don't break old dxkit. (`extends` itself is validated
 * strictly: a typo'd base silently resolving to fully-armed would
 * re-open the exact class this field closes, so it throws.)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_BROWNFIELD_POLICY,
  DEFAULT_POLICY_FILENAME,
  type BrownfieldPolicy,
} from './policy';
import { isLoopPreset, policyForPreset } from './presets';
import { readPolicyRoot } from './policy-text';

/** The vocabulary a policy file's `extends` accepts: a preset name, or
 *  `'default'` (the fully armed compiled default — what an extends-less
 *  file has always merged over). */
export const POLICY_BASE_TOKENS = ['security-only', 'full-debt', 'default'] as const;
export type PolicyBaseToken = (typeof POLICY_BASE_TOKENS)[number];

/** Resolve a file's declared base to the policy it merges over. Strict:
 *  an unknown token throws (never a silent fully-armed fallback). */
export function policyBaseFor(token: unknown, source: string): BrownfieldPolicy {
  if (token === undefined || token === 'default') return DEFAULT_BROWNFIELD_POLICY;
  if (typeof token === 'string' && isLoopPreset(token)) {
    return policyForPreset(token, DEFAULT_BROWNFIELD_POLICY).policy;
  }
  throw new Error(
    `policy "extends" names an unknown base: ${JSON.stringify(token)} (${source}). ` +
      `Known bases: ${POLICY_BASE_TOKENS.join(', ')}. A typo here would silently change ` +
      `which rules are armed, so it is an error rather than a fallback.`,
  );
}

export function resolvePolicy(
  policyPath: string | undefined,
  cwd: string,
  fallback: BrownfieldPolicy = DEFAULT_BROWNFIELD_POLICY,
): BrownfieldPolicy {
  let resolvedPath: string | undefined = policyPath;
  if (!resolvedPath) {
    const conventional = path.join(cwd, DEFAULT_POLICY_FILENAME);
    if (fs.existsSync(conventional)) resolvedPath = conventional;
  }
  if (!resolvedPath) return fallback;
  const read = readPolicyRoot(resolvedPath);
  if (read.status === 'absent') {
    // Only reachable via an explicit `--policy <p>` pointing at a missing file
    // (the conventional path is existence-checked above).
    throw new Error(`policy file not readable: ${resolvedPath} (no such file)`);
  }
  if (read.status === 'malformed') {
    throw new Error(`policy file is not valid JSON/JSONC: ${resolvedPath} (${read.error})`);
  }
  const obj = read.value as Partial<BrownfieldPolicy>;
  const base = policyBaseFor(obj.extends, resolvedPath);
  return {
    ...base,
    ...obj,
    confidence: { ...base.confidence, ...(obj.confidence ?? {}) },
    blockRules: { ...base.blockRules, ...(obj.blockRules ?? {}) },
    block: obj.block ?? base.block,
    warn: obj.warn ?? base.warn,
    addedRequiresChangedLines: obj.addedRequiresChangedLines ?? base.addedRequiresChangedLines,
    // A non-positive / non-finite / non-number JSON value is ignored so a
    // malformed policy silently falls back to the canonical default rather than
    // disabling the large-file signal (e.g. threshold 0 → everything flagged).
    largeFileThreshold: normalizeLargeFileThreshold(obj.largeFileThreshold),
    mode: 'brownfield',
  };
}

/** Accept only a positive, finite number as an override; anything else → unset
 *  (the producer then falls back to `LARGE_FILE_THRESHOLD_LINES`). */
function normalizeLargeFileThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Convenience wrapper for callers that don't take a `--policy`
 * override (e.g., `createBaseline`). Loads the conventional file if
 * present; returns defaults otherwise.
 */
export function loadPolicyFromCwd(cwd: string): BrownfieldPolicy {
  return resolvePolicy(undefined, cwd);
}
