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
 *   - "agent never ran" detection: a non-zero exit with zero turns means the
 *     CLI died before the agent started (auth, bad flag) — reported as its
 *     own outcome, never read downstream as "agent made no change";
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
 * DECLARED EXCEPTION to the bounded-exec seam (Rule 2 discipline: an
 * exception is stated, never silent): `makeCommandExec` merges stdout and
 * stderr into one stream, but this driver's never-ran taxonomy REQUIRES
 * them separated — a non-zero exit is classified by whether stderr names a
 * pre-run failure (auth, bad flag) while stdout carries the JSON result
 * envelope. Folding the streams would destroy that classification, so the
 * agent spawn keeps its own exec with the same timeout-kill semantics.
 */
export const realAgentExec: AgentExec = (bin, args, opts) => {
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
    return {
      code: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e.message ?? ''),
      timedOut: e.signal === 'SIGTERM' && typeof e.status !== 'number',
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
    budgetSupport: { turns: true, cost: true },
    credentialEnv: ['ANTHROPIC_API_KEY'],

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

      if (outcome.timedOut) {
        return { completed: false, timedOut: true, transcriptTail: tail };
      }

      let result: ClaudeJsonResult = {};
      try {
        result = JSON.parse(outcome.stdout || '{}') as ClaudeJsonResult;
      } catch {
        // Non-JSON output: spend/turns unknown; the envelope discloses absence.
      }

      const turns = typeof result.num_turns === 'number' ? result.num_turns : undefined;
      if (outcome.code !== 0 && !turns) {
        return {
          completed: false,
          timedOut: false,
          neverRan: { reason: `claude exit ${outcome.code ?? 'null'}: ${tail || '(no stderr)'}` },
          transcriptTail: tail,
        };
      }

      return {
        completed: outcome.code === 0 && result.is_error !== true,
        turns,
        costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
        resolvedModelId: resolvedModelFrom(result),
        timedOut: false,
        transcriptTail: tail,
      };
    },
  };
}
