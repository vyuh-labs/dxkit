/**
 * Doctor-advisor probes + deterministic config planners for the command
 * registry (CLAUDE.md Rule 16). Each is a PURE function of observable repo
 * facts; the registry (`command-defs.ts`) binds them onto descriptors, and
 * `gatherRecommendations` / `gatherConfigPlan` (in `commands.ts`) run them via
 * those descriptors. Kept out of `commands.ts` to hold each module to a
 * cohesive unit and to break the registry↔probe value-import cycle.
 */
import * as path from 'path';
import { resolveBaselineMode } from '../baseline/modes';
import { FLOW_CONFIG_SCHEMA_VERSION } from '../analyzers/flow/config';
import { SCHEMA_CONFIG_SCHEMA_VERSION } from '../analyzers/model-schema/config';
import { DUPLICATION_CONFIG_SCHEMA_VERSION } from '../analyzers/duplication/config';
import {
  existsAt,
  readJsonSafe,
  dirHasEntries,
  hasFlowSignal,
  hasSchemaSignal,
  hasDuplicationSignal,
  hasLintSignal,
  undeclaredContractArtifacts,
  loopStopGateNeedsPreset,
} from './advisor-signals';
import type {
  RecommendContext,
  Recommendation,
  ConfigContext,
  ConfigPlanItem,
} from './command-types';

// ─── Doctor advisor probes ──────────────────────────────────────────────────
// Grounded, cheap recommendations `doctor` surfaces for capabilities the repo
// would benefit from but isn't using. Each probe is self-contained (cwd + fs
// only) and conservative — it fires only on a clear signal and returns null
// once the capability is in use, so `doctor` never nags about what's already
// set up. New capabilities attach their own probe here as they land (the gate
// runner's "you have ungated repo checks" probe is the marquee future case).
// The shared `has*Signal` detectors live in `./advisor-signals` (Rule 2 —
// consumed by both a probe and its planner).

/** Recommend the zero-write trial where dxkit is NOT installed yet — the
 *  pre-adoption step. Once the manifest exists the gate itself answers the
 *  question the trial answers, so the probe goes silent. */
export function recommendEvaluate(ctx: RecommendContext): Recommendation | null {
  if (existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (!existsAt(ctx.cwd, '.git')) return null;
  return {
    reason:
      'dxkit is not installed here — the zero-write trial replays your recent landings through the gate without touching the repo',
    command: 'vyuh-dxkit evaluate',
  };
}

/** Recommend `baseline create` when dxkit is installed but has no baseline. */
export function recommendBaseline(ctx: RecommendContext): Recommendation | null {
  // Only relevant once dxkit is installed (the manifest exists). Without a
  // baseline, `guardrail check` has nothing to diff against.
  if (!existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (dirHasEntries(path.join(ctx.cwd, '.dxkit', 'baselines'))) return null;
  return {
    reason:
      'dxkit is installed but no baseline exists — the guardrail cannot gate net-new findings without one',
    command: 'vyuh-dxkit baseline create',
  };
}

/** Recommend flow setup on a repo with an HTTP-framework signal and no flow config. */
export function recommendFlow(ctx: RecommendContext): Recommendation | null {
  if (!hasFlowSignal(ctx.cwd)) return null;
  return {
    reason:
      'detected an HTTP framework but no flow setup — flow maps client calls to served routes and gates changes that break an integration',
    command: 'vyuh-dxkit flow init',
  };
}

/** Recommend the schema gate on a repo with an ORM/model-framework signal
 *  and no schema config. */
export function recommendSchema(ctx: RecommendContext): Recommendation | null {
  if (!hasSchemaSignal(ctx.cwd)) return null;
  return {
    reason:
      'detected a data-model framework but no schema gate — the gate blocks breaking model changes (field removed, type changed, required tightened) while a deliberate migration ships via an expiring allowlist entry',
    command: 'vyuh-dxkit schema',
  };
}

/**
 * Structural-duplicate (seam) gate: on a repo with a dense-enough call graph and
 * no duplication config, seed the safe default posture — `warn` (surface the
 * copy-paste the call graph catches, never fail a build). Reuses
 * `hasDuplicationSignal` (shared with the doctor probe, Rule 2).
 */
export function planDuplicationMode(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasDuplicationSignal(ctx.cwd)) return null;
  return {
    capability: 'quality',
    section: 'duplication.mode',
    summary: 'warn',
    patch: { duplication: { mode: 'warn', schemaVersion: DUPLICATION_CONFIG_SCHEMA_VERSION } },
    reason:
      'seed the structural-duplicate (seam) gate at the safe default (warn, never fails a build) — it flags a net-new function that copy-pastes another',
    evidence:
      'a dense call graph where the duplicate signal is reliable, no duplication config yet',
  };
}

/** Recommend the seam gate on a repo whose call graph is dense enough for the
 *  structural-duplicate signal to work, and no duplication config. */
export function recommendDuplication(ctx: RecommendContext): Recommendation | null {
  if (!hasDuplicationSignal(ctx.cwd)) return null;
  return {
    reason:
      'a dense call graph but no structural-duplicate (seam) gate — it catches a net-new function that copy-pastes another (the call graph sees it through rename/reformat, unlike token duplication), and pairs with the dead-surface inventory in `flow`',
    command: 'vyuh-dxkit quality',
  };
}

/**
 * Recommend the custom-check gate when the repo runs a linter but hasn't wired
 * it into dxkit's guardrail. The gate is opt-in default-off, so a repo with a
 * clear lint signal and no `checks` / `lint` policy block is exactly the case
 * where "block only net-new lint errors" adds value without the user knowing to
 * ask for it. Conservative: fires only on a concrete linter signal, and goes
 * silent once the policy opts in.
 */

export function recommendChecks(ctx: RecommendContext): Recommendation | null {
  if (!hasLintSignal(ctx.cwd)) return null;
  return {
    reason:
      'this repo runs a linter but it is not a guardrail gate — enable the lint gate so net-new lint errors block (pre-existing debt is grandfathered)',
    command: 'vyuh-dxkit checks',
  };
}

// ─── Deterministic config planners (`vyuh-dxkit configure`) ──────────────────
// Each is a PURE function of observable repo facts — same repo, same plan, every
// run and every environment. That reproducibility is the whole point: the config
// value is COMPUTED, never chosen by an agent. Each returns null when there's
// nothing to recommend (already pinned, or no signal), exactly like the doctor
// probes above. New capabilities attach their own `planConfig` to their
// descriptor and are picked up by `gatherConfigPlan` with no other edit.

/**
 * Baseline mode: pin the visibility-derived default explicitly so every
 * developer and CI job agree. This is load-bearing, not cosmetic — a developer
 * without `gh` access resolves visibility to 'unknown' (→ committed-full) while
 * CI with `gh` sees 'public' (→ ref-based), so an UNPINNED repo silently uses
 * two different postures. Reuses the canonical resolver (Rule 11); returns null
 * once `baseline.mode` is pinned.
 */
export function planBaselineMode(ctx: ConfigContext): ConfigPlanItem | null {
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  const baseline = policy.baseline as Record<string, unknown> | undefined;
  if (baseline && typeof baseline.mode === 'string') return null; // already pinned
  const resolved = resolveBaselineMode({
    cwd: ctx.cwd,
    probeVisibility: ctx.probeVisibility,
    probeDefaultRef: ctx.probeDefaultRef,
  });
  const patchBaseline: Record<string, unknown> = { mode: resolved.mode };
  if (resolved.mode === 'ref-based' && resolved.ref) patchBaseline.ref = resolved.ref;
  const summary =
    resolved.mode === 'ref-based' && resolved.ref
      ? `${resolved.mode} (${resolved.ref})`
      : resolved.mode;
  return {
    capability: 'baseline',
    section: 'baseline.mode',
    summary,
    patch: { baseline: patchBaseline },
    reason: `pin the baseline posture so every developer + CI agree (${resolved.explanation})`,
    evidence: `source=${resolved.source}`,
  };
}

/**
 * Flow gate: on a UI repo with no flow setup, seed the safe default posture —
 * `warn` (surface net-new broken integrations, never fail a build). The team
 * moves it to `block` later via the dxkit-flow skill. Reuses `hasFlowSignal`
 * (shared with the doctor probe, Rule 2).
 */
export function planFlowMode(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasFlowSignal(ctx.cwd)) return null;
  return {
    capability: 'flow',
    section: 'flow.mode',
    summary: 'warn',
    patch: { flow: { mode: 'warn', schemaVersion: FLOW_CONFIG_SCHEMA_VERSION } },
    reason: 'seed the UI→API integration gate at the safe default (warn, never fails a build)',
    evidence: 'HTTP framework in a dependency manifest, no flow config yet',
  };
}

/**
 * Schema gate: on a repo with a data-model framework and no schema config,
 * seed the safe default posture — `warn` (surface breaking drift, never fail
 * a build). The team moves it to `block` once the inventory reads clean.
 * Reuses `hasSchemaSignal` (shared with the doctor probe, Rule 2).
 */
export function planSchemaMode(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasSchemaSignal(ctx.cwd)) return null;
  return {
    capability: 'schema',
    section: 'schema.mode',
    summary: 'warn',
    patch: { schema: { mode: 'warn', schemaVersion: SCHEMA_CONFIG_SCHEMA_VERSION } },
    reason: 'seed the model-schema drift gate at the safe default (warn, never fails a build)',
    evidence: 'data-model framework in a dependency manifest, no schema config yet',
  };
}

/** Recommend declaring contract artifacts the repo already has (a Postman
 *  collection, a pact, a HAR capture, .http files) — zero-code flow evidence. */
export function recommendExtensions(ctx: RecommendContext): Recommendation | null {
  const found = undeclaredContractArtifacts(ctx.cwd);
  if (found.length === 0) return null;
  const sample = found
    .slice(0, 3)
    .map((a) => `${a.path} (${a.kind})`)
    .join(', ');
  return {
    reason:
      `found contract artifact(s) not declared to dxkit — ${sample} — declaring them in ` +
      'flow.sources joins them to the integration map + gate with zero code',
    command: 'vyuh-dxkit extensions',
  };
}

/**
 * Declared artifacts: propose `flow.sources` entries for the contract
 * artifacts the repo already has. Deterministic from the git-tracked file
 * list + the reader registry's own filename signals; the user confirms the
 * plan before anything is written. Reuses `undeclaredContractArtifacts`
 * (shared with the doctor probe, Rule 2).
 */
export function planFlowSources(ctx: ConfigContext): ConfigPlanItem | null {
  const found = undeclaredContractArtifacts(ctx.cwd);
  if (found.length === 0) return null;
  return {
    capability: 'extensions',
    section: 'flow.sources',
    summary: `${found.length} artifact(s) declared`,
    patch: { flow: { sources: found } },
    reason: 'join the contract artifacts this repo already has to the flow map + gate (zero code)',
    evidence: found.map((a) => `${a.path} (${a.kind})`).join(', '),
  };
}

/**
 * Lint gate: on a repo that runs a linter but hasn't wired it in, enable the
 * gate WARN-only (`blocking: false`) — net-new lint errors surface without the
 * pre-existing backlog suddenly blocking. The team flips `blocking: true` once
 * the backlog is clean. Reuses `hasLintSignal` (shared with the doctor probe).
 */
export function planLintGate(ctx: ConfigContext): ConfigPlanItem | null {
  if (!hasLintSignal(ctx.cwd)) return null;
  return {
    capability: 'checks',
    section: 'lint',
    summary: 'enabled, warn-only',
    patch: { lint: { enabled: true, blocking: false } },
    reason: 'gate net-new lint errors without blocking on the pre-existing backlog',
    evidence: 'linter config / lint script present, no lint policy yet',
  };
}

/**
 * Loop posture: if the Stop-gate is installed but `loop.preset` is unpinned,
 * pin the safe default (`security-only`). Rarely fires in practice — the loop
 * scaffold seeds the preset at install — so this is a safety net. Reuses
 * `loopStopGateNeedsPreset` (shared with the doctor probe, Rule 2).
 */
export function planLoopPreset(ctx: ConfigContext): ConfigPlanItem | null {
  if (!loopStopGateNeedsPreset(ctx.cwd)) return null;
  return {
    capability: 'loop',
    section: 'loop.preset',
    summary: 'security-only',
    patch: { loop: { preset: 'security-only' } },
    reason: 'pin the safe default loop posture (blocks net-new security, warns on debt)',
    evidence: 'loop Stop-gate installed, no preset pinned',
  };
}

/** Recommend pinning `loop.preset` when the Stop-gate is installed but the
 *  posture is unpinned — so `doctor` surfaces the same safety net `configure`
 *  plans. Reuses `loopStopGateNeedsPreset` (Rule 2); silent once pinned. */
export function recommendLoopPreset(ctx: RecommendContext): Recommendation | null {
  if (!loopStopGateNeedsPreset(ctx.cwd)) return null;
  return {
    reason:
      'the loop Stop-gate is installed but no `loop.preset` is pinned — pin the blocking posture so every unattended run gates identically (the safe default is security-only)',
    command: 'vyuh-dxkit configure --plan',
  };
}

/**
 * Recommend on-merge report snapshots for a repo that is actively gating (dxkit
 * installed + a baseline exists) but not publishing the score-over-time trend.
 * Conservative: fires only once the repo is invested in the gate — so it nudges
 * "also track the trend", never nags a fresh install — and goes silent the
 * moment `reports.onMerge` is enabled. Recommend-only (no `planConfig`):
 * enabling it installs the `dxkit-reports-refresh` workflow, a managed surface
 * `configure`'s policy-only merge-write cannot place, so the driving command
 * (`report`, via the dxkit-reports skill) owns turning it on.
 */
export function recommendReportsOnMerge(ctx: RecommendContext): Recommendation | null {
  if (!existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (!dirHasEntries(path.join(ctx.cwd, '.dxkit', 'baselines'))) return null;
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  const reports = policy.reports as Record<string, unknown> | undefined;
  if (reports?.onMerge === true) return null; // already publishing
  return {
    reason:
      'you gate net-new findings but do not publish score snapshots on merge — enable reports.onMerge to track how each health dimension moves over time (the champion ROI trend)',
    command: 'vyuh-dxkit report snapshot',
  };
}

/**
 * Recommend `configure` from doctor when dxkit is installed but nothing is
 * configured yet (no `.dxkit/policy.json`). Cheap probe — it does not compute
 * the full plan, just the clearest "unconfigured" signal.
 */
export function recommendConfigure(ctx: RecommendContext): Recommendation | null {
  if (!existsAt(ctx.cwd, '.vyuh-dxkit.json')) return null;
  if (existsAt(ctx.cwd, '.dxkit', 'policy.json')) return null;
  return {
    reason:
      'dxkit is installed but nothing is configured — compute a deterministic config plan from this repo',
    command: 'vyuh-dxkit configure --plan',
  };
}
