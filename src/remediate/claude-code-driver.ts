/**
 * The claude-code driver — v1's one real `AgentDriver` (remediate design §3),
 * ported from the production remediation script including its scars:
 *
 *   - subscription-first credentials: ambient ANTHROPIC_API_KEY /
 *     ANTHROPIC_AUTH_TOKEN are STRIPPED from the child env unless the runner
 *     explicitly injects one — per-token billing is an explicit opt-in,
 *     never an env var that happened to be exported in this shell;
 *   - tier → rolling CLI alias (`haiku`/`sonnet`/`opus`), never a dated
 *     model id, so a model-generation rollover needs no dxkit release;
 *   - "agent never ran" detection, BOTH shapes: a non-zero exit with zero
 *     turns (CLI died before the agent started — bad flag), and an API-level
 *     failure with no work done (invalid key, exhausted credit — the CLI
 *     reports `num_turns: 1` for the failed call itself, which defeated the
 *     original zero-turns guard and shipped a green job over a dead agent).
 *     Reported as its own outcome with the CLI's human-readable cause,
 *     never read downstream as "agent made no change";
 *   - a wall-clock kill is salvage territory, not failure: work the agent
 *     already committed is finished work (the runner decides what to do
 *     with it).
 *
 * Execution is injected (the bounded-exec discipline) so tests drive every
 * arm without a real `claude` binary.
 */
import { execFileSync } from 'child_process';
import { commandExists } from '../analyzers/tools/runner';
import type { AgentDriver, AgentRunOptions, AgentRunResult, ModelTier } from './driver';

export interface AgentExecOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type AgentExec = (
  bin: string,
  args: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
) => AgentExecOutcome;

const MAX_CAPTURE = 16 * 1024 * 1024;

/**
 * Real spawn. A timeout kill surfaces as `timedOut`, distinct from a
 * non-zero exit; captured output rides the error object either way.
 *
 * Timeout classification is DEADLINE-FIRST, not signal-encoding-first
 * (#272): the deadline is this exec's own fact, so it measures elapsed
 * time itself and classifies a kill-shaped death at/past the deadline as
 * `timedOut` — corroborated by any of the encodings a SIGTERM produces:
 *
 *   - signal-death: the child died to the signal (`signal: 'SIGTERM'`,
 *     no exit status) — the only encoding the original predicate knew;
 *   - graceful-catch: the child traps SIGTERM and exits 128+15=143
 *     (observed on claude CLI 2.1.222) — `status: 143`, `signal: null`,
 *     and no result JSON, which made the run read as "agent never ran"
 *     and discard 30 minutes of stranded work before the sweep.
 *
 * A natural non-zero exit before the deadline is never a timeout, and a
 * real failure exit (e.g. 1) is never reclassified even when the race
 * lands it past the deadline — biased toward false NEGATIVE.
 *
 * DECLARED EXCEPTION to the bounded-exec seam (Rule 2 discipline: an
 * exception is stated, never silent): `makeCommandExec` merges stdout and
 * stderr into one stream, but this driver's never-ran taxonomy REQUIRES
 * them separated — a non-zero exit is classified by whether stderr names a
 * pre-run failure (auth, bad flag) while stdout carries the JSON result
 * envelope. Folding the streams would destroy that classification, so the
 * agent spawn keeps its own exec with the same timeout-kill semantics.
 */
export const realAgentExec: AgentExec = (bin, args, opts) => {
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(bin, args as string[], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      timeout: opts.timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '', timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    const status = typeof e.status === 'number' ? e.status : null;
    const signalDeath = e.signal === 'SIGTERM' && status === null;
    // Kill-shaped: died to a signal (no status), or exited with the
    // SIGTERM convention code. A plain failure exit is not kill-shaped.
    const killShaped = signalDeath || e.signal === 'SIGTERM' || status === 143 || status === null;
    const pastDeadline = Date.now() - startedAt >= opts.timeoutMs;
    return {
      code: status,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e.message ?? ''),
      timedOut: signalDeath || (pastDeadline && killShaped),
    };
  }
};

/** Ambient credentials stripped unless the runner explicitly injects them. */
const AMBIENT_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Shape of the claude CLI's `--output-format json` result (the fields the
 *  frame reads; everything else is ignored). */
interface ClaudeJsonResult {
  readonly total_cost_usd?: number;
  readonly num_turns?: number;
  readonly is_error?: boolean;
  readonly modelId?: string;
  readonly model?: string;
  /** Per-model usage map, keyed by CONCRETE model id — present in newer CLI
   *  versions and the only place the id appears in their result JSON (real
   *  runs have reported neither `modelId` nor `model`, leaving the envelope
   *  at "concrete id not reported by driver"). */
  readonly modelUsage?: Record<string, unknown>;
  /** Why the run terminated (`"api_error"` on an auth/credit failure). */
  readonly terminal_reason?: string;
  /** On a failed run this is the CLI's human-readable cause ("Credit
   *  balance is too low"); on a successful run it is the agent's final
   *  message. Read ONLY when the run failed. */
  readonly result?: string;
  /** TRAP — the CLI reports `subtype: "success"` even on a FAILED run
   *  (observed on credit exhaustion, CLI 2.1.222). Never key on it. */
  readonly subtype?: string;
}

/**
 * Both observed API-level failure shapes — invalid key AND credit
 * exhaustion — share this signature on CLI 2.1.222:
 *
 *     is_error: true, terminal_reason: "api_error", num_turns: 1,
 *     total_cost_usd: 0, modelUsage: {}, exit 1  (subtype: "success"!)
 *
 * `num_turns: 1` is why a `!turns` guard can never catch it: the failed
 * call itself counts as a turn.
 */
function apiLevelFailure(result: ClaudeJsonResult): boolean {
  return result.is_error === true || result.terminal_reason === 'api_error';
}

/** Evidence real agent work happened: turns beyond the failed call itself,
 *  or actual spend. Distinguishes "never ran" from "died mid-run". */
function madeProgress(result: ClaudeJsonResult): boolean {
  const turns = typeof result.num_turns === 'number' ? result.num_turns : 0;
  const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0;
  return turns > 1 || cost > 0;
}

/** The CLI's own human-readable failure cause, bounded for a ledger line. */
function failureCause(result: ClaudeJsonResult, fallback: string): string {
  const cause = typeof result.result === 'string' ? result.result.trim() : '';
  return cause ? cause.slice(0, 300) : fallback;
}

/** The concrete model id(s) a result actually used, or undefined. Falls back
 *  to the `modelUsage` keys; a multi-model run discloses all, joined. */
function resolvedModelFrom(result: ClaudeJsonResult): string | undefined {
  if (result.modelId) return result.modelId;
  if (result.model) return result.model;
  const used = result.modelUsage ? Object.keys(result.modelUsage) : [];
  return used.length > 0 ? used.join(' + ') : undefined;
}

const TIER_ALIAS: Record<ModelTier, string> = {
  light: 'haiku',
  standard: 'sonnet',
  deep: 'opus',
};

export function makeClaudeCodeDriver(exec: AgentExec = realAgentExec): AgentDriver {
  return {
    id: 'claude-code',
    // The honest declaration: `--max-turns` genuinely stops the run; cost is
    // only REPORTED in the closing JSON — the CLI cannot stop mid-run on
    // spend, so maxUsd is a post-hoc classification, never an enforcement
    // (the $14.71-against-$5 incident). The dispatch layer clamps max_turns
    // against the committed spend authority because turns are the lever
    // that actually bounds spend here.
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: ['ANTHROPIC_API_KEY'],
    // The Stop hook is this driver's in-loop gate; the runner pre-trusts +
    // probes the wiring pre-spawn and the envelope discloses the result.
    inLoopGateMechanism: 'claude-stop-hook',
    // The pinned executor the managed workflow installs. Bump deliberately
    // (one line, one place) — never float `latest` under an unattended lane.
    cli: { package: '@anthropic-ai/claude-code', version: '2.1.222' },

    resolveModel(tier: ModelTier): string {
      return TIER_ALIAS[tier];
    },

    available(cwd: string) {
      // Detection via the ONE cross-platform PATH resolver (Rule 2) — a raw
      // execFileSync probe throws EINVAL on Windows' `claude.cmd` shim and
      // would report an INSTALLED CLI as missing (the create-dxkit class).
      if (!commandExists('claude', cwd)) {
        return {
          ok: false,
          reason:
            'the claude CLI does not resolve here — install Claude Code ' +
            '(https://claude.com/claude-code) or run with a driver that is installed',
        };
      }
      if (process.platform === 'win32') {
        // exec-host-ok: a DISCLOSED v1 limitation, not host dispatch — the
        // spawn path cannot run a .cmd shim without a shell, and a shell
        // must never see the prompt argv. The managed workflow (ubuntu) is
        // the supported path; say so rather than fail confusingly mid-run.
        return {
          ok: false,
          reason:
            'local remediate runs are not supported on Windows in this version — ' +
            'the scheduled dxkit-remediate workflow (ubuntu) is the supported path',
        };
      }
      return { ok: true };
    },

    async run(opts: AgentRunOptions): Promise<AgentRunResult> {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of AMBIENT_CREDENTIALS) delete env[key];
      Object.assign(env, opts.env);
      env.DXKIT_LOOP_ACTIVE = '1'; // arm the Stop-gate: the loop verifies itself

      // The executor's own build, for the envelope (run provenance). Best
      // effort — an unparseable probe leaves the field absent, disclosed by
      // the ledger, never a failure.
      const versionProbe = exec('claude', ['--version'], {
        cwd: opts.cwd,
        env,
        timeoutMs: 30_000,
      });
      const cliVersion = versionProbe.stdout.match(/(\d+\.\d+\.\d+)/)?.[1];

      const outcome = exec(
        'claude',
        [
          '-p',
          opts.prompt,
          '--dangerously-skip-permissions',
          '--max-turns',
          String(opts.budget.maxTurns),
          '--output-format',
          'json',
          '--model',
          opts.model,
        ],
        { cwd: opts.cwd, env, timeoutMs: opts.budget.maxMinutes * 60_000 },
      );

      const tail = (outcome.stderr || outcome.stdout).trim().split('\n').slice(-6).join('\n');
      const provenance = cliVersion ? { cliVersion } : {};

      if (outcome.timedOut) {
        return { completed: false, timedOut: true, transcriptTail: tail, ...provenance };
      }

      let result: ClaudeJsonResult = {};
      try {
        result = JSON.parse(outcome.stdout || '{}') as ClaudeJsonResult;
      } catch {
        // Non-JSON output: spend/turns unknown; the envelope discloses absence.
      }

      const turns = typeof result.num_turns === 'number' ? result.num_turns : undefined;
      // Never-ran, both shapes: the CLI died before the agent started
      // (non-zero exit, zero turns) OR the API call itself failed with no
      // work done (invalid key, exhausted credit — `num_turns: 1` there, so
      // a turn-count guard alone can never catch it; this shipped a green
      // job over a dead agent).
      const apiFailed = apiLevelFailure(result);
      if ((outcome.code !== 0 && !turns) || (apiFailed && !madeProgress(result))) {
        const fallback = `claude exit ${outcome.code ?? 'null'}: ${tail || '(no stderr)'}`;
        const detail = result.terminal_reason ? ` (${result.terminal_reason})` : '';
        return {
          completed: false,
          timedOut: false,
          neverRan: {
            reason: apiFailed ? `${failureCause(result, fallback)}${detail}` : fallback,
          },
          transcriptTail: tail,
          ...provenance,
        };
      }

      const completed = outcome.code === 0 && result.is_error !== true;
      // An error AFTER real work: verification decides the committed work's
      // fate; the failure itself is disclosed, and a no-diff errored run is
      // a failure outcome downstream, never a benign no-op.
      const failure =
        !completed && (apiFailed || outcome.code !== 0)
          ? {
              failure: {
                reason: apiFailed
                  ? failureCause(result, `claude exit ${outcome.code ?? 'null'}`) +
                    (result.terminal_reason ? ` (${result.terminal_reason})` : '')
                  : `claude exit ${outcome.code ?? 'null'}`,
              },
            }
          : {};
      return {
        completed,
        turns,
        costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
        resolvedModelId: resolvedModelFrom(result),
        timedOut: false,
        transcriptTail: tail,
        // On a COMPLETED run `result` is the agent's final message (#285) —
        // bounded here; the runner records it only for no-op outcomes.
        ...(completed && typeof result.result === 'string' && result.result.trim()
          ? { finalMessage: result.result.trim().slice(0, 4000) }
          : {}),
        ...provenance,
        ...failure,
      };
    },
  };
}
