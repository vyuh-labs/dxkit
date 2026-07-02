/**
 * Flow configuration read from `.dxkit/policy.json:flow` — the single reader of
 * that section (Rule 2). Kept out of the shared `BrownfieldPolicy` schema (the
 * same way the loop preset is read separately): the flow concept stays
 * self-contained, and every flow surface — the `flow` CLI, the `flow refresh`
 * snapshot writer, and the guardrail gate pass — resolves its config here.
 *
 * All fields are optional in the file; a missing / malformed policy yields the
 * conservative defaults (fail-open), never a throw.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How the guardrail treats a net-new broken integration.
 *   - `block` (default): honor the per-finding verdict — an exact, fully
 *     specified binding fails the build; a low-confidence (placeholder-only)
 *     one warns.
 *   - `warn`: every net-new break warns, never fails a build (soft launch, or
 *     a repo still tuning its served-side inventory).
 *   - `off`: the gate does not run at all. */
export type FlowGateMode = 'block' | 'warn' | 'off';

export interface FlowConfig {
  /** Host-helper prefixes stripped during URL normalization (per-app config,
   *  e.g. `["https://api.example.com"]`). */
  readonly stripUrlPrefixes: string[];
  /** OpenAPI/spec files whose served routes union with static extraction. */
  readonly specs: string[];
  /** Guardrail posture for net-new broken integrations. */
  readonly mode: FlowGateMode;
  /** Confidence at/above which a net-new break BLOCKS (else warns). Default 1 —
   *  only exact, fully specified bindings can fail a build. */
  readonly blockThreshold: number;
}

const DEFAULTS: FlowConfig = {
  stripUrlPrefixes: [],
  specs: [],
  mode: 'block',
  blockThreshold: 1,
};

interface RawFlow {
  stripUrlPrefixes?: unknown;
  specs?: unknown;
  mode?: unknown;
  blockThreshold?: unknown;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function isMode(v: unknown): v is FlowGateMode {
  return v === 'block' || v === 'warn' || v === 'off';
}

/**
 * Read the `flow` section of `.dxkit/policy.json`. Fail-open — a read/parse
 * error, or an absent `flow` block, returns the defaults so a repo without flow
 * config behaves as "monorepo, block on exact net-new breaks".
 */
export function readFlowConfig(cwd: string): FlowConfig {
  let raw: RawFlow;
  try {
    const text = fs.readFileSync(path.join(cwd, '.dxkit', 'policy.json'), 'utf8');
    raw = ((JSON.parse(text) as { flow?: RawFlow })?.flow ?? {}) as RawFlow;
  } catch {
    return DEFAULTS;
  }
  return {
    stripUrlPrefixes: stringList(raw.stripUrlPrefixes),
    specs: stringList(raw.specs),
    mode: isMode(raw.mode) ? raw.mode : DEFAULTS.mode,
    blockThreshold:
      typeof raw.blockThreshold === 'number' && raw.blockThreshold > 0
        ? raw.blockThreshold
        : DEFAULTS.blockThreshold,
  };
}

/**
 * Write into `.dxkit/policy.json:flow`, merging the patch over the existing
 * `flow` block and PRESERVING every other policy section (loop, baseline, …) —
 * the same discipline `ensureLoopPreset` uses for `loop.preset`. This is the
 * single writer of the flow policy section (Rule 2), paired with the reader
 * above. Returns `true` if the file changed, `false` if it was already at the
 * target (idempotent) or could not be parsed (malformed policy is left
 * untouched — the caller reports it rather than clobbering hand-edits).
 */
export function writeFlowPolicy(
  cwd: string,
  patch: Partial<Pick<FlowConfig, 'mode' | 'stripUrlPrefixes' | 'specs'>>,
): boolean {
  const abs = path.join(cwd, '.dxkit', 'policy.json');
  let policy: { flow?: Record<string, unknown>; [k: string]: unknown } = {};
  if (fs.existsSync(abs)) {
    try {
      policy = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      return false; // malformed — leave it; caller surfaces the note
    }
  }
  const nextFlow = { ...(policy.flow ?? {}), ...patch };
  if (JSON.stringify(policy.flow ?? {}) === JSON.stringify(nextFlow)) return false;
  policy.flow = nextFlow;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  return true;
}
