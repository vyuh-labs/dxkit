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

/** What a driver can do about a budget cap — see `AgentDriver.budgetSupport`. */
export type BudgetCapability = 'enforced' | 'reported' | 'none';

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
  /**
   * Tool narrowing for this run (order-driven runs): permission-rule
   * patterns the driver renders through its declared `toolPolicy` mechanism.
   * A driver with no `toolPolicy` declaration ignores this — the CALLER must
   * disclose that the policy could not be applied (never a silent drop).
   */
  readonly tools?: {
    readonly allowed?: readonly string[];
    readonly disallowed?: readonly string[];
  };
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
  /** The agent CLI build that executed the run, when the driver can probe it
   *  — the executor is part of the run's provenance (Rule 19 cause #5: "the
   *  TOOL changed" must be visible, so the envelope names the build). */
  readonly cliVersion?: string;
  /** Wall-clock cap hit: the runner salvages committed work, the outcome
   *  taxonomy says the task was cut short. */
  readonly timedOut: boolean;
  /** CLI died before the agent ran (auth, credit, bad flag) — a distinct
   *  infra outcome (`agent-never-ran`), never read as "agent made no
   *  change". The reason carries the CLI's own human-readable cause when it
   *  reports one ("Credit balance is too low"), so the ledger names what a
   *  maintainer must actually fix. */
  readonly neverRan?: { readonly reason: string };
  /** The run ended in a driver/API error AFTER real work started — distinct
   *  from neverRan (no work happened) and timedOut (salvage territory). The
   *  runner verifies whatever was committed and DISCLOSES this; a no-diff
   *  errored run is a failure outcome, never a benign no-op. */
  readonly failure?: { readonly reason: string };
  /** The agent's FINAL MESSAGE on a completed run, when the driver reports
   *  one (#285): a clean no-op outcome discards the transcript by design,
   *  which made "no-op against a visibly non-empty inventory" unautopsiable
   *  — the runner records this in the attempt record for no-op outcomes so
   *  the agent's own account of why nothing changed survives. Bounded by
   *  the driver; never rendered into a PR body. */
  readonly finalMessage?: string;
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
   * Per budget dimension, what the driver can actually DO about the cap —
   * three-valued because "reports it afterward" is not "enforces it", and
   * conflating them shipped a $14.71 spend against a $5 cap:
   *
   *   - `'enforced'`  — the driver stops the run at the cap (claude-code's
   *     `--max-turns`);
   *   - `'reported'`  — the driver only reports the dimension after the run;
   *     the cap is applied POST-HOC (an overrun marks the attempt partial
   *     and is disclosed) and the ledger says so plainly;
   *   - `'none'`      — neither enforced nor reported.
   *
   * Anything below `'enforced'` becomes a DISCLOSED limitation in the
   * ledger, never a silent no-op, and the dispatch layer clamps the levers
   * that DO bound the dimension (raising `max_turns` raises real spend, so
   * turns are clamped against the committed spend authority). maxMinutes is
   * always runner-enforced, so it is not declared here.
   */
  readonly budgetSupport: {
    readonly turns: BudgetCapability;
    readonly cost: BudgetCapability;
  };
  /**
   * Env var NAMES the driver needs (e.g. ['ANTHROPIC_API_KEY']). The managed
   * workflow template renders its secret wiring FROM this declaration, so a
   * new driver never means hand-editing the template.
   */
  readonly credentialEnv: readonly string[];
  /**
   * The installable agent CLI, PINNED — the managed workflow renders its
   * install step FROM this declaration (Rule 15: registry-driven, never a
   * hand-edited template line). An unattended lane must not float its
   * executor: a CLI release changing behavior under a byte-identical dxkit
   * is Rule 19 cause #5 ("the TOOL changed"), so the version is explicit
   * and bumping it is a deliberate one-line driver change. `null` declares
   * a driver with no installable CLI (it manages its own runtime) — a
   * stated fact, never an omission.
   */
  readonly cli: { readonly package: string; readonly version: string } | null;
  /**
   * The driver's in-loop gate mechanism, when it has one (#305):
   * `'claude-stop-hook'` = the repo's committed `.claude/settings.json`
   * Stop hook re-runs the guardrail on every stop attempt, provided the
   * workspace is trusted and the hook command resolves — the runner
   * pre-trusts its own CI checkout and probes the wiring before spawning
   * (`agent-trust.ts`). Absent = the driver has no in-loop mechanism and
   * every run is honestly disclosed `backstop-only`.
   */
  readonly inLoopGateMechanism?: 'claude-stop-hook';
  /**
   * The driver's tool-narrowing mechanism, when it has one: how
   * `AgentRunOptions.tools` reaches the agent CLI, with the CLI requirement
   * documented against the pinned version. Absent = the driver cannot narrow
   * tools — a stated fact the runner DISCLOSES (the envelope then says the
   * tool policy could not be applied and the envelope sweep is the
   * enforcement), never an omission.
   */
  readonly toolPolicy?: {
    readonly mechanism: 'disallowed-tools';
    /** The CLI capability this depends on, stated against the pinned CLI. */
    readonly cliRequirement: string;
  };
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
