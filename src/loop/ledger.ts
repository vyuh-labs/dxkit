/**
 * Loop ledger — an append-only audit trail of postflight (Stop-gate)
 * events for autonomous coding loops.
 *
 * Every time the Stop-gate runs (whether it allows the loop to stop or
 * blocks it on net-new findings), it appends one line to
 * `.dxkit/loop/ledger.jsonl`. The ledger answers "what did the loop
 * actually do?" — how many completions were blocked, how many net-new
 * findings, and whether the agent repaired after a block.
 *
 * This is deliberately NOT a dashboard. It is a flat JSONL file so a
 * loop can write to it from any process without coordination, and a
 * human (or a benchmark harness) can `cat` / `jq` it directly.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { LoopPreset } from './policy';

/** Bump only on a breaking change to the event shape. */
export const LEDGER_SCHEMA_VERSION = 1;

/** Relative location of the ledger inside a repo. */
export const LEDGER_DIR = path.join('.dxkit', 'loop');
export const LEDGER_FILE = path.join(LEDGER_DIR, 'ledger.jsonl');

/** Status of a deterministic check at the moment the Stop-gate ran. */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'not_configured' | 'skipped';

/**
 * One postflight event. Mirrors the schema in the loop pack spec so
 * the ledger is stable across releases. Optional agent fields are
 * populated when the hook payload carries them (agent teams / subagents).
 */
export interface LedgerEvent {
  readonly schema_version: number;
  readonly timestamp: string;
  readonly event: 'Stop';
  readonly session_id: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly cwd: string;
  readonly branch: string;
  readonly commit: string;
  /** Loop posture in force when the gate ran (`security-only` /
   *  `full-debt`). Optional for forward/backward compat — absent on
   *  events written before presets existed. */
  readonly preset?: LoopPreset;
  /** Outcome of the dxkit guardrail check. */
  readonly guardrail_status: CheckStatus;
  /** Net-new findings that blocked completion (0 when guardrail passed). */
  readonly net_new_findings: number;
  /**
   * Net-new BLOCKED findings broken out by category (identity kind: `secret`,
   * `code`, `dep-vuln`, `custom-check`, `flow-binding`, …). Sums to
   * `net_new_findings`. Optional for forward/backward compat — absent on events
   * written before the metrics series recorded per-category detail, and on
   * cache-replayed events. Drives `vyuh-dxkit metrics`' by-category breakdown.
   */
  readonly categories?: Record<string, number>;
  /** Net-new WARNING-class findings surfaced this gate (non-blocking). Optional
   *  for the same compat reason as `categories`. */
  readonly warn_findings?: number;
  /** Net-new WARNING-class findings broken out by category. Sums to
   *  `warn_findings`. Optional (same compat reason as `categories`). */
  readonly warn_categories?: Record<string, number>;
  /** Size of the prior baseline the current scan was diffed against. */
  readonly baseline_findings: number;
  /** Files changed relative to the baseline commit, when derivable. */
  readonly files_changed: number;
  /**
   * Whether THIS event blocked the loop from stopping. A blocked event
   * is the durable record of "the loop tried to declare done while
   * unsafe." `allowed: true` events are clean completions (or a
   * non-blocking allow after an un-fixable config error).
   */
  readonly allowed: boolean;
  /**
   * True when Claude was already continuing because a prior Stop-gate
   * blocked this turn (the Claude Code `stop_hook_active` flag). Lets
   * the summary distinguish "repaired on first try" from "needed N
   * continuations."
   */
  readonly stop_hook_active: boolean;
  readonly tests_status: CheckStatus;
  readonly lint_status: CheckStatus;
  readonly typecheck_status: CheckStatus;
  /**
   * Correctness-floor availability for this Stop: `ran` when at least one
   * check executed; `unavailable` (disabled / no floor-capable pack /
   * toolchain absent) and `internal-error` (the floor runner itself threw)
   * are DISCLOSED fail-open lanes. The pre-4.2 shape collapsed an internal
   * floor error into a silent null indistinguishable from "no floor
   * configured" — a gate that silently stopped enforcing while looking
   * healthy (the fail-open-gate diagnosability class). Optional for
   * forward/backward compat.
   */
  readonly floor_status?: 'ran' | 'unavailable' | 'internal-error';
  /** The disclosed reason when `floor_status` is not `ran`. */
  readonly floor_detail?: string;
  readonly duration_ms: number;
  /**
   * True when this verdict was replayed from the tree-signature cache
   * (the working tree was byte-identical to the last gather) rather than
   * re-gathered. Optional for forward/backward compat — absent on events
   * written before the cache existed, and on every freshly-gathered event.
   */
  readonly cached?: boolean;
}

/** Best-effort current branch; empty string when not derivable. */
function gitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Best-effort current commit SHA; empty string when not derivable. */
function gitCommit(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Fill in the repo-derived fields (branch, commit) and stamp the
 * schema version + timestamp, so callers only supply the outcome.
 */
export function buildLedgerEvent(
  cwd: string,
  fields: Omit<LedgerEvent, 'schema_version' | 'timestamp' | 'event' | 'branch' | 'commit'> &
    Partial<Pick<LedgerEvent, 'branch' | 'commit'>>,
): LedgerEvent {
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    event: 'Stop',
    branch: fields.branch ?? gitBranch(cwd),
    commit: fields.commit ?? gitCommit(cwd),
    ...fields,
  };
}

/**
 * Append one event to the ledger. Creates `.dxkit/loop/` on demand.
 * Best-effort: a ledger write must never abort the Stop-gate (the
 * gate's verdict matters more than its audit line), so failures are
 * swallowed and reported via the return value.
 */
export function appendLedgerEvent(cwd: string, event: LedgerEvent): boolean {
  try {
    const dir = path.join(cwd, LEDGER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(cwd, LEDGER_FILE), JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Read every ledger event. Returns [] when the ledger is absent. */
export function readLedger(cwd: string): LedgerEvent[] {
  const file = path.join(cwd, LEDGER_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerEvent);
    } catch {
      // Skip a corrupt line rather than failing the whole read — the
      // ledger is append-only and a partial write shouldn't blind the
      // summary to every other event.
    }
  }
  return out;
}

/** Remove the ledger file. Returns true when a file was deleted. */
export function clearLedger(cwd: string): boolean {
  try {
    fs.rmSync(path.join(cwd, LEDGER_FILE));
    return true;
  } catch {
    return false;
  }
}

export interface LedgerSummary {
  readonly total: number;
  readonly allowed: number;
  readonly blocked: number;
  /** Total net-new findings across all blocked events. */
  readonly netNewBlocked: number;
  /**
   * Sessions where a blocked Stop was later followed by a clean
   * (allowed, guardrail-pass) Stop — i.e. the agent repaired the
   * net-new findings after being blocked. The headline "repair-after-
   * block" metric for the Loop-Safety study.
   */
  readonly repairedAfterBlock: number;
  /** Sessions that were blocked at least once and never repaired. */
  readonly unrepairedSessions: number;
}

/**
 * Reduce a list of events to the audit-trail summary. Repair detection
 * is per-session: a session counts as "repaired" if it has at least one
 * blocked event AND a strictly-later allowed event with a passing
 * guardrail. Order is taken from event position (the ledger is
 * append-only, so file order is chronological).
 */
export function summarizeLedger(events: ReadonlyArray<LedgerEvent>): LedgerSummary {
  let allowed = 0;
  let blocked = 0;
  let netNewBlocked = 0;

  // Per-session timeline of (blocked?, repaired?) — repaired means a
  // clean allowed+pass event appeared after the session's first block.
  const blockedAt = new Map<string, number>(); // session → index of first block
  const repairedSessions = new Set<string>();
  const blockedSessions = new Set<string>();

  events.forEach((e, idx) => {
    if (e.allowed) allowed++;
    else {
      blocked++;
      netNewBlocked += e.net_new_findings;
    }

    const sid = e.session_id || '(unknown)';
    if (!e.allowed) {
      blockedSessions.add(sid);
      if (!blockedAt.has(sid)) blockedAt.set(sid, idx);
    } else if (
      e.guardrail_status === 'pass' &&
      blockedAt.has(sid) &&
      idx > (blockedAt.get(sid) as number)
    ) {
      repairedSessions.add(sid);
    }
  });

  return {
    total: events.length,
    allowed,
    blocked,
    netNewBlocked,
    repairedAfterBlock: repairedSessions.size,
    unrepairedSessions: [...blockedSessions].filter((s) => !repairedSessions.has(s)).length,
  };
}
