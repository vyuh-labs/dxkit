/**
 * Doctor-advisor probes + deterministic config planners for the command
 * registry (CLAUDE.md Rule 16). Each is a PURE function of observable repo
 * facts; the registry (`command-defs.ts`) binds them onto descriptors, and
 * `gatherRecommendations` / `gatherConfigPlan` (in `commands.ts`) run them via
 * those descriptors. Kept out of `commands.ts` to hold each module to a
 * cohesive unit and to break the registry↔probe value-import cycle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveBaselineMode } from '../baseline/modes';
import { FLOW_CONFIG_SCHEMA_VERSION } from '../analyzers/flow/config';
import { isClaudeLoopInstalled } from '../loop/scaffold';
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

function existsAt(...parts: string[]): boolean {
  try {
    return fs.existsSync(path.join(...parts));
  } catch {
    return false;
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function dirHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
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

/**
 * Signal: this repo has a UI framework but no flow setup yet — the case where
 * flow's UI→API integration gate adds value. Shared by BOTH the doctor probe
 * (`recommendFlow`) and the deterministic planner (`planFlowMode`) so the two
 * never diverge (Rule 2 — one concept, one code path).
 */
function hasFlowSignal(cwd: string): boolean {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  if (!pkg) return false;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  const uiFrameworks = ['react', 'next', 'vue', 'svelte', '@angular/core'];
  if (!uiFrameworks.some((f) => f in deps)) return false;
  // Already configured? workspace.json or a flow policy block means yes.
  if (existsAt(cwd, '.dxkit', 'workspace.json')) return false;
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json'));
  if (policy && 'flow' in policy) return false;
  return true;
}

/** Recommend `flow init` on a UI repo with no flow setup. */
export function recommendFlow(ctx: RecommendContext): Recommendation | null {
  if (!hasFlowSignal(ctx.cwd)) return null;
  return {
    reason:
      'detected a UI framework but no flow setup — flow maps UI→API calls and gates changes that break an integration',
    command: 'vyuh-dxkit flow init',
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
/**
 * Signal: this repo runs a linter but has NOT wired it into dxkit's gate. Shared
 * by the doctor probe (`recommendChecks`) and the deterministic planner
 * (`planLintGate`) so they never diverge (Rule 2). Conservative: fires only on
 * a concrete linter config / `lint` script, and goes silent the moment the
 * `checks` / `lint` policy opts in.
 */
function hasLintSignal(cwd: string): boolean {
  const policy = readJsonSafe(path.join(cwd, '.dxkit', 'policy.json')) ?? {};
  // `.dxkit/policy.json` is flat (resolvePolicy spreads it at the top level),
  // so `checks` / `lint` are top-level keys — mirror of the flow probe's
  // `'flow' in policy`.
  const checks = policy.checks;
  const lint = policy.lint as Record<string, unknown> | undefined;
  // Already opted in? (a declared check, or the lint gate enabled) → silent.
  if (Array.isArray(checks) && checks.length > 0) return false;
  if (lint?.enabled === true) return false;

  // A concrete linter signal: a standalone lint config, or a package.json
  // `lint` script. Kept conservative so this never nags a repo without one.
  const lintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'ruff.toml',
    '.ruff.toml',
    '.rubocop.yml',
    '.golangci.yml',
    '.golangci.yaml',
  ];
  if (lintConfigs.some((f) => existsAt(cwd, f))) return true;
  const pkg = readJsonSafe(path.join(cwd, 'package.json'));
  const scripts = (pkg?.scripts as Record<string, unknown> | undefined) ?? {};
  return typeof scripts.lint === 'string';
}

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
    evidence: 'UI framework in package.json, no flow config yet',
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
 * scaffold seeds the preset at install — so this is a safety net. Reuses the
 * canonical Stop-hook detector (`isClaudeLoopInstalled`, Rule 2).
 */
export function planLoopPreset(ctx: ConfigContext): ConfigPlanItem | null {
  if (!isClaudeLoopInstalled(ctx.cwd)) return null;
  const policy = readJsonSafe(path.join(ctx.cwd, '.dxkit', 'policy.json')) ?? {};
  const loop = policy.loop as Record<string, unknown> | undefined;
  if (loop && typeof loop.preset === 'string') return null; // already pinned
  return {
    capability: 'loop',
    section: 'loop.preset',
    summary: 'security-only',
    patch: { loop: { preset: 'security-only' } },
    reason: 'pin the safe default loop posture (blocks net-new security, warns on debt)',
    evidence: 'loop Stop-gate installed, no preset pinned',
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
