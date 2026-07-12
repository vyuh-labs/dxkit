/**
 * Gate posture presets — the two shipped blocking postures, shared by the
 * surfaces that inject a preset-scoped policy into the guardrail instead of
 * (or on top of) the repo's committed `.dxkit/policy.json`.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  SCOPE: exactly two consumers read this table.
 *    1. The loop Stop-gate, via `src/loop/policy.ts:resolveLoopPolicy` —
 *       an unattended loop's posture, resolved from `loop.preset` /
 *       `DXKIT_LOOP_PRESET`.
 *    2. The zero-write trial, via `src/evaluate/run.ts` — `vyuh-dxkit
 *       evaluate --preset <p>` replays history under a named posture on a
 *       repo that may have no dxkit config at all.
 *  The CI / PR guardrail (`vyuh-dxkit baseline check`) and `createBaseline`
 *  resolve the shared `BrownfieldPolicy` directly via `resolvePolicy` and
 *  never read a preset, so a preset changes how a loop or a trial blocks
 *  WITHOUT silently downgrading a repo's CI posture.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Why a curated posture exists: in CI a guardrail block just fails a check
 * a human then reads — blocking on every debt class (test-gap, quality) is
 * fine. In a loop a block FEEDS THE MODEL a repair instruction, so blocking
 * on open-ended debt makes the agent grind on it unattended. The default
 * posture therefore blocks only on the unambiguous, must-fix security
 * class; the open-ended debt classes are an explicit opt-in.
 */
import { type BrownfieldBlockRules, type BrownfieldPolicy } from './policy';
import type { FindingStatus } from './types';
import type { FlowGateMode } from '../analyzers/flow/config';
import type { SchemaGateMode } from '../analyzers/model-schema/config';
import type { DuplicationGateMode } from '../analyzers/duplication/config';

/**
 * The two shipped postures.
 *   - `security-only` (default): block only on net-new secrets + crit/high
 *     security + crit/high reachable dependency vulns. test-gap + quality
 *     are NOT blocked — they warn. Cost-bounded; safe to run unattended.
 *   - `full-debt`: block on every net-new finding (adds test-gap +
 *     quality). Exhaustive but can drive an open-ended repair; opt-in.
 */
export type LoopPreset = 'security-only' | 'full-debt';

/** The cost-bounded default — the posture a loop or a trial gets unless the
 *  caller explicitly opts into `full-debt`. */
export const DEFAULT_LOOP_PRESET: LoopPreset = 'security-only';

export function isLoopPreset(v: unknown): v is LoopPreset {
  return v === 'security-only' || v === 'full-debt';
}

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
   * Posture for the flow integration gate. `security-only` WARNS on a
   * net-new broken integration (like test-gap / quality — it isn't a
   * security class, and a cross-repo integration false positive must never
   * wedge an unattended run); `full-debt` BLOCKS on it. Both keep the
   * gate's own confidence gating (only exact bindings can block even under
   * `block`).
   */
  readonly flowMode: FlowGateMode;
  /**
   * Posture for the model-schema drift gate — same reasoning as `flowMode`.
   * The guardrail applies it only when the repo has ENABLED the gate:
   * schema defaults to off, and a preset never activates it.
   */
  readonly schemaMode: SchemaGateMode;
  /**
   * Posture for the structural-duplicate (seam) gate — same opt-in reasoning
   * as `schemaMode`: the gate defaults to off (it builds the code graph), and a
   * preset only softens/hardens an already-enabled gate. `security-only` WARNS
   * (a duplicate is a maintainability signal, never a security class, and must
   * not wedge an unattended run); `full-debt` authorizes convergence to BLOCK.
   */
  readonly duplicationMode: DuplicationGateMode;
  /**
   * Statuses ADDED to the base policy's warn list (union, never a
   * replacement — the base's drift/uncertainty warns always survive).
   * `security-only` adds `added` so a net-new finding its block rules do
   * not escalate (a high dep vuln without a reachability signal, a
   * quality issue) is still REPORTED as a warning instead of passing
   * silently — the gap a real supply-chain-incident replay exposed.
   * `full-debt` needs no addition: its generic block list already covers
   * `added`.
   */
  readonly warn: ReadonlyArray<FindingStatus>;
}

/** The security class: secrets, crit/high SAST, crit/high reachable dep
 *  vulns. Shared by both presets — full-debt is this plus the debt rules. */
const SECURITY_BLOCK_RULES: BrownfieldBlockRules = {
  newSecret: true,
  newCriticalSecurity: true,
  newHighSecurity: true,
  newCriticalDependencyVulnerability: true,
  newHighReachableDependencyVulnerability: true,
  // Malware is not "debt": a net-new dependency carrying a malicious-code
  // advisory blocks under EVERY posture regardless of CVSS — install-time
  // malware runs at install, so severity and reachability are the wrong
  // lens. Added after a zero-write replay of the July 2025
  // eslint-config-prettier compromise showed the default posture passing
  // it silently.
  newMaliciousDependency: true,
  // Open-ended debt — OFF in security-only (warn, never block).
  newUntestedChangedSource: false,
  newSevereQualityIssueInChangedFiles: false,
};

const PRESETS: Readonly<Record<LoopPreset, PresetDef>> = Object.freeze({
  'security-only': {
    // Empty generic block list: nothing auto-blocks by status alone, so
    // test-gap + quality net-new findings warn but never block.
    // Blocking comes solely from SECURITY_BLOCK_RULES.
    block: [],
    blockRules: SECURITY_BLOCK_RULES,
    // Every net-new finding the rules don't escalate is still a warning —
    // silence is reserved for pre-existing debt, never for something this
    // change introduced.
    warn: ['added'],
    flowMode: 'warn',
    schemaMode: 'warn',
    duplicationMode: 'warn',
  },
  'full-debt': {
    // Any net-new finding blocks (generic `added`), plus every escalation.
    block: ['added'],
    blockRules: {
      ...SECURITY_BLOCK_RULES,
      newUntestedChangedSource: true,
      newSevereQualityIssueInChangedFiles: true,
    },
    warn: [],
    flowMode: 'block',
    schemaMode: 'block',
    duplicationMode: 'block',
  },
});

/** A preset applied to a base policy, plus the gate postures the preset
 *  dictates. The shape both consumers hand to `runGuardrailCheck`. */
export interface PresetPolicy {
  readonly policy: BrownfieldPolicy;
  readonly preset: LoopPreset;
  readonly flowMode: FlowGateMode;
  readonly schemaMode: SchemaGateMode;
  readonly duplicationMode: DuplicationGateMode;
}

/**
 * Apply a preset to a base `BrownfieldPolicy`: the base's confidence
 * thresholds, baseline mode, and drift handling are preserved; its `block`
 * list + `blockRules` are REPLACED by the preset's. Pure — resolution of
 * WHICH preset applies (env var, `loop.preset`, CLI flag) stays with the
 * consumer.
 */
export function policyForPreset(preset: LoopPreset, base: BrownfieldPolicy): PresetPolicy {
  const def = PRESETS[preset];
  return {
    preset,
    flowMode: def.flowMode,
    schemaMode: def.schemaMode,
    duplicationMode: def.duplicationMode,
    policy: {
      ...base,
      block: def.block,
      blockRules: def.blockRules,
      // Union, never replacement: the base's drift/uncertainty warns
      // survive; the preset can only ADD warn statuses (see PresetDef.warn).
      warn: def.warn.length > 0 ? [...new Set([...base.warn, ...def.warn])] : base.warn,
    },
  };
}
