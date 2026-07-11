/**
 * Loop policy presets — a curated blocking posture scoped to autonomous
 * coding loops ONLY.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  SCOPE: this layer is read by exactly one consumer — the Stop-gate
 *  (`src/loop/stop-gate.ts`). The CI / PR guardrail (`vyuh-dxkit baseline
 *  check`) and `createBaseline` resolve the shared `BrownfieldPolicy`
 *  directly via `resolvePolicy` and NEVER read `loop.preset`. So setting a
 *  preset changes how an unattended loop blocks WITHOUT silently
 *  downgrading a repo's CI posture. The `loop.*` namespace in
 *  `.dxkit/policy.json` and the `Loop`-prefixed names here both signal
 *  that boundary.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Why a loop-only posture exists: in CI a guardrail block just fails a
 * check a human then reads — blocking on every debt class (test-gap,
 * quality) is fine. In a loop a block instead FEEDS THE MODEL a repair
 * instruction, so blocking on open-ended debt makes the agent grind on it
 * unattended (writing tests / refactoring until the gap closes), which is
 * expensive and unbounded. The default loop posture therefore blocks only
 * on the unambiguous, must-fix security class; the open-ended debt classes
 * are an explicit opt-in.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  type BrownfieldBlockRules,
  type BrownfieldPolicy,
  DEFAULT_POLICY_FILENAME,
  resolvePolicy,
} from '../baseline/policy';
import type { FindingStatus } from '../baseline/types';
import type { FlowGateMode } from '../analyzers/flow/config';
import type { SchemaGateMode } from '../analyzers/model-schema/config';

/**
 * The two shipped loop postures.
 *   - `security-only` (default): block only on net-new secrets + crit/high
 *     security + crit/high reachable dependency vulns. test-gap + quality
 *     are NOT blocked — they warn. Cost-bounded; safe to run unattended.
 *   - `full-debt`: block on every net-new finding (adds test-gap +
 *     quality). Exhaustive but can drive an open-ended repair; opt-in.
 */
export type LoopPreset = 'security-only' | 'full-debt';

/** The cost-bounded default — the posture an unattended loop gets unless
 *  the repo explicitly opts into `full-debt`. */
export const DEFAULT_LOOP_PRESET: LoopPreset = 'security-only';

interface PresetDef {
  /**
   * Generic block list (statuses that fail regardless of kind).
   * `security-only` leaves this EMPTY so a net-new test-gap / quality
   * finding (status `added`) does not auto-block; blocking is driven
   * entirely by the security `blockRules` below.
   */
  readonly block: ReadonlyArray<FindingStatus>;
  /** Per-kind escalation rules (see `BrownfieldBlockRules`). */
  readonly blockRules: BrownfieldBlockRules;
  /**
   * Posture for the flow integration gate. `security-only` WARNS on a net-new
   * broken integration (like test-gap / quality — it isn't a security class,
   * and a cross-repo integration false positive must never wedge an unattended
   * loop); `full-debt` BLOCKS on it. Both keep the gate's own confidence gating
   * (only exact bindings can block even under `block`).
   */
  readonly flowMode: FlowGateMode;
  /**
   * Posture for the model-schema drift gate — same reasoning as `flowMode`
   * (a contract-drift false positive must never wedge an unattended loop).
   * The guardrail applies it only when the repo has ENABLED the gate:
   * schema defaults to off, and a loop preset never activates it.
   */
  readonly schemaMode: SchemaGateMode;
}

/** The security class: secrets, crit/high SAST, crit/high reachable dep
 *  vulns. Shared by both presets — full-debt is this plus the debt rules. */
const SECURITY_BLOCK_RULES: BrownfieldBlockRules = {
  newSecret: true,
  newCriticalSecurity: true,
  newHighSecurity: true,
  newCriticalDependencyVulnerability: true,
  newHighReachableDependencyVulnerability: true,
  // Open-ended debt — OFF in security-only (warn, never block in a loop).
  newUntestedChangedSource: false,
  newSevereQualityIssueInChangedFiles: false,
};

const PRESETS: Readonly<Record<LoopPreset, PresetDef>> = Object.freeze({
  'security-only': {
    // Empty generic block list: nothing auto-blocks by status alone, so
    // test-gap + quality net-new findings warn but never block the loop.
    // Blocking comes solely from SECURITY_BLOCK_RULES.
    block: [],
    blockRules: SECURITY_BLOCK_RULES,
    flowMode: 'warn',
    schemaMode: 'warn',
  },
  'full-debt': {
    // Any net-new finding blocks (generic `added`), plus every escalation.
    block: ['added'],
    blockRules: {
      ...SECURITY_BLOCK_RULES,
      newUntestedChangedSource: true,
      newSevereQualityIssueInChangedFiles: true,
    },
    flowMode: 'block',
    schemaMode: 'block',
  },
});

/** Resolved loop posture: the policy the Stop-gate hands to the guardrail,
 *  plus the preset name that produced it (recorded in the ledger) and the
 *  flow-gate mode the preset dictates (passed as the guardrail's `flowMode`). */
export interface ResolvedLoopPolicy {
  readonly policy: BrownfieldPolicy;
  readonly preset: LoopPreset;
  readonly flowMode: FlowGateMode;
  readonly schemaMode: SchemaGateMode;
}

function isLoopPreset(v: unknown): v is LoopPreset {
  return v === 'security-only' || v === 'full-debt';
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
  const def = PRESETS[preset];
  return {
    preset,
    flowMode: def.flowMode,
    schemaMode: def.schemaMode,
    policy: {
      ...base,
      block: def.block,
      blockRules: def.blockRules,
    },
  };
}
