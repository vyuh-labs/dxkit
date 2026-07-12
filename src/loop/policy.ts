/**
 * Loop policy resolution — how an autonomous loop picks its blocking
 * posture. The preset TABLE itself (what each posture blocks) lives in
 * `src/baseline/presets.ts`, shared with the zero-write trial
 * (`vyuh-dxkit evaluate`); this module owns the loop-scoped RESOLUTION:
 * which preset is active for a repo's unattended loop, read from
 * `DXKIT_LOOP_PRESET` / `.dxkit/policy.json:loop.preset`.
 *
 * The `loop.*` namespace in `.dxkit/policy.json` and the `Loop`-prefixed
 * names signal the boundary: the CI / PR guardrail (`vyuh-dxkit baseline
 * check`) and `createBaseline` resolve the shared `BrownfieldPolicy`
 * directly via `resolvePolicy` and NEVER read `loop.preset`, so setting a
 * preset changes how an unattended loop blocks WITHOUT silently
 * downgrading a repo's CI posture.
 */
import * as fs from 'fs';
import * as path from 'path';
import { type BrownfieldPolicy, DEFAULT_POLICY_FILENAME, resolvePolicy } from '../baseline/policy';
import {
  DEFAULT_LOOP_PRESET,
  isLoopPreset,
  type LoopPreset,
  policyForPreset,
} from '../baseline/presets';
import type { FlowGateMode } from '../analyzers/flow/config';
import type { SchemaGateMode } from '../analyzers/model-schema/config';
import type { DuplicationGateMode } from '../analyzers/duplication/config';

// Re-exported so existing consumers (stop-gate, scaffold, doctor, CLI) keep
// one import site for the loop posture vocabulary.
export { DEFAULT_LOOP_PRESET, type LoopPreset } from '../baseline/presets';

/** Resolved loop posture: the policy the Stop-gate hands to the guardrail,
 *  plus the preset name that produced it (recorded in the ledger) and the
 *  flow-gate mode the preset dictates (passed as the guardrail's `flowMode`). */
export interface ResolvedLoopPolicy {
  readonly policy: BrownfieldPolicy;
  readonly preset: LoopPreset;
  readonly flowMode: FlowGateMode;
  readonly schemaMode: SchemaGateMode;
  readonly duplicationMode: DuplicationGateMode;
}

/**
 * Read `loop.preset` from `.dxkit/policy.json`. Best-effort: a missing /
 * malformed file or absent `loop` block yields `undefined` so the caller
 * falls back to the default. Read here (not via `resolvePolicy`) so the
 * loop concept stays out of the shared `BrownfieldPolicy` schema.
 */
function readPresetFromPolicyFile(cwd: string): LoopPreset | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, DEFAULT_POLICY_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { loop?: { preset?: unknown } };
    const preset = parsed.loop?.preset;
    return isLoopPreset(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active loop preset. Precedence (mirrors the other
 * `DXKIT_LOOP_*` knobs the Stop-gate already honours):
 *   1. `DXKIT_LOOP_PRESET` env var (benchmark / CI override).
 *   2. `.dxkit/policy.json` → `loop.preset`.
 *   3. `DEFAULT_LOOP_PRESET` (`security-only`).
 */
export function resolveLoopPreset(cwd: string): LoopPreset {
  const env = process.env.DXKIT_LOOP_PRESET;
  if (isLoopPreset(env)) return env;
  return readPresetFromPolicyFile(cwd) ?? DEFAULT_LOOP_PRESET;
}

/** Read `loop.testCommand` from `.dxkit/policy.json`. Best-effort → undefined. */
function readTestCommandFromPolicyFile(cwd: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, DEFAULT_POLICY_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { loop?: { testCommand?: unknown } };
    const cmd = parsed.loop?.testCommand;
    return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the loop's postflight test command — the command the Stop-gate runs to
 * prove the change still passes the tests it affects. Precedence:
 *   1. `DXKIT_LOOP_TEST_COMMAND` env var (per-shell / CI override).
 *   2. `.dxkit/policy.json` → `loop.testCommand` (committed + reviewable).
 *   3. undefined (no postflight test command configured).
 *
 * The env var stays the override, but committing the command to policy makes it
 * durable: an env var is the easiest part of the loop config to silently lose
 * (per-shell, per-machine), which left the postflight test step quietly unset.
 */
export function resolveLoopTestCommand(cwd: string): string | undefined {
  const env = process.env.DXKIT_LOOP_TEST_COMMAND;
  if (typeof env === 'string' && env.trim().length > 0) return env;
  return readTestCommandFromPolicyFile(cwd);
}

/**
 * Build the loop-scoped policy: the repo's base `BrownfieldPolicy`
 * (confidence thresholds, baseline mode, drift handling preserved) with
 * its `block` list + `blockRules` REPLACED by the active preset's. Only
 * the Stop-gate calls this — see the scope note at the top of the file.
 */
export function resolveLoopPolicy(cwd: string): ResolvedLoopPolicy {
  const base = resolvePolicy(undefined, cwd);
  const preset = resolveLoopPreset(cwd);
  const applied = policyForPreset(preset, base);
  return {
    preset,
    flowMode: applied.flowMode,
    schemaMode: applied.schemaMode,
    duplicationMode: applied.duplicationMode,
    policy: applied.policy,
  };
}
