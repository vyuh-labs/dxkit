/**
 * The remediate outcome vocabulary — the runner's result/option shapes and
 * the outcome taxonomy every surface (CLI, ledger, workflow, landers) speaks.
 * Split from `run.ts` purely for module size (the ledger-render precedent);
 * the runner re-exports everything, so consumers keep one import surface.
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import type { AttributedFloorFailure } from '../analyzers/correctness/attribution';
import type { GuardrailGateResult } from '../lanes/verify';
import type { AgentDriver } from './driver';
import type { RemediateTask } from './tasks';
import type { DispatchOverrides } from './dispatch';
import type { HingeEvidence, HingeScores } from './score-hinge';
import type { RemediateConfig } from './config';
import type { InLoopGateStatus } from './agent-trust';

export type RemediateOutcome =
  | 'verified' // diff produced, floor net-new-clean, guardrail PASSED — ready to land
  | 'no-op' // agent ran TO COMPLETION, no diff (nothing to fix)
  | 'floor-red' // diff breaks the net-new floor — never lands
  | 'guardrail-red' // guardrail blocked, refused, or could not run — never lands
  | 'score-red' // the task's score hinge did not hold (goal not met) — never lands
  | 'budget-exhausted' // a cap hit; partial diff (salvage policy decides its fate)
  | 'agent-never-ran' // CLI/auth/env failure — infra, not a code outcome
  | 'agent-failed' // the run errored after starting and produced no committed change
  | 'sweep-failed' // agent committed work but leftovers could not be swept
  | 'refused'; // trust/config refusal, disclosed

export interface AgentEnvelope {
  readonly driver: string;
  /** Driver-native model argument + how it was chosen (ledger disclosure). */
  readonly model: string;
  readonly modelSource: 'auto-tier' | 'pinned-tier' | 'pinned-native';
  readonly modelWarning?: string;
  /** Concrete id the run reported, or absent ("not reported by driver"). */
  readonly resolvedModelId?: string;
  /** The agent CLI build that executed the run (run provenance), when the
   *  driver could probe it. */
  readonly cliVersion?: string;
  /**
   * Which auth path the run used: `api-key` = the runner injected a declared
   * credential (billed API spend); `subscription` = no credential injected,
   * the CLI's own stored login applied. Under subscription auth a reported
   * cost is a NOTIONAL API-equivalent, not billed spend — the ledger labels
   * it so a benchmark table never reads as a bill.
   */
  readonly auth: 'api-key' | 'subscription';
  readonly turns?: number;
  readonly costUsd?: number;
  /** Driver-reported failure (an error after the run started) — disclosed
   *  even when committed work verifies clean. */
  readonly failure?: string;
  readonly budget: {
    readonly maxTurns: number;
    readonly maxMinutes: number;
    readonly maxUsd: number;
  };
  /** Caps the driver cannot enforce — disclosed, never silent. */
  readonly unenforceableCaps: readonly string[];
  /**
   * Was the in-loop Stop-gate actually WIRED for this run (#305)?
   * `in-loop-gated` = the committed Stop hook verifiably loads (settings +
   * trusted workspace + resolvable hook command), so stop attempts re-run
   * the guardrail inside the session; `backstop-only` = it cannot load
   * (reason named) and only post-run frame verification gates. REQUIRED so
   * a run without the in-loop gate can never read identically to one with
   * it. Decided by the ONE prober (`agent-trust.ts:armInLoopGate`).
   */
  readonly inLoopGate: InLoopGateStatus;
}

export interface RemediateResult {
  readonly outcome: RemediateOutcome;
  readonly task?: RemediateTask['id'];
  readonly note?: string;
  readonly envelope?: AgentEnvelope;
  /** True when the run was cut short (wall-clock or turn cap) — the ledger
   *  must say the task was budget-bounded, not finished. */
  readonly partial?: boolean;
  readonly floor?: CorrectnessFloorResult;
  readonly floorAttribution?: readonly AttributedFloorFailure[];
  readonly guardrailVerdict?: string;
  /** Score-hinge evidence (tasks that declare one): the entry vs post-agent
   *  dimension scores the land decision was made on. Present on success AND
   *  failure — the ledger shows the delta either way. */
  readonly scoreHinge?: HingeEvidence;
  /** HEAD before/after the agent — the commit range a lander pushes. */
  readonly baseHead?: string;
  readonly head?: string;
  /** Dispatch-campaign disclosure (E3): who fired it, the verbatim custom
   *  prompt (when the `custom` task ran), and any clamped overrides. In the
   *  ledger = in the PR body, so the reviewer sees exactly what was asked. */
  readonly dispatch?: {
    readonly actor?: string;
    readonly prompt?: string;
    readonly clamped: readonly string[];
  };
  /** Present when this run CONTINUED a prior budget-bounded attempt
   *  (resume-from-salvage) — disclosed in the ledger/PR body. */
  readonly resume?: { readonly attempt: number };
  /** The last lines of the agent's captured output — JOB-LOG evidence for a
   *  non-clean outcome (the run page must be diagnosable without reading
   *  source). Never rendered into the ledger / PR body. */
  readonly transcriptTail?: string;
  /** dxkit runtime-artifact paths dropped from the attempt (regenerable
   *  scan state the agent committed mid-run) — disclosed in the ledger. */
  readonly scrubbedArtifacts?: readonly string[];
  /** The verification ledger — PR body / job summary markdown. */
  readonly ledger: string;
}

export interface RemediateGit {
  head(): string;
  /** Commit uncommitted leftovers (excluding dxkit runtime state); returns
   *  an error string when the sweep commit failed. */
  sweepLeftovers(): string | undefined;
  /** Drop attempt-introduced dxkit runtime artifacts (regenerable scan
   *  state the AGENT committed mid-run) from the landing; returns the
   *  scrubbed paths (disclosed). Paths tracked at base are never touched.
   *  Fail-open: an error returns [] and the attempt lands as-is. */
  scrubRuntimeArtifacts(baseHead: string): readonly string[];
  /** Any CONTENT change in base..HEAD? (Commit count is the wrong
   *  question: a resume marker is an empty commit.) */
  hasDiff(baseHead: string): boolean;
}

export interface RemediateRunOptions {
  readonly cwd: string;
  /** REQUIRED typed trust context — the runner executes an agent CLI. */
  readonly trust: AnalysisTrustContext;
  readonly taskId: string;
  readonly config: RemediateConfig;
  /** Credentials for the driver (CI: from repo secrets). Local default is
   *  empty — the claude-code driver then runs subscription-mode. */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /** Injected for tests. */
  readonly drivers?: readonly AgentDriver[];
  readonly git?: RemediateGit;
  readonly runFloor?: () => CorrectnessFloorResult;
  readonly runGuardrail?: () => Promise<GuardrailGateResult>;
  /** Injected for tests: replaces the in-loop gate pre-trust + wiring probe
   *  (`agent-trust.ts:armInLoopGate`). */
  readonly armInLoopGate?: () => InLoopGateStatus;
  /** Injected for tests: replaces the health-score probe behind a task's
   *  score hinge. */
  readonly hingeScores?: (hinge: NonNullable<RemediateTask['scoreHinge']>) => Promise<HingeScores>;
  /** Progress hook — called as each phase begins so the CLI layer can emit
   *  log groups + heartbeats (a 35-minute silent step is indistinguishable
   *  from a hang; "working" must be observable from the job log). */
  readonly onPhase?: (phase: RemediatePhase) => void;
  /** Dispatch-campaign overrides (E2/E3), read from env by the CLI layer.
   *  Carries the custom task's prompt, the clamp disclosures, and the
   *  dispatcher for the ledger. */
  readonly dispatch?: DispatchOverrides;
  /** Pre-captured entry floor (resume path): the CLI snapshots the PRISTINE
   *  default tree BEFORE checking out a salvage branch, so attribution stays
   *  anchored to the original base — a broken partial reads NET-NEW. */
  readonly entryFloor?: CorrectnessFloorResult;
  /** Present when this run continues a prior budget-bounded attempt. The
   *  optional blockingContext is the prior attempt's guardrail findings
   *  (from its draft-PR ledger) — appended to the prompt, never the ledger. */
  readonly resume?: { readonly attempt: number; readonly blockingContext?: string };
}

/** The runner's observable phases, in order. */
export type RemediatePhase =
  | 'entry-floor'
  | 'agent'
  | 'sweep'
  | 'verify-floor'
  | 'guardrail'
  | 'score-hinge';
