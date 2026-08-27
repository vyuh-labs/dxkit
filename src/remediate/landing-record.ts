/**
 * The LANDING RECORD: two-phase landing for the remediate lane (4.4.7).
 *
 * The defect this closes: GitHub App installation tokens are hard-capped
 * at one hour, and the remediate task step's verify phases scale with repo
 * size (repeated frozen installs + the guardrail on a large tree), so the
 * landing push could fire long after mint: 401, git prompt fallback, every
 * push lost (landing, salvage draft, order-outcome ledger: the circuit
 * breaker went blind). The old mitigation clamped the AGENT wall clock,
 * which bounds the wrong thing: the verify tail is not under it.
 *
 * Root fix: credential freshness is made independent of task duration.
 * When the lane workflow signals deferred landing (the env var below, set
 * on the task step by the workflow template), the task step performs
 * everything up to and including verification + PR-body assembly, then
 * writes ONE record here instead of pushing. A separate workflow step
 * AFTER the task re-mints the App token fresh and runs `remediate land`
 * (`land-cli.ts`), which validates the record and performs every push.
 * Local/inline runs (no env) keep the immediate landing through the same
 * `landRemediateHead`, one landing primitive at two moments (Rule 2).
 *
 * The record is repo-local MUTABLE state under `.dxkit/cache/` (gitignored
 * runtime artifact, never committed). Everything read back from it is
 * VALIDATED before any git/gh spawn: shas must be hex, the branch must be
 * the task's own standing branch (recomputed, never trusted), ledger paths
 * must be repo-relative without traversal (the same argument-injection
 * discipline as `remote-ref.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { remediateBranchFor } from '../lanes/branches';
import type { OrderOutcomeRow } from '../lanes/order-ledger';
import type { RemediateOutcome } from './outcome';

/**
 * The deferred-landing signal, set (to '1') on the workflow template's task
 * step. ONE name: the template, the executor, and the budget clamp all
 * derive from this constant (pinned by test/templates-lane-tokens.test.ts).
 */
export const DEFERRED_LANDING_ENV = 'DXKIT_DEFERRED_LANDING';

/** Is deferred landing requested by this environment? Strictly '1', the
 *  one value the template sets; anything else reads as "not deferred". */
export function deferredLandingRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[DEFERRED_LANDING_ENV] === '1';
}

export const LANDING_RECORD_SCHEMA = 'remediate-landing.v1';

export interface LandingRecord {
  readonly schema: typeof LANDING_RECORD_SCHEMA;
  readonly task: string;
  /**
   * What the land step must do:
   *   - 'land': push the verified HEAD to the standing branch and
   *     open/update the standing PR (the deferred `landRemediateHead`);
   *   - 'publish-rows': only the order-outcome ledger rows need durability
   *     (a non-landing outcome, the deferred `publishOrderRows`).
   */
  readonly action: 'land' | 'publish-rows';
  /** The task's standing branch, recomputed and cross-checked at read
   *  time, never trusted from disk. */
  readonly branch: string;
  /** The verified HEAD the landing push expects (null when the executor
   *  could not read HEAD; the land step then refuses, remedy named). */
  readonly head: string | null;
  readonly outcome: RemediateOutcome;
  /** Landing fields, present when action is 'land'. */
  readonly baseHead?: string;
  readonly defaultBranch?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly draft?: boolean;
  /** Repo-relative delivery-ledger file the task step already wrote into
   *  the working tree (committed by the lander at land time). */
  readonly ledgerPath?: string;
  /**
   * This run's order-outcome rows, carried IN the record: the compose step
   * (which reads the standing branch) and the push both move to land time,
   * where the credential is fresh: a task-time compose against an expired
   * token would silently drop the branch's prior rows.
   */
  readonly orderRows: readonly OrderOutcomeRow[];
  /** Set by a failed land attempt whose bookkeeping commit advanced HEAD,
   *  disclosed so a retry knows why the expected head moved. */
  readonly headAdvancedNote?: string;
}

/** Repo-relative record path for a task. */
export function landingRecordPath(taskId: string): string {
  return `.dxkit/cache/remediate-landing-${taskId}.json`;
}

/** Write the record (the executor's deferred exit). Throws on I/O failure:
 *  a record that failed to write means the work would never land, so the
 *  caller discloses it as a landing failure, never a silent success. */
export function writeLandingRecord(cwd: string, record: LandingRecord): string {
  const rel = landingRecordPath(record.task);
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return rel;
}

/** Remove the record (after a successful landing, or when a deferred run
 *  ends with nothing to deliver). Best-effort: the record is runtime
 *  state, and a leftover no-op record is disclosed, not harmful. */
export function clearLandingRecord(cwd: string, taskId: string): void {
  try {
    fs.rmSync(path.join(cwd, landingRecordPath(taskId)), { force: true });
  } catch {
    // runtime-state cleanup, never a failure
  }
}

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_SHA_RE = /^[0-9a-f]{7,64}$/;
// A branch/ref name we are willing to pass to git/gh: no leading '-' (never
// readable as a flag), no whitespace, no '..' (refname + traversal safety).
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Is this a repo-relative POSIX path safe to hand to `git add -- <p>`?
 *  Relative, no traversal, no leading '-'. */
function safeRepoRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false;
  if (p.startsWith('/') || p.startsWith('-') || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

export type LandingRecordRead =
  | { readonly record: LandingRecord }
  | { readonly error: string }
  | null;

/**
 * Read + VALIDATE the record for a task. `null` = no record (nothing was
 * deferred, the disclosed no-op). An invalid or foreign record is an
 * `error` with the remedy named; the land step then refuses, and it never
 * pushes what it cannot validate.
 */
export function readLandingRecord(cwd: string, taskId: string): LandingRecordRead {
  if (!TASK_ID_RE.test(taskId)) {
    return { error: `invalid task id '${taskId}': expected lowercase letters/digits/dashes` };
  }
  const abs = path.join(cwd, landingRecordPath(taskId));
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: `landing record at ${landingRecordPath(taskId)} is not valid JSON; re-run the task to regenerate it`,
    };
  }
  const r = parsed as Partial<LandingRecord>;
  const bad = (why: string): { error: string } => ({
    error:
      `landing record at ${landingRecordPath(taskId)} failed validation (${why}): ` +
      `refusing to push from it; re-run the task to regenerate the record`,
  });
  if (r.schema !== LANDING_RECORD_SCHEMA) {
    return bad(
      `schema '${String(r.schema)}' is not ${LANDING_RECORD_SCHEMA} (written by a different dxkit build)`,
    );
  }
  if (r.task !== taskId) return bad(`record is for task '${String(r.task)}', not '${taskId}'`);
  if (r.action !== 'land' && r.action !== 'publish-rows') {
    return bad(`unknown action '${String(r.action)}'`);
  }
  // The branch is CROSS-CHECKED against the recomputed name, never taken
  // from disk on trust, so the record cannot redirect a push.
  if (r.branch !== remediateBranchFor(taskId)) {
    return bad(`branch '${String(r.branch)}' is not the task's standing branch`);
  }
  if (
    !Array.isArray(r.orderRows) ||
    r.orderRows.some((row) => typeof row !== 'object' || row === null)
  ) {
    return bad('orderRows is not an array of row objects');
  }
  if (r.action === 'land') {
    if (typeof r.head !== 'string' || !HEX_SHA_RE.test(r.head)) {
      return bad('no valid verified head sha (hex) recorded');
    }
    if (typeof r.defaultBranch !== 'string' || !REF_NAME_RE.test(r.defaultBranch)) {
      return bad('no valid default branch recorded');
    }
    if (typeof r.prTitle !== 'string' || r.prTitle === '') return bad('no PR title recorded');
    if (typeof r.prBody !== 'string') return bad('no PR body recorded');
    if (r.ledgerPath !== undefined && !safeRepoRelativePath(r.ledgerPath)) {
      return bad(`ledger path '${String(r.ledgerPath)}' is not a safe repo-relative path`);
    }
    if (r.baseHead !== undefined && !HEX_SHA_RE.test(String(r.baseHead))) {
      return bad('baseHead is not a hex sha');
    }
    if (r.draft !== undefined && typeof r.draft !== 'boolean') return bad('draft is not a boolean');
  }
  return { record: r as LandingRecord };
}
