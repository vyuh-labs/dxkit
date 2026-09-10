/**
 * The machine-readable ATTEMPT RECORD (`.dxkit/cache/remediate-<task>.json`)
 * — the evidence layer that survives the ephemeral runner. Split from
 * `execute.ts` purely for module size (the plan-cli / configured-loop
 * precedent); the executor is its only producer and re-exports
 * `taskRunJson`, so consumers keep one import surface.
 *
 * Two write moments, both best-effort plumbing (never a failure):
 *
 *   - PROVISIONAL, before the driver spawns (#289): a SIGKILL (runner OOM)
 *     is uncatchable, so every disclosure mechanism the frame owns dies
 *     with it — a record written only at finalize meant a killed frame
 *     left zero evidence and any committed work evaporated unrecorded.
 *     The record names how far the run got (`phase: 'agent'`) and carries
 *     `baseHead`, so the workflow's evidence step can format-patch
 *     `baseHead..HEAD` of whatever the agent committed before death.
 *   - FINAL, at every executor exit (pre-push with landed:false, then
 *     overwritten by finalize), so the workflow's artifact step can upload
 *     the diff of a blocked or failed attempt.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { TaskRun } from './execute';
import type { LandingDisclosure } from './land';

/** See the module doc: the pre-spawn record a SIGKILL leaves behind. */
export function writeProvisionalRecord(cwd: string, taskId: string, baseHead: string): void {
  try {
    const dir = path.join(cwd, '.dxkit', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `remediate-${taskId}.json`),
      JSON.stringify(
        {
          phase: 'agent',
          outcome: 'provisional',
          task: taskId,
          landed: false,
          baseHead,
          head: null,
          note:
            'provisional record written before the agent spawned — if this survives the run, ' +
            'the frame died mid-agent-phase (it could not write its own obituary); partial ' +
            'work, if any, is in the baseHead..HEAD range of the checkout',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  } catch {
    // evidence plumbing, never a failure
  }
}

/**
 * Phrase a landing failure for the record + job log: the git/gh output is
 * the evidence, and a rules/permissions-shaped refusal names the remedy —
 * the class exists on every GitHub repo (a GITHUB_TOKEN push touching
 * workflow files is refused without the `workflows` permission), not only
 * where a push ruleset restricts paths.
 */
export function describeLandingFailure(err: unknown): string {
  const e = err as { message?: string; stderr?: string | Buffer };
  const stderr = (e.stderr ?? '').toString().trim();
  const message = (e.message ?? String(err)).split('\n')[0];
  const evidence = stderr ? `${message}\n${stderr}` : message;
  const rulesShaped =
    /\b403\b|GH006|GH013|protected branch|ruleset|refusing to allow|permission/i.test(evidence);
  const remedy = rulesShaped
    ? '\nThis looks like a repository-rules or token-permissions refusal. Remedies: grant ' +
      'the workflow token the permission the push needs (e.g. the `workflows` permission ' +
      'for workflow-file changes), add a ruleset bypass for the bot, or keep the task ' +
      'away from the restricted paths (a prompt-level constraint like "do not touch ' +
      '.github/" holds in practice).'
    : '';
  return (
    `the landing push/PR was refused — the verified work did NOT land, but the attempt ` +
    `record and ledger carry the evidence (branch state left for inspection).\n${evidence}${remedy}`
  );
}

/** HEAD of the checkout, or null (evidence plumbing, never a failure). */
export function currentHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** The final record — written pre-push (landed:false) AND at every
 *  finalize, so the evidence exists no matter where the landing dies. */
export function writeAttemptRecord(cwd: string, taskId: string, run: TaskRun): void {
  try {
    const dir = path.join(cwd, '.dxkit', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `remediate-${taskId}.json`),
      JSON.stringify(taskRunJson(run), null, 2) + '\n',
      'utf8',
    );
  } catch {
    // the record is evidence plumbing, never a failure
  }
}

/** The record's projection of what a landing left behind (#372): the
 *  branch HEAD was actually pushed to (null until something landed, so
 *  the field never names a branch HEAD never reached), the PR, and the
 *  disclosures. ONE projection: the final record and the deferred land
 *  step's patch both spread it. */
export function landingRecordFields(d: Partial<LandingDisclosure>): Record<string, unknown> {
  return {
    branch: d.landedBranch ?? null,
    prUrl: d.prUrl ?? null,
    standingPreserved: d.standingPreserved ?? null,
    draftFlipped: d.draftFlipped ?? null,
    supersededAttemptPr: d.supersededAttemptPr ?? null,
  };
}

export function taskRunJson(run: TaskRun): Record<string, unknown> {
  const r = run.result;
  return {
    // The frame reached finalize — distinguishes this record from the
    // provisional one a SIGKILL leaves behind (#289).
    phase: 'final',
    outcome: r.outcome,
    task: r.task ?? null,
    note: r.note ?? null,
    partial: r.partial ?? false,
    envelope: r.envelope ?? null,
    orders: r.orders ?? null,
    guardrailVerdict: r.guardrailVerdict ?? null,
    ...landingRecordFields(run),
    landRefused: run.landRefused ?? null,
    landingBlocked: run.landingBlocked ?? null,
    landingDeferred: run.landingDeferred ?? null,
    landed: run.landed,
    // The commit range of the attempt — what the workflow's evidence step
    // format-patches into a run artifact when nothing landed.
    baseHead: r.baseHead ?? null,
    head: r.head ?? null,
    // Failure evidence (machine-readable record only — never the PR body).
    transcriptTail: r.transcriptTail ?? null,
    // The agent's own account of a no-op (#285) — autopsiable, never rendered.
    agentFinalMessage: r.agentFinalMessage ?? null,
    ledger: r.ledger,
  };
}
