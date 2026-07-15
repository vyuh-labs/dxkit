/**
 * Recall attribution — the ONE definition of "what determines what a finding
 * kind can SEE" (CLAUDE.md Rule 19).
 *
 * # Why this exists
 *
 * The guardrail reports `net-new` — a claim about CAUSE ("you introduced this")
 * — derived from a DELTA (`current \ baseline`). A delta has six possible
 * causes and exactly one of them should gate:
 *
 *   1. the developer introduced a finding                    <- should gate
 *   2. dxkit did not fully OBSERVE the current side
 *   3. dxkit reported a PREFIX of the current side
 *   4. the finding MOVED                                     <- the matcher
 *   5. the TOOL changed (version / plugins / rules / config)
 *   6. dxkit itself changed what it can see
 *
 * Causes 2, 3, 5 and 6 are indistinguishable from cause 1 at the diff, so
 * without this module the gate reports the delta and names the developer. The
 * law:
 *
 *   > A finding delta may be attributed to the developer only if every other
 *   > cause is ruled out. A kind that cannot rule them out does not report
 *   > `net-new` — it reports "cannot attribute", and says why.
 *
 * A `RecallContext` is the evidence that rules out causes 5 and 6. Two
 * finding-sets are comparable iff their contexts match. This is NOT identity
 * (Rule 9, which asks "are these the same finding?"); it is COMPARABILITY
 * ("could these two sets even be diffed?").
 *
 * # Why the registry, and not another hardcoded list
 *
 * The mechanism this replaces was already present but inert, because the one
 * concept was computed in two independent places with two different hardcoded
 * lists:
 *
 *   - `create.ts:addTools` — a global union of THREE provenance tools, feeding
 *     `toolchainHash` (the producer side);
 *   - `check.ts:buildToolsByKind` — a per-kind map of FIVE kinds (the consumer
 *     side, the one that actually decides).
 *
 * Neither derived from the other, so `custom-check` (and `duplication`,
 * `large-file`, `test-gap`, …) fell off the end of the consumer map and
 * `kindHasDriftingTool` returned false unconditionally for them: no amount of
 * tool drift could EVER demote a lint finding to `tooling_drift`. That is
 * CLAUDE.md 2.30's semantic-divergence class — one concept, two lossy
 * projections, in different files, with no shared token to grep. Nobody forgot
 * to wire lint in; there was nothing to wire it into.
 *
 * So recall is declared ONCE, per kind, by the producer that owns the kind
 * (Rule 10), and BOTH sides read this module. `create.ts` unions the contexts
 * into the baseline; `check.ts` compares them per kind. `tools` /
 * `toolchainHash` become a display projection of the union — nothing attributes
 * off them any more.
 *
 * # Fail-open, but never silent
 *
 * Drift NEVER blocks: a tool upgrade is not a developer's mistake. It demotes
 * the kind's net-new findings to the existing `tooling_drift` status, which is
 * already in the default policy's `warn` list and absent from `block`. And it is
 * never silent — every renderer states the kind, which input moved, old -> new,
 * and the remedy. Same discipline as `GateFailure` (3.7.1): a fail-open gate
 * stays fail-open, it just always says WHY.
 */

import { createHash } from 'crypto';
import type { BaselineEntry } from './types';

/** Mirror of the registry's `IdentityKind`, declared here to avoid a cycle
 *  (`producers/index.ts` imports this module). */
type IdentityKind = BaselineEntry['kind'];

/**
 * What determines what a kind can SEE on this run.
 *
 * Two finding-sets are comparable iff their `RecallContext`s are equal.
 */
export interface RecallContext {
  /**
   * Bumped BY US when a dxkit change alters what this kind observes.
   *
   * Deliberate, like `CURRENT_IDENTITY_SCHEME` — deliberately NOT dxkit's
   * package version, because most releases do not change recall and
   * blanket-degrading every kind on every upgrade would train users to ignore
   * the signal. See `RECALL_EPOCHS` for the current values + why each is where
   * it is.
   */
  readonly epoch: number;
  /**
   * Environment-derived inputs, already resolved to comparable strings: tool
   * versions, plugin versions, ruleset ids, config-file content hashes, the
   * check command itself.
   *
   * Keys are free-form but MUST be stable across runs (never a timestamp, a
   * temp path, or anything that moves on its own) — an unstable input reads as
   * permanent drift and silently disables the kind's gate.
   */
  readonly inputs: Readonly<Record<string, string>>;
}

/** Per-kind recall, as recorded on a baseline and recomputed on each scan.
 *  Partial: a kind with no registered producer has no context. */
export type RecallMap = Readonly<Partial<Record<IdentityKind, RecallContext>>>;

/** Why a kind is not attributable this run. */
export type RecallDriftReason =
  /** The baseline predates recall attribution entirely (or predates this
   *  kind's producer), so dxkit genuinely does not know whether the two sides
   *  are comparable. Never assume they are — that is the proxy this module
   *  exists to kill. */
  | 'absent-from-baseline'
  /** dxkit itself changed what this kind observes (cause 6). */
  | 'epoch'
  /** The environment changed what this kind observes (cause 5). */
  | 'inputs';

/** One input that moved between the baseline and the current run. `before` /
 *  `after` are absent when the input appeared / disappeared. */
export interface RecallInputChange {
  readonly input: string;
  readonly before?: string;
  readonly after?: string;
}

/** A kind that cannot be attributed this run, and the evidence for why. */
export interface RecallDrift {
  readonly kind: IdentityKind;
  readonly reason: RecallDriftReason;
  /** Which inputs moved, old -> new. Empty for `absent-from-baseline` (there is
   *  nothing to compare) and for `epoch` (dxkit moved, not the environment). */
  readonly changed: ReadonlyArray<RecallInputChange>;
}

/**
 * Current recall epoch per kind. Bump a kind's epoch in the SAME change that
 * alters what it observes, and say why in the comment — the number is
 * meaningless without the reason.
 *
 * Epochs live here rather than inline in each producer so the full set is
 * readable at a glance and a bump is visible in review (mirror of
 * `CURRENT_IDENTITY_SCHEME`).
 */
export const RECALL_EPOCHS: Readonly<Record<IdentityKind, number>> = Object.freeze({
  // No recall change since attribution shipped.
  secret: 1,
  'secret-hmac': 1,
  code: 1,
  config: 1,
  'dep-vuln': 1,
  duplication: 1,
  'stale-file': 1,
  'large-file': 1,
  'test-gap': 1,
  'test-file-degradation': 1,
  'stale-allow': 1,
  hygiene: 1,
  'god-file': 1,
  'coverage-gap': 1,
  'flow-binding': 1,
  'model-schema-drift': 1,
  'code-reimplementation': 1,
  // 2 — the output-capture fix. Before it, a check's output was truncated to a
  // 4000-byte DISPLAY tail before being parsed, and a located-finding cap
  // (`MAX_LOCATED=500`) kept a content-dependent PREFIX. Both mean dxkit saw a
  // fragment and reported it as the whole. Fixing them strictly INCREASES what
  // this kind observes (a real repo went 45 -> 17,882 findings), so a baseline
  // captured under epoch 1 is not comparable to one captured under epoch 2 —
  // every newly-visible finding would otherwise read as the developer's fault.
  'custom-check': 2,
});

/**
 * Compare two recall maps and return every kind that is NOT attributable.
 *
 * `baseline` is `undefined` for a baseline written before recall attribution
 * existed; every kind the current run produces is then `absent-from-baseline`.
 * That is deliberately loud rather than convenient: the honest answer is "dxkit
 * does not know", and the remedy (one `baseline refresh`) is cheap.
 *
 * Pure. Order is stable (kinds sorted) so renderers and tests see a
 * deterministic list.
 */
export function diffRecall(
  baseline: RecallMap | undefined,
  current: RecallMap,
): ReadonlyArray<RecallDrift> {
  const out: RecallDrift[] = [];
  const kinds = [...new Set(Object.keys(current))].sort() as IdentityKind[];

  for (const kind of kinds) {
    const now = current[kind];
    if (!now) continue;
    const before = baseline?.[kind];

    if (!before) {
      out.push({ kind, reason: 'absent-from-baseline', changed: [] });
      continue;
    }
    if (before.epoch !== now.epoch) {
      out.push({ kind, reason: 'epoch', changed: [] });
      continue;
    }
    const changed = diffInputs(before.inputs, now.inputs);
    if (changed.length > 0) out.push({ kind, reason: 'inputs', changed });
  }
  return out;
}

/** Every input key whose value differs between two input sets, sorted. */
function diffInputs(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): RecallInputChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: RecallInputChange[] = [];
  for (const input of keys) {
    const b = before[input];
    const a = after[input];
    if (b === a) continue;
    out.push({
      input,
      ...(b !== undefined ? { before: b } : {}),
      ...(a !== undefined ? { after: a } : {}),
    });
  }
  return out;
}

/**
 * Flatten every kind's inputs into the single name -> value map the baseline
 * file records as `tools` and `show` renders.
 *
 * DISPLAY ONLY — a projection, never an attribution source. The per-kind
 * compare reads `RecallMap` directly (`diffRecall`); reintroducing a consumer
 * that attributes off this flattened view would recreate the lossy-projection
 * bug this module exists to kill (CLAUDE.md 2.30).
 *
 * Collision rule: two kinds declaring the same key with the SAME value share
 * one entry (the common case — `resolveToolVersion` is cached per tool, so
 * every kind that uses gitleaks reports the same version). Two kinds declaring
 * the same key with DIFFERENT values would make the union ill-defined, so BOTH
 * are namespaced as `${kind}:${key}` rather than letting one silently win.
 */
export function recallInputsUnion(map: RecallMap): Record<string, string> {
  // First pass: which keys are contested (same key, differing values)?
  const seen = new Map<string, Set<string>>();
  for (const ctx of Object.values(map)) {
    if (!ctx) continue;
    for (const [key, value] of Object.entries(ctx.inputs)) {
      const values = seen.get(key) ?? new Set<string>();
      values.add(value);
      seen.set(key, values);
    }
  }
  const contested = new Set([...seen].filter(([, v]) => v.size > 1).map(([k]) => k));

  const out: Record<string, string> = {};
  for (const kind of (Object.keys(map) as IdentityKind[]).sort()) {
    const ctx = map[kind];
    if (!ctx) continue;
    for (const [key, value] of Object.entries(ctx.inputs)) {
      out[contested.has(key) ? `${kind}:${key}` : key] = value;
    }
  }
  return out;
}

/**
 * Stable content hash of an input map, for callers that need one input string
 * to stand for a bundle (a config file's content, a plugin set). 16-char
 * SHA-1 — envelope metadata, never a finding identity (Rule 9).
 */
export function hashRecallInputs(inputs: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16); // fingerprint-helper-ok: recall-input hash, not finding identity
}

/** Human-readable one-liner for a drift, shared by every renderer so the three
 *  surfaces cannot describe the same drift differently (Rule 2). */
export function describeRecallDrift(drift: RecallDrift): string {
  switch (drift.reason) {
    case 'absent-from-baseline':
      return `${drift.kind}: the baseline predates recall attribution, so dxkit cannot tell whether these findings are comparable`;
    case 'epoch':
      return `${drift.kind}: dxkit changed what it observes for this kind since the baseline was captured`;
    case 'inputs': {
      const detail = drift.changed
        .map((c) => `${c.input} ${c.before ?? '(absent)'} -> ${c.after ?? '(absent)'}`)
        .join(', ');
      return `${drift.kind}: ${detail}`;
    }
  }
}

/** The remedy every drift shares. One string so the three renderers agree. */
export const RECALL_DRIFT_REMEDY =
  'run `vyuh-dxkit baseline create --force` to re-baseline; these findings warn instead of blocking until then';
