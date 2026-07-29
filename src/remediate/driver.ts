/**
 * The agent-driver seam (remediate design §3) — the one boundary between
 * dxkit's remediation frame and any coding-agent CLI.
 *
 * Layering rule (§9, the deprecation answer): the further from the vendor a
 * layer sits, the more abstract its model vocabulary. The task registry
 * speaks dxkit's own TIERS (`light`/`standard`/`deep`); each driver maps a
 * tier to its NATIVE model argument via `resolveModel` — vendor vocabulary
 * lives in the driver entry and nowhere else, and drivers prefer rolling
 * aliases over dated ids so a model-generation rollover is the vendor's
 * release event, not a dxkit release.
 *
 * The driver is registry-shaped (Rule 6/15 discipline): a second agent CLI
 * is a new entry, never a redesign. v1 ships ONE real driver (claude-code);
 * the seam is proven by the synthetic-driver playbook test, not by a
 * speculative second implementation.
 */

/** dxkit's own capability tiers — driver-neutral, task-registry vocabulary. */
export type ModelTier = 'light' | 'standard' | 'deep';

export const MODEL_TIERS: readonly ModelTier[] = ['light', 'standard', 'deep'];

export function isModelTier(v: unknown): v is ModelTier {
  return (MODEL_TIERS as readonly unknown[]).includes(v);
}

export interface AgentRunOptions {
  readonly cwd: string;
  readonly prompt: string;
  /** maxMinutes is runner-enforced (process timeout) for every driver;
   *  maxTurns is passed through when the driver supports it. */
  readonly budget: { readonly maxTurns: number; readonly maxMinutes: number };
  /** Driver-native model argument (already resolved — see resolveModelSetting). */
  readonly model: string;
  /** Credentials + task env injected HERE only — never argv, never logged. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentRunResult {
  /** The agent CLAIMS it finished. Never trusted alone — verification is the
   *  floor + guardrail, identical to the deterministic lane. */
  readonly completed: boolean;
  readonly turns?: number;
  readonly costUsd?: number;
  /** Concrete model id the run actually used, when the driver reports it —
   *  the ledger discloses absence ("not reported by driver"). */
  readonly resolvedModelId?: string;
  /** Wall-clock cap hit: the runner salvages committed work, the outcome
   *  taxonomy says the task was cut short. */
  readonly timedOut: boolean;
  /** CLI died before the agent ran (auth, bad flag) — a distinct infra
   *  outcome (`agent-never-ran`), never read as "agent made no change". */
  readonly neverRan?: { readonly reason: string };
  /** For the failure taxonomy only — never rendered into a PR body. */
  readonly transcriptTail: string;
}

export interface AgentDriver {
  readonly id: string;
  /**
   * Tier → this driver's NATIVE model argument. Prefer rolling aliases over
   * dated ids (deprecation-proof). A driver that cannot distinguish tiers
   * maps all three to one value — declared, not silent.
   */
  resolveModel(tier: ModelTier): string;
  /**
   * Which budget dimensions this driver can enforce/report. An undeclared
   * dimension becomes a DISCLOSED limitation in the ledger ("maxUsd not
   * enforceable by <driver>; wall-clock cap applied"), never a silent no-op.
   * maxMinutes is always runner-enforced, so it is not declared here.
   */
  readonly budgetSupport: { readonly turns: boolean; readonly cost: boolean };
  /**
   * Env var NAMES the driver needs (e.g. ['ANTHROPIC_API_KEY']). The managed
   * workflow template renders its secret wiring FROM this declaration, so a
   * new driver never means hand-editing the template.
   */
  readonly credentialEnv: readonly string[];
  available(cwd: string): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/** How a resolved model choice came to be — disclosed verbatim in the ledger. */
export interface ResolvedModelChoice {
  /** The driver-native model argument to pass. */
  readonly native: string;
  readonly source: 'auto-tier' | 'pinned-tier' | 'pinned-native';
  /** The tier that drove an auto/tier resolution. */
  readonly tier?: ModelTier;
  /** Present when a native pin is passed through unrecognized — new model
   *  ids ship faster than dxkit releases, so this warns, never refuses. */
  readonly warning?: string;
}

/**
 * Resolve `agent.model` (three accepted shapes) for one task:
 *   - `"auto"` (default): the task's registry tier through the driver;
 *   - a TIER name: driver-portable pin, all tasks at that tier;
 *   - anything else: a driver-native id passed through verbatim (per-driver;
 *     a driver switch may invalidate it — the guide says so).
 */
export function resolveModelSetting(
  driver: AgentDriver,
  setting: string | undefined,
  taskTier: ModelTier,
): ResolvedModelChoice {
  const value = setting?.trim() || 'auto';
  if (value === 'auto') {
    return { native: driver.resolveModel(taskTier), source: 'auto-tier', tier: taskTier };
  }
  if (isModelTier(value)) {
    return { native: driver.resolveModel(value), source: 'pinned-tier', tier: value };
  }
  const knownNatives = MODEL_TIERS.map((t) => driver.resolveModel(t));
  return {
    native: value,
    source: 'pinned-native',
    ...(knownNatives.includes(value)
      ? {}
      : {
          warning:
            `model '${value}' is not one of ${driver.id}'s tier aliases ` +
            `(${knownNatives.join(', ')}) — passing it through verbatim; ` +
            `a driver-side failure will surface as agent-never-ran`,
        }),
  };
}
