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
import type { FloorSkip, InstallOutcome, VerifyTreeSeams } from '../lanes/verify-tree';
import type { TreeInvariantOutcome } from '../lanes/tree-invariants';
import type { FrameInvariantSeams } from './frame-invariants';
import type { AgentDriver } from './driver';
import type { RemediateTask } from './tasks';
import type { DispatchOverrides } from './dispatch';
import type { HingeEvidence, HingeScores } from './score-hinge';
import type { RemediateConfig } from './config';
import type { InLoopGateStatus } from './agent-trust';
import type { RecipePhaseSummary, runRecipePhaseForTask } from './recipes/run-recipes';
import type { WorkOrderBudget } from './work-orders/types';

/** How (whether) the driver applied the run's tool-narrowing policy —
 *  disclosed in the envelope, never a silent drop. */
export type ToolPolicyDisclosure =
  | {
      readonly mechanism: 'disallowed-tools';
      readonly disallowed: readonly string[];
      /** The driver's documented CLI requirement for the mechanism. */
      readonly cliRequirement: string;
    }
  | { readonly mechanism: 'none'; readonly reason: string };

/**
 * Where one order's commits ENDED UP (4.4.6, per-order landing): `kept`
 * means the order's diff was verified on top of the previously verified
 * head (install + floor; the guardrail arbitrates ONCE over the landed
 * head) and is part of what lands; `dropped` means its commits were
 * reverted at the named step with the reason, and the order stays open.
 * The unit of work is the order, so the unit of landing is the order.
 */
export type OrderDisposition =
  | { readonly kind: 'kept'; readonly head: string }
  | {
      readonly kind: 'dropped';
      readonly step: 'tree-invariants' | 'install' | 'floor' | 'verification';
      readonly reason: string;
    };

/** One order's dispatch record (the orders phase: one order per agent run). */
export interface OrderRunRecord {
  readonly orderId: string;
  readonly class: string;
  readonly findings: number;
  /** The planner-derived budget for this order (with its derivation string),
   *  which BECAME the driver budget for the run — plus the clamp note when
   *  the run's remaining budget cut it down. */
  readonly budget: WorkOrderBudget;
  readonly clamped?: string;
  readonly outcome: 'completed' | 'partial' | 'failed' | 'never-ran' | 'not-dispatched';
  /** Failure/never-ran/not-dispatched reason. */
  readonly detail?: string;
  readonly spent?: { readonly turns?: number; readonly costUsd?: number };
  /** Out-of-envelope paths the sweep DROPPED, disclosed (the enforcement
   *  half of the envelope; the prompt half is advisory). */
  readonly droppedPaths?: readonly string[];
  /** The order's done criterion, echoed for the ledger's per-order done
   *  line (closure is arbitrated by the one tree verification below). */
  readonly done: { readonly verifier: 'floor' | 'guardrail'; readonly absentIds: number };
  /** The frame-owned invariants the order's diff tripped and what the
   *  frame did about each (4.4.6), disclosed per order. */
  readonly invariants?: readonly TreeInvariantOutcome[];
  /** Kept (verified per order, lands) or dropped (reverted, reason named).
   *  Absent on a record with no commits to place. */
  readonly disposition?: OrderDisposition;
  /** For floor-verifier orders, what the FINAL verified floor says about
   *  the order's target findings, through the ONE `floorOrderDone`
   *  computation the Stop-gate also reads. `undecided` counts ids the
   *  verification could not observe (skipped/absent check) — never claimed
   *  closed (guardrail-verifier closure has no per-finding read at this
   *  layer: the guardrail verdict + the next plan arbitrate, and the
   *  ledger says so). */
  readonly doneAfterVerify?: {
    readonly closed: number;
    readonly open: number;
    readonly undecided: number;
  };
}

/** The orders phase, disclosed as one summary on the result. */
export interface OrdersPhaseSummary {
  /** Effective `remediate.maxOrdersPerRun`. */
  readonly cap: number;
  /** Orders queued for the agent tier (before the cap). */
  readonly queued: number;
  readonly records: readonly OrderRunRecord[];
  /** True when a prior BLOCKED attempt's findings were rendered into each
   *  order prompt as a negative constraint (resume policy: a guardrail-red
   *  attempt is never a resume anchor). */
  readonly priorBlockingApplied?: boolean;
}

export type RemediateOutcome =
  | 'verified' // diff produced, floor net-new-clean, guardrail PASSED — ready to land
  | 'partially-landed' // some orders verified and land, others were DROPPED (named); non-clean, a PR opens for the kept set
  | 'no-op' // agent ran TO COMPLETION, no diff (nothing to fix)
  | 'recipes-refused' // recipe-only plan, every recipe refused/failed: nothing fixed, NOT clean
  | 'install-failed' // a clean checkout of the diff cannot be installed the way CI installs — never lands
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
  /** The tool-narrowing policy applied to order-driven runs (absent on the
   *  legacy task-prompt path, whose permissions are unchanged). */
  readonly toolPolicy?: ToolPolicyDisclosure;
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
  /** The floor was deliberately not run (an unprovisioned worktree); the
   *  ledger says why instead of "not run (dry run)". */
  readonly floorSkipped?: FloorSkip;
  /** How the declared install of the candidate went on a CLEAN checkout
   *  (4.4.5): the ledger says what CI's install step will do. */
  readonly install?: InstallOutcome;
  /** Tolerance-resolution disclosures (unknown dependencies.tolerate
   *  entries, policy-vs-observed conflicts), rendered as ledger warnings. */
  readonly installToleranceWarnings?: readonly string[];
  /** Which files the candidate changed vs the base (the floor's diff scope). */
  readonly changedFiles?: readonly string[];
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
  /** The agent's final message, recorded for NO-OP outcomes only (#285):
   *  the agent's own account of why nothing changed, so a no-op against a
   *  non-empty inventory is autopsiable. Attempt-record evidence — never
   *  the ledger / PR body. */
  readonly agentFinalMessage?: string;
  /** dxkit runtime-artifact paths dropped from the attempt (regenerable
   *  scan state the agent committed mid-run) — disclosed in the ledger. */
  readonly scrubbedArtifacts?: readonly string[];
  /** The deterministic recipe phase (4.4.5): per-order applied / refused /
   *  failed records, envelope drops, and the tier split, rendered into the
   *  ledger whenever the phase was consulted. */
  readonly recipes?: RecipePhaseSummary;
  /** The order-driven agent phase (4.4.5, scoped agent): one order per
   *  agent run, per-order records with derived budgets, envelope
   *  enforcement drops, and done disclosures — rendered into the ledger. */
  readonly orders?: OrdersPhaseSummary;
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
  /** Revert every committed change in base..HEAD whose path `isAllowed`
   *  rejects — files back to their base state, one disclosure commit — and
   *  return the dropped paths. The envelope's ENFORCEMENT half (the prompt
   *  half is advisory): sprawl outside an order's envelope becomes
   *  unlandable by construction, the runtime-artifact-scrub doctrine.
   *  `error` set = enforcement could not run; the caller must NOT land the
   *  unenforced diff. */
  enforceEnvelope(
    baseHead: string,
    isAllowed: (path: string) => boolean,
  ): { readonly dropped: readonly string[]; readonly error?: string };
  /** Move the branch back to `head` and discard everything after it (the
   *  per-order DROP: an order whose commits did not verify is reverted
   *  wholesale, the tree left clean at the previously verified head). */
  resetTo(head: string): void;
  /** Repo-relative paths the commits in base..HEAD changed (renames as
   *  both sides): what an order's diff touched, for the frame's invariant
   *  step. Throws when git cannot answer; the caller drops the order. */
  changedPaths(baseHead: string): readonly string[];
  /** Stage exactly these paths and commit them with the bot identity (the
   *  frame's own commit after re-establishing an invariant). */
  commitPaths(paths: readonly string[], message: string): void;
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
  /** Injected for tests: the ENTRY floor on the pristine tree, and the
   *  post-agent floor inside the verification worktree (forwarded to
   *  `verifyTree`'s floor seam). */
  readonly runFloor?: () => CorrectnessFloorResult;
  /** Injected for tests: forwarded to `verifyTree`'s guardrail seam. */
  readonly runGuardrail?: () => Promise<GuardrailGateResult>;
  /** Injected for tests: the worktree / install / changed-files seams of the
   *  ONE tree verification (`src/lanes/verify-tree.ts`). */
  readonly verifySeams?: Pick<VerifyTreeSeams, 'worktree' | 'install' | 'changedFiles'>;
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
  /** A prior BLOCKED (guardrail-red) attempt's blocking findings. Never a
   *  resume anchor — the attempt's diff is discarded and this rides the next
   *  run's order prompts as a NEGATIVE constraint ("do not reintroduce"). */
  readonly priorBlocking?: string;
  /** True when a human explicitly asked for THIS task (a workflow_dispatch
   *  naming it, or a local `remediate --task`): the circuit breaker's
   *  pauses on the task's classes are overridden for this run, disclosed.
   *  Scheduled matrix runs leave it unset. */
  readonly explicitDispatch?: boolean;
  /** Injected for tests: replaces the recipe phase (plan + execute the
   *  deterministic tier), the armInLoopGate seam pattern. */
  readonly runRecipePhase?: typeof runRecipePhaseForTask;
  /** Injected for tests: the frame's tree-invariant step edges (4.4.6),
   *  or the whole step. */
  readonly frameInvariants?: FrameInvariantSeams;
}

/** The runner's observable phases, in order. */
export type RemediatePhase =
  | 'entry-floor'
  | 'recipes'
  | 'agent'
  | 'sweep'
  | 'frame-invariants'
  | 'verify-install'
  | 'verify-floor'
  | 'guardrail'
  | 'score-hinge';
