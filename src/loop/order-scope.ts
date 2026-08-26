/**
 * The Stop-gate's ORDER SCOPE (remediate rethink, section 3C): when the
 * remediate lane dispatches ONE work order per agent run, it writes the
 * order's done criterion to `.dxkit/loop/order.json` before the spawn and
 * clears it after — and the Stop-gate consumes it, so "done" is verified
 * IN-SESSION: the agent cannot stop while the order's target findings are
 * still present, and the block reason hands back exactly the ids left to
 * close.
 *
 * One module owns the file's path, shape, writer, and reader (Rule 2: the
 * lane writes what the gate reads, from one definition). Two disciplines
 * are load-bearing:
 *
 *   - EXECUTES NOTHING. The scope check post-processes the guardrail
 *     payload and floor outcome the gate already computed; `command` is
 *     prompt display text, never executed here — so a hostile or corrupt
 *     order file can never widen execution (Rule 17: the Stop-gate must
 *     not widen execution on untrusted trees).
 *   - FAIL-OPEN, never silent. An unreadable or malformed file reads as
 *     "no order scope" (the gate keeps every pre-existing behavior) and the
 *     reader says so via `problem`, which the gate surfaces.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import type { FloorGateOutcome } from './floor-gate';
import { checkKey } from '../analyzers/correctness/attribution';
import { LEDGER_DIR } from './ledger';

export const ORDER_SCOPE_FILE = 'order.json';

/** The lane→gate contract: the order's done criterion, plus display facts. */
export interface OrderScope {
  readonly orderId: string;
  /** The finding ids that must be ABSENT for the order to be done:
   *  baseline fingerprints (guardrail verifier) or floor check keys
   *  (`pack:label[#finding]`, floor verifier). */
  readonly absentIds: readonly string[];
  readonly envelope: { readonly paths: readonly string[]; readonly manifests: boolean };
  readonly verifier: 'floor' | 'guardrail';
  /** The check command the ORDER PROMPT tells the agent to run. Display
   *  text in the block reason only — the gate never executes it. */
  readonly command: string;
}

function scopePath(repoDir: string): string {
  return path.join(repoDir, LEDGER_DIR, ORDER_SCOPE_FILE);
}

/** The lane's writer: called immediately before each order dispatch. */
export function writeOrderScope(repoDir: string, scope: OrderScope): void {
  const file = scopePath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scope, null, 2) + '\n', 'utf8');
}

/** The lane's cleaner: called after each dispatch (try/finally). Best
 *  effort — a leftover file only scopes the next gate run of the SAME
 *  lane process, and the reader validates shape either way. */
export function clearOrderScope(repoDir: string): void {
  try {
    fs.rmSync(scopePath(repoDir), { force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Validating reader. `scope: null` = no order scope (absent file, or a
 *  malformed one — `problem` then says why, so the skip is disclosed). */
export function readOrderScope(repoDir: string): {
  readonly scope: OrderScope | null;
  readonly problem?: string;
} {
  const file = scopePath(repoDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { scope: null }; // absent — the ordinary, non-order-scoped gate run
  }
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const envelope = doc.envelope as Record<string, unknown> | undefined;
    if (
      typeof doc.orderId !== 'string' ||
      !Array.isArray(doc.absentIds) ||
      !doc.absentIds.every((id): id is string => typeof id === 'string') ||
      (doc.verifier !== 'floor' && doc.verifier !== 'guardrail') ||
      typeof doc.command !== 'string' ||
      typeof envelope !== 'object' ||
      envelope === null ||
      !Array.isArray(envelope.paths) ||
      !envelope.paths.every((p): p is string => typeof p === 'string') ||
      typeof envelope.manifests !== 'boolean'
    ) {
      return { scope: null, problem: `order scope at ${file} is malformed — ignoring it` };
    }
    return {
      scope: {
        orderId: doc.orderId,
        absentIds: doc.absentIds,
        envelope: { paths: envelope.paths, manifests: envelope.manifests },
        verifier: doc.verifier,
        command: doc.command,
      },
    };
  } catch (err) {
    return {
      scope: null,
      problem: `order scope at ${file} is unreadable (${err instanceof Error ? err.message : String(err)}) — ignoring it`,
    };
  }
}

/**
 * Which of the order's ids are STILL PRESENT, judged only from what the
 * gate already computed — no re-gather, no execution:
 *
 *   - guardrail verifier: an id is present when any pair's `currentId`
 *     matches (an allowlist-suppressed pair counts — the order asked for
 *     the finding to be CLOSED, not waived);
 *   - floor verifier: an id (`pack:label[#finding]`) is present when its
 *     check key is among the floor's FAILING checks. A floor that did not
 *     run cannot answer — `undecidable` says so (fail-open: the gate then
 *     allows, disclosed, and the frame's post-run verification arbitrates).
 */
export function unresolvedOrderIds(
  scope: OrderScope,
  json: GuardrailJsonPayload,
  floor: FloorGateOutcome,
): { readonly unresolved: readonly string[]; readonly undecidable?: string } {
  if (scope.verifier === 'guardrail') {
    const present = new Set(
      json.pairs.map((p) => p.currentId).filter((id): id is string => id !== undefined),
    );
    return { unresolved: scope.absentIds.filter((id) => present.has(id)) };
  }
  if (floor.kind !== 'ran') {
    return {
      unresolved: [],
      undecidable:
        floor.kind === 'unavailable'
          ? `the correctness floor did not run here (${floor.reason})`
          : `the correctness floor errored (${floor.message})`,
    };
  }
  const failing = new Set(
    floor.result.checks.filter((c) => c.status === 'fail').map((c) => checkKey(c.pack, c.label)),
  );
  return { unresolved: scope.absentIds.filter((id) => failing.has(id.split('#')[0])) };
}

/** The block reason handed to the model: exactly the ids left to close. */
export function buildOrderRepairMessage(scope: OrderScope, unresolved: readonly string[]): string {
  return (
    `dxkit Stop-gate: work order ${scope.orderId} is NOT done — ` +
    `${unresolved.length} of its target finding(s) are still present:\n` +
    unresolved.map((id) => `- ${id}`).join('\n') +
    `\n\nClose exactly these (everything else is out of scope for this order), then try to ` +
    `stop again. Check with: ${scope.command}`
  );
}
