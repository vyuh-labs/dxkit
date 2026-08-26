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
 * lane writes what the gate reads, from one definition). Three disciplines
 * are load-bearing:
 *
 *   - EXECUTES NOTHING. The scope check post-processes the guardrail
 *     payload and floor outcome the gate already computed; `command` is
 *     prompt display text, never executed here — so a hostile or corrupt
 *     order file can never widen execution (Rule 17: the Stop-gate must
 *     not widen execution on untrusted trees).
 *   - FAIL-OPEN, never silent. An unreadable, malformed, foreign, or stale
 *     file reads as "no order scope" (the gate keeps every pre-existing
 *     behavior) and the reader says so via `problem`, which the gate
 *     surfaces. Likewise, a done question the gate's own data cannot answer
 *     — an unobserved finding kind, a skipped floor check — is UNDECIDABLE
 *     with the reason named, never a silent "done" (the Rule 19
 *     discipline: absence of observation is not absence of findings).
 *   - SESSION-BOUND. The file is repo-global, so a SIGKILLed lane or a
 *     concurrent lane must not scope someone else's session: the writer
 *     stamps a per-run TOKEN (the lane also injects it into the agent's
 *     env as DXKIT_ORDER_TOKEN, which the Stop hook inherits) plus a
 *     timestamp; the reader treats a token mismatch, a missing session
 *     token, or an over-age file as absent-with-disclosure.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GuardrailJsonPayload } from '../baseline/check-renderers';
import type { CorrectnessCheckResult } from '../analyzers/correctness/run';
import type { FloorGateOutcome } from './floor-gate';
import { checkKey } from '../analyzers/correctness/attribution';
import { LEDGER_DIR } from './ledger';

export const ORDER_SCOPE_FILE = 'order.json';

/** Env var carrying the dispatching lane's order token into the agent's
 *  process tree (the Stop hook inherits it). */
export const ORDER_TOKEN_ENV = 'DXKIT_ORDER_TOKEN';

/** A scope older than this is stale regardless of token (belt and braces
 *  over the env binding — no order run may legally outlive it). */
export const ORDER_SCOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The lane→gate contract: the order's done criterion, plus display facts. */
export interface OrderScope {
  readonly orderId: string;
  /** The finding ids that must be ABSENT for the order to be done:
   *  baseline fingerprints (guardrail verifier) or floor check keys
   *  (`pack:label[#finding]`, floor verifier). */
  readonly absentIds: readonly string[];
  /** The finding KINDS behind `absentIds` — what the guardrail arm checks
   *  observation for (an unobserved kind makes the question undecidable,
   *  never silently done). */
  readonly kinds: readonly string[];
  readonly envelope: { readonly paths: readonly string[]; readonly manifests: boolean };
  readonly verifier: 'floor' | 'guardrail';
  /** The check command the ORDER PROMPT tells the agent to run. Display
   *  text in the block reason only — the gate never executes it. */
  readonly command: string;
  /** Session binding: matches the dispatching lane's DXKIT_ORDER_TOKEN. */
  readonly token: string;
  /** ISO timestamp of the write (the age bound reads it). */
  readonly writtenAt: string;
}

/** A fresh per-run token for the writer + the agent env. */
export function newOrderScopeToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function scopePath(repoDir: string): string {
  return path.join(repoDir, LEDGER_DIR, ORDER_SCOPE_FILE);
}

/** The lane's writer: called immediately before each order dispatch
 *  (overwrites any stale leftover from a killed prior lane). */
export function writeOrderScope(repoDir: string, scope: OrderScope): void {
  const file = scopePath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scope, null, 2) + '\n', 'utf8');
}

/** The lane's cleaner: called after each dispatch (try/finally). Best
 *  effort — a leftover file is neutralized by the session binding either
 *  way. */
export function clearOrderScope(repoDir: string): void {
  try {
    fs.rmSync(scopePath(repoDir), { force: true });
  } catch {
    // best-effort cleanup
  }
}

export interface OrderScopeReadOptions {
  /** The session's own order token (default: process.env.DXKIT_ORDER_TOKEN).
   *  A scope whose token does not match — including when the session has
   *  none — is foreign/stale and reads as absent-with-disclosure. */
  readonly expectedToken?: string | undefined;
  /** Clock for the age bound (tests). */
  readonly now?: () => number;
}

/** Validating reader. `scope: null` = no order scope (absent file, or a
 *  malformed / foreign / stale one — `problem` then says why, so the skip
 *  is disclosed). */
export function readOrderScope(
  repoDir: string,
  opts: OrderScopeReadOptions = {},
): { readonly scope: OrderScope | null; readonly problem?: string } {
  const file = scopePath(repoDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { scope: null }; // absent — the ordinary, non-order-scoped gate run
  }
  let scope: OrderScope;
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const envelope = doc.envelope as Record<string, unknown> | undefined;
    const strings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x): x is string => typeof x === 'string');
    if (
      typeof doc.orderId !== 'string' ||
      !strings(doc.absentIds) ||
      !strings(doc.kinds) ||
      (doc.verifier !== 'floor' && doc.verifier !== 'guardrail') ||
      typeof doc.command !== 'string' ||
      typeof doc.token !== 'string' ||
      typeof doc.writtenAt !== 'string' ||
      typeof envelope !== 'object' ||
      envelope === null ||
      !strings(envelope.paths) ||
      typeof envelope.manifests !== 'boolean'
    ) {
      return { scope: null, problem: `order scope at ${file} is malformed — ignoring it` };
    }
    scope = {
      orderId: doc.orderId,
      absentIds: doc.absentIds,
      kinds: doc.kinds,
      envelope: { paths: envelope.paths, manifests: envelope.manifests },
      verifier: doc.verifier,
      command: doc.command,
      token: doc.token,
      writtenAt: doc.writtenAt,
    };
  } catch (err) {
    return {
      scope: null,
      problem: `order scope at ${file} is unreadable (${err instanceof Error ? err.message : String(err)}) — ignoring it`,
    };
  }
  // Session binding: the file is repo-global, so a killed lane's leftover
  // or a concurrent lane's write must not scope THIS session's stops.
  const expected = 'expectedToken' in opts ? opts.expectedToken : process.env[ORDER_TOKEN_ENV];
  if (!expected || scope.token !== expected) {
    return {
      scope: null,
      problem:
        `order scope at ${file} belongs to a different lane session ` +
        `(${expected ? 'token mismatch' : 'no order token in this session'}) — ignoring it`,
    };
  }
  const writtenAt = Date.parse(scope.writtenAt);
  const now = (opts.now ?? Date.now)();
  if (!Number.isFinite(writtenAt) || now - writtenAt > ORDER_SCOPE_MAX_AGE_MS) {
    return {
      scope: null,
      problem: `order scope at ${file} is stale (written ${scope.writtenAt}) — ignoring it`,
    };
  }
  return { scope };
}

/** Is any order scope PRESENT on disk (bound to this session or not)? The
 *  verdict-cache bypass reads this: a cached ALLOW must not replay over a
 *  pending order, and a malformed/foreign file still means "something is
 *  scoping stops here" — re-derive rather than replay. */
export function orderScopePresent(repoDir: string): boolean {
  try {
    return fs.existsSync(scopePath(repoDir));
  } catch {
    return false;
  }
}

/** Per-id floor done-ness, judged at FINDING level where the check carries
 *  per-finding identities (Rule 2.30: this is the ONE computation — the
 *  Stop-gate's floor arm and the ledger's per-order done disclosure both
 *  read it, so they cannot drift). */
export interface FloorDoneVerdict {
  /** Ids whose own failure is still observed (check fails and, for a
   *  finding-level id, its finding is among the check's current ones). */
  readonly open: readonly string[];
  /** Ids the floor could not decide (check absent from the run, skipped,
   *  or failing without the finding decomposition a suffixed id needs). */
  readonly undecided: readonly string[];
  /** Ids whose own finding is gone while the shared check still fails on
   *  OTHER findings (a sibling order's) — done, with disclosure. */
  readonly siblingOnly: readonly string[];
}

export function floorOrderDone(
  absentIds: readonly string[],
  checks: readonly Pick<CorrectnessCheckResult, 'pack' | 'label' | 'status' | 'findings'>[],
): FloorDoneVerdict {
  const byKey = new Map(checks.map((c) => [checkKey(c.pack, c.label), c] as const));
  const open: string[] = [];
  const undecided: string[] = [];
  const siblingOnly: string[] = [];
  for (const id of absentIds) {
    const hash = id.indexOf('#');
    const key = hash === -1 ? id : id.slice(0, hash);
    const finding = hash === -1 ? undefined : id.slice(hash + 1);
    const check = byKey.get(key);
    if (!check || check.status.startsWith('skipped')) {
      undecided.push(id);
      continue;
    }
    if (check.status === 'pass') continue; // closed
    // status === 'fail'
    if (finding === undefined) {
      open.push(id);
      continue;
    }
    if (!check.findings) {
      // A finding-level id against a failure that did not decompose: own
      // vs sibling cannot be told apart — undecided, never silently done.
      undecided.push(id);
      continue;
    }
    if (check.findings.includes(finding)) open.push(id);
    else siblingOnly.push(id);
  }
  return { open, undecided, siblingOnly };
}

/** The gate's answer for one scope, judged only from what the gate already
 *  computed — no re-gather, no execution. */
export interface OrderScopeVerdict {
  /** Ids still present: block, naming exactly these. */
  readonly unresolved: readonly string[];
  /** The done question could not be answered — allow, disclosed (the
   *  frame's post-run verification arbitrates). */
  readonly undecidable?: string;
  /** Done, but with a fact the operator should see (sibling findings keep
   *  the shared check red). Rides the allow's stderr. */
  readonly disclosure?: string;
}

export function unresolvedOrderIds(
  scope: OrderScope,
  json: GuardrailJsonPayload,
  floor: FloorGateOutcome,
): OrderScopeVerdict {
  if (scope.verifier === 'guardrail') {
    // Observation first (Rule 19): a kind the gate run never observed — a
    // ref-mode-excluded kind, an unobserved check — cannot be read as
    // "closed"; absence of a pair is then absence of observation.
    const unobserved = new Set<string>([
      ...(json.notObserved ?? []).map((d) => String(d.kind)),
      ...(json.refExcludedKinds ?? []).map((e) => String(e.kind)),
    ]);
    const blind = scope.kinds.filter((k) => unobserved.has(k));
    if (blind.length > 0) {
      return {
        unresolved: [],
        undecidable:
          `the gate run did not observe kind(s) ${blind.join(', ')} ` +
          `(not gated in this mode, or the producing check did not run), so the order's ` +
          `findings cannot be read as closed`,
      };
    }
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
  const done = floorOrderDone(scope.absentIds, floor.result.checks);
  if (done.open.length > 0) return { unresolved: done.open };
  if (done.undecided.length > 0) {
    return {
      unresolved: [],
      undecidable:
        `the floor could not decide ${done.undecided.length} of the order's target ` +
        `finding(s) (${done.undecided.join(', ')}) — the producing check was skipped, ` +
        `absent, or failed without its finding decomposition`,
    };
  }
  if (done.siblingOnly.length > 0) {
    return {
      unresolved: [],
      disclosure:
        `work order ${scope.orderId}: its own target finding(s) are closed; the shared ` +
        `check still fails on findings outside this order (another order's scope)`,
    };
  }
  return { unresolved: [] };
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
