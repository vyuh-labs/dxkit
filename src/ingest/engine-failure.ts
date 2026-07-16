/**
 * Graceful engine-failure degradation.
 *
 * The ingest CLI refreshes `.dxkit/external/<engine>.json`. The GATE
 * never calls an engine live — it reads the committed snapshot — so an
 * engine failure can never block a PR. What it CAN do is red the
 * refresh job, and a quota / rate-limit / auth / network failure is
 * infrastructure, not a code problem: a red check the team learns to
 * ignore is worse than a stale-but-present snapshot.
 *
 * Policy — the same fail-open-on-infrastructure stance as the
 * correctness floor (Rule 15) and custom checks (Rule 17): when the
 * failure is infrastructure AND a prior snapshot exists, keep the
 * snapshot, disclose the skip, and exit 0. A GENUINE failure (bad
 * config, malformed output, a real analysis error) — or an infra
 * failure with NO snapshot to fall back to — still exits 1 so it gets
 * fixed. Fail-open is never silent (the GateFailure discipline): the
 * skip names the engine, the reason, and the snapshot date the gate
 * continues on, and `doctor` surfaces a chronically stale snapshot so
 * a permanently-broken refresh cannot hide behind the fail-open.
 */
import { readSnapshot } from './snapshot';

/**
 * True when an engine error message describes an infrastructure
 * failure — quota exhaustion, rate limiting, auth, or network — rather
 * than a genuine analysis/configuration failure. Sibling of
 * `isNotEntitled` (ingest-cli), which handles the one 403 that has a
 * better remedy than degrading (the REST→CLI plan fallback).
 *
 * Bias: moderate breadth is safe here because misclassifying a genuine
 * failure as infra degrades to a stale snapshot that doctor's
 * staleness check surfaces, while the reverse (infra read as genuine)
 * re-introduces the red-pipeline failure mode this exists to fix.
 */
export function isEngineInfraFailure(message: string): boolean {
  return (
    // Quota / plan limits (Snyk: "You have used your limit of private tests").
    /\bquota\b/i.test(message) ||
    /rate.?limit/i.test(message) ||
    /(used your|reached the|exceeded (the|your)|over the) .{0,20}limit/i.test(message) ||
    /limit (of|reached|exceeded)/i.test(message) ||
    // HTTP auth / throttling / upstream-availability status codes.
    /\b(401|403|429|502|503|504)\b/.test(message) ||
    /unauthori[sz]ed|forbidden|invalid token|expired token|authentication/i.test(message) ||
    /too many requests|service unavailable|temporarily unavailable|bad gateway/i.test(message) ||
    // Network-level failures (Node errno codes + generic timeouts).
    // `fetch failed` is undici's blanket message for a connection-level
    // failure (the errno hides in err.cause — see failureMessage below);
    // an HTTP-level error resolves with a status instead, so the bare
    // message is reliably network.
    /\b(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/.test(
      message,
    ) ||
    /\btimed? ?out\b/i.test(message) ||
    /fetch failed/i.test(message) ||
    /network (error|failure|issue)/i.test(message)
  );
}

/**
 * An error's message with its `cause` chain unwrapped. Node's fetch
 * (undici) reports every connection failure as a bare `fetch failed`
 * TypeError with the real errno (ECONNREFUSED, ENOTFOUND, …) on
 * err.cause — without unwrapping, the classifier can't see it and the
 * disclosure tells the user nothing actionable.
 */
export function failureMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    if (cur.message) parts.push(cur.message);
    cur = cur.cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return parts.join(': ');
}

/** What the ingest CLI should do about an engine failure. */
export type EngineFailureDisposition =
  | {
      /** Infra failure with a prior snapshot: keep it, disclose, exit 0. */
      action: 'degrade';
      reason: string;
      /** `generatedAt` of the snapshot the gate continues on. */
      snapshotGeneratedAt: string;
    }
  | {
      /** Genuine failure, or infra with nothing to fall back to: exit 1. */
      action: 'fail';
      reason: string;
      /** True when the failure IS infra but no prior snapshot exists —
       *  the renderer says so, since the remedy differs (fix the quota/
       *  token, don't debug the engine config). */
      infra: boolean;
    };

/**
 * Classify an engine failure against the committed snapshot state.
 * Pure decision given (message, snapshot-on-disk); the caller renders
 * and sets the exit code.
 */
export function resolveEngineFailure(
  cwd: string,
  engine: string,
  message: string,
): EngineFailureDisposition {
  if (!isEngineInfraFailure(message)) return { action: 'fail', reason: message, infra: false };
  const prior = readSnapshot(cwd, engine);
  if (!prior) return { action: 'fail', reason: message, infra: true };
  return { action: 'degrade', reason: message, snapshotGeneratedAt: prior.generatedAt };
}

/**
 * Doctor's staleness threshold for `.dxkit/external/<engine>.json`.
 * The managed refresh cadence is weekly; 30 days ≈ four missed
 * refreshes — enough to mean "the refresh is broken, not just skipped
 * once", without flagging repos that refresh manually each month.
 */
export const EXTERNAL_SNAPSHOT_STALE_DAYS = 30;

/** Whole days between a snapshot's `generatedAt` and `now`; null when
 *  the timestamp is missing/unparseable (doctor then skips the check
 *  rather than false-alarm on a hand-edited snapshot). */
export function snapshotAgeDays(generatedAt: string, now: Date): number | null {
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / (24 * 60 * 60 * 1000));
}
