/**
 * Structural-duplicate (seam) gate configuration, read from
 * `.dxkit/policy.json:duplication` — the single reader of that section (Rule 2,
 * the flow/schema-config discipline). Every duplicate-seam surface — the
 * two-ref gate, `evaluate`, doctor's probe — resolves its config here.
 *
 * All fields are optional in the file; a missing / malformed policy yields the
 * defaults (fail-open), never a throw. The default MODE is `off`: the gate runs
 * a graph build, which is the heaviest thing dxkit does, so — like the schema
 * gate and UNLIKE the cheap flow gate — it is strictly opt-in. A repo that never
 * configured it spawns no graphify. `evaluate` forces it on to demonstrate the
 * signal on a trial run; a repo promotes it to `warn` (and, via convergence,
 * effectively `block`) when it wants the gate live.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DUP_DEFAULT_MIN_SCORE } from './detect';

/** How the guardrail treats a net-new structural duplicate.
 *   - `block`: enables seam CONVERGENCE to escalate a duplicate that is ALSO a
 *     reliably-dead surface to a build failure. A lone duplicate never blocks —
 *     tier-3's precision floor is warn (the anti-slop proof).
 *   - `warn`: every net-new duplicate warns, never fails a build.
 *   - `off` (default): the gate does not run at all (no graph build). */
export type DuplicationGateMode = 'block' | 'warn' | 'off';

export interface DuplicationConfig {
  /** Guardrail posture for a net-new structural duplicate. */
  readonly mode: DuplicationGateMode;
  /** Blended structural-similarity at/above which a pair is reported. Default
   *  `DUP_DEFAULT_MIN_SCORE` — the proof's precision floor. Raising it trades
   *  recall for precision on a noisy repo. */
  readonly minScore: number;
}

const DEFAULTS: DuplicationConfig = {
  mode: 'off',
  minScore: DUP_DEFAULT_MIN_SCORE,
};

/** Current schema version of the committed `.dxkit/policy.json:duplication`
 *  block. Stamped on write so a future restructure is detectable/migratable
 *  (a versionless block reads as v1 — every field optional-with-default). */
export const DUPLICATION_CONFIG_SCHEMA_VERSION = 1;

interface RawDuplication {
  mode?: unknown;
  minScore?: unknown;
}

function isMode(v: unknown): v is DuplicationGateMode {
  return v === 'block' || v === 'warn' || v === 'off';
}

function rawSection(cwd: string): RawDuplication | undefined {
  try {
    const text = fs.readFileSync(path.join(cwd, '.dxkit', 'policy.json'), 'utf8');
    return (JSON.parse(text) as { duplication?: RawDuplication })?.duplication;
  } catch {
    return undefined;
  }
}

/** Read the `duplication` section of `.dxkit/policy.json`. Fail-open — a
 *  read/parse error or an absent block returns the defaults (gate off). */
export function readDuplicationConfig(cwd: string): DuplicationConfig {
  const raw = rawSection(cwd) ?? {};
  return {
    mode: isMode(raw.mode) ? raw.mode : DEFAULTS.mode,
    minScore:
      typeof raw.minScore === 'number' && raw.minScore > 0 && raw.minScore <= 1
        ? raw.minScore
        : DEFAULTS.minScore,
  };
}
