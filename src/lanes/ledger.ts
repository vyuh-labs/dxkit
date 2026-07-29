/**
 * The delivery ledger (remediate design §10) — what the scheduled lanes
 * DELIVERED, as committed evidence. The loop ledger answers "what did the
 * gate PREVENT" (interceptions); this one answers "what did the robot lanes
 * actually land" — advisories closed by the bump lane, remediations landed
 * by the agent lane, and what the agent lane spent doing it.
 *
 * The number is ungameable by construction: a lane appends its run event to
 * this ledger AS PART OF the standing PR's own diff, so the event reaches
 * the default branch exactly when the PR MERGES. A PR that never merges
 * delivered nothing; non-landing outcomes (floor-red, no-op, refused) never
 * write an event at all — they live in job summaries, not in the count.
 *
 * ONE module for every lane (Rule 2), one JSONL file per standing-PR
 * identity (`.dxkit/lanes/dep-bump.jsonl`, `remediate-fix-vulns.jsonl`) so
 * concurrent standing PRs from different lanes can never merge-conflict on
 * a shared file. `vyuh-dxkit metrics` reads the whole directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readJsonlFile } from '../jsonl';

export const LANES_DIR = path.join('.dxkit', 'lanes');

/** Bump only on a breaking change to the event shape. */
export const LANE_LEDGER_SCHEMA_VERSION = 1;

export interface LaneFindingsClosed {
  readonly kind: string;
  readonly count: number;
}

export interface LaneEvent {
  readonly schema_version: number;
  /** ISO timestamp, supplied by the writing lane. */
  readonly timestamp: string;
  readonly lane: 'dep-bump' | 'remediate' | string;
  readonly task?: string;
  /** Always a LANDED shape — only landing writes an event. `partial` marks a
   *  budget-bounded draft that a reviewer chose to merge anyway. */
  readonly outcome: 'landed';
  readonly partial?: boolean;
  readonly findingsClosed?: readonly LaneFindingsClosed[];
  readonly costUsd?: number;
  readonly resolvedModelId?: string;
  readonly driver?: string;
}

/** Ledger file for a standing-PR identity, repo-relative POSIX. */
export function laneLedgerPath(lane: string, task?: string): string {
  return `${LANES_DIR.replace(/\\/g, '/')}/${lane}${task ? `-${task}` : ''}.jsonl`;
}

/**
 * Append one event (creating the directory/file as needed) and return the
 * repo-relative ledger path — the caller commits it so the event rides the
 * standing PR's diff.
 */
export function appendLaneEvent(cwd: string, event: LaneEvent): string {
  const rel = laneLedgerPath(event.lane, event.task);
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(event) + '\n', 'utf8');
  return rel;
}

/**
 * Every event in the lanes directory, oldest first. Fail-open per line
 * (a corrupt line is skipped, never a crash) and per schema (an event from
 * a NEWER schema version is skipped — this dxkit cannot interpret it, and a
 * wrong reading is worse than a disclosed absence).
 */
export function readLaneEvents(cwd: string): LaneEvent[] {
  const dir = path.join(cwd, LANES_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const events: LaneEvent[] = [];
  for (const file of files) {
    // Line mechanics via the ONE fail-open JSONL reader; event VALIDATION
    // (schema ceiling, required fields) stays here where the shape lives.
    for (const raw of readJsonlFile(path.join(dir, file))) {
      const parsed = raw as LaneEvent;
      if (
        typeof parsed?.schema_version === 'number' &&
        parsed.schema_version <= LANE_LEDGER_SCHEMA_VERSION &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.lane === 'string' &&
        parsed.outcome === 'landed'
      ) {
        events.push(parsed);
      }
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ─── The delivered reducer (consumed by `vyuh-dxkit metrics`) ───────────────

export interface LaneDeliveredSummary {
  readonly lane: string;
  readonly landed: number;
  readonly partial: number;
  /** Findings closed by kind (e.g. dep-vuln advisories the bump lane shut). */
  readonly findingsClosed: Readonly<Record<string, number>>;
  /** Total agent spend, when the lane reports it. */
  readonly costUsd?: number;
}

export interface DeliveredReport {
  readonly events: number;
  readonly span: { readonly from?: string; readonly to?: string };
  readonly lanes: readonly LaneDeliveredSummary[];
  /** Total spend across all lanes that report cost. */
  readonly totalCostUsd?: number;
}

/** Pure reducer over lane events (optionally window-scoped, epoch ms). */
export function computeDelivered(
  events: readonly LaneEvent[],
  opts: { readonly sinceMs?: number } = {},
): DeliveredReport {
  const inScope = events.filter(
    (e) => opts.sinceMs === undefined || Date.parse(e.timestamp) >= opts.sinceMs,
  );
  const byLane = new Map<
    string,
    { landed: number; partial: number; closed: Map<string, number>; cost: number; hasCost: boolean }
  >();
  for (const e of inScope) {
    const s = byLane.get(e.lane) ?? {
      landed: 0,
      partial: 0,
      closed: new Map<string, number>(),
      cost: 0,
      hasCost: false,
    };
    s.landed += 1;
    if (e.partial) s.partial += 1;
    for (const fc of e.findingsClosed ?? []) {
      s.closed.set(fc.kind, (s.closed.get(fc.kind) ?? 0) + fc.count);
    }
    if (typeof e.costUsd === 'number') {
      s.cost += e.costUsd;
      s.hasCost = true;
    }
    byLane.set(e.lane, s);
  }

  const lanes: LaneDeliveredSummary[] = [...byLane.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lane, s]) => ({
      lane,
      landed: s.landed,
      partial: s.partial,
      findingsClosed: Object.fromEntries([...s.closed.entries()].sort()),
      ...(s.hasCost ? { costUsd: round2(s.cost) } : {}),
    }));

  const costs = lanes.filter((l) => l.costUsd !== undefined).map((l) => l.costUsd!);
  return {
    events: inScope.length,
    span: {
      ...(inScope.length > 0
        ? { from: inScope[0].timestamp, to: inScope[inScope.length - 1].timestamp }
        : {}),
    },
    lanes,
    ...(costs.length > 0 ? { totalCostUsd: round2(costs.reduce((a, b) => a + b, 0)) } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
