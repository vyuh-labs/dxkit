/**
 * The lapse projection — what a check run's ACTIVE allowlist suppressions will
 * do to this repo when their windows expire, computed in ONE place and carried
 * on the result so every renderer says the same thing.
 *
 * # Why this exists (the class it closes)
 *
 * Two individually-correct mechanisms compose into a cliff. An allowlist entry
 * deliberately holds its finding OUT of the baseline (`create.ts` excludes
 * actively-suppressed findings, so an accepted finding can never grandfather
 * itself in and defeat its own expiry), and the scheduled refresh is therefore
 * structurally forbidden from absorbing it. So on the day a deferral lapses,
 * every finding it was holding back returns AT ONCE — with no warning as the
 * date approached and no decision surface at the lapse. Observed on a real
 * repo: 21 findings deferred for six days, nothing remediated, and on expiry
 * day 9 high dependency advisories blocked every open PR.
 *
 * The computation was already there and simply never delivered. `auditAllowlist`
 * has computed `expired` + `soonToExpire` with `daysRemaining` since the
 * allowlist shipped — but its only consumers were `doctor` and
 * `allowlist audit`, two commands nobody runs on a normal day. The warning was
 * written, correct, and invisible. This module puts it where every author and
 * reviewer already looks: the guardrail check's own output.
 *
 * # What it adds over the audit buckets
 *
 * The audit answers "which entries expire soon" from the allowlist FILE alone —
 * which is all it can see, so it cannot say what the lapse will COST. The check
 * can: it holds each suppressed pair's classification and each gate finding's
 * verdict, so it knows which lapses will BLOCK and which will merely warn. That
 * is the consequence half of the concept, and it lives here.
 *
 * Read it as "if these lapsed today" — not a prophecy. The finding is
 * re-classified on the run after the lapse, against that day's policy, recall
 * state, and code. A finding that gets fixed in the meantime never returns at
 * all. The projection is exact about today's tier rules and honest that the
 * lapse date is the only thing it is predicting.
 *
 * # The contract
 *
 *   - The expiry horizon and the day arithmetic come from the ONE home,
 *     `src/allowlist/file.ts` (`SOON_TO_EXPIRE_DAYS` / `daysUntilDate`) — the
 *     same functions `auditAllowlist` uses, so `doctor`'s "next in Nd" label and
 *     the check's warning can never disagree about the same date. Pinned by
 *     `test/allowlist-expiry-parity.test.ts` (CLAUDE.md 2.30: two consumers
 *     holding different shapes of one concept get a parity test, not just an
 *     arch rule — the check side holds only the `expiresAt` STRING, a lossy
 *     projection of the entry).
 *   - EVERY suppression source is covered, not just the matcher pairs: the four
 *     additive gates (flow, schema-drift, seam-dup, paired-change) each carry
 *     their own `suppressed[]` with its own `expiresAt`, and a projection that
 *     read pairs alone would warn about a lapsing dep-vuln while staying silent
 *     about a lapsing flow breakage on the same day. One collector, five
 *     sources.
 *   - `GuardrailCheckResult.suppressionExpiry` is a REQUIRED field, so a new
 *     surface cannot render the check without it being computed.
 *   - It NEVER blocks and never changes a verdict. Expiry is already the forcing
 *     function; this is disclosure, on the `GateFailure` discipline — a
 *     fail-open surface stays fail-open, it just always says why.
 */

import { SOON_TO_EXPIRE_DAYS, daysUntilDate } from '../allowlist/file';

/** Which surface a lapsing suppression came from. */
export type LapseSource = 'finding' | 'flow' | 'schema-drift' | 'duplication' | 'paired-change';

/** What the lapse would do, under today's tier rules. `info` is
 *  disclosure-only — it neither blocks nor warns, so it never counts toward
 *  the projection's totals. */
export type LapseConsequence = 'block' | 'warn' | 'info';

/** One active suppression whose window closes inside the horizon. */
export interface LapsingSuppression {
  readonly source: LapseSource;
  /** The suppressed finding's fingerprint — the allowlist entry's key, so a
   *  reader can go straight to the entry that defers it. */
  readonly fingerprint: string;
  /** The allowlist category the deferral was filed under. */
  readonly category: string;
  /** ISO `YYYY-MM-DD`. */
  readonly expiresAt: string;
  /** Whole UTC days from today, via the one day-math home. Always >= 0: an
   *  already-expired entry does not suppress, so it cannot appear here. */
  readonly daysRemaining: number;
  readonly consequence: LapseConsequence;
  /** Compact locator for the renderers — built here so all three surfaces
   *  name the same finding the same way. */
  readonly subject: string;
}

/** The whole projection for one check run. */
export interface ExpiryProjection {
  /** The horizon this projection used, echoed so a renderer can state the
   *  window it is reporting over rather than assuming the default. */
  readonly horizonDays: number;
  /** Lapsing suppressions, soonest first, then blocks before warns (the most
   *  actionable line reads first). */
  readonly lapsing: ReadonlyArray<LapsingSuppression>;
  /** How many would block. The number that makes this worth reading. */
  readonly willBlock: number;
  /** How many would warn. */
  readonly willWarn: number;
  /** Days until the soonest lapse; absent when nothing lapses in the horizon. */
  readonly nextLapseDays?: number;
}

/** The minimal suppression shape every source shares — structural, so this
 *  module imports no gate (they are all reached from `check.ts`, which imports
 *  this). */
interface SourceSuppression {
  readonly fingerprint: string;
  readonly category: string;
  readonly expiresAt?: string;
}

/** The minimal pair shape the collector reads. Structural for the same reason
 *  `attribution-gap.ts` is: `check.ts` imports this module. */
interface LapseSourcePair {
  readonly kind: string;
  readonly classification: { readonly blocks: boolean; readonly warns: boolean };
  readonly file?: string;
  readonly line?: number;
  readonly suppressedByAllowlist?: SourceSuppression;
}

/** The gate slices the collector reads — each gate's suppressions plus enough
 *  of the underlying finding to name it and know its verdict. */
interface LapseSourceGates {
  readonly flowGate?: {
    readonly suppressed?: ReadonlyArray<
      SourceSuppression & {
        readonly finding: {
          readonly method: string;
          readonly path: string;
          readonly verdict: 'block' | 'warn';
        };
      }
    >;
  };
  readonly schemaDriftGate?: {
    readonly suppressed?: ReadonlyArray<
      SourceSuppression & {
        readonly finding: {
          readonly changeClass: string;
          readonly model: string;
          readonly field: string | null;
          readonly verdict: 'block' | 'warn' | 'info';
        };
      }
    >;
  };
  readonly dupGate?: {
    readonly suppressed?: ReadonlyArray<
      SourceSuppression & {
        readonly finding: {
          readonly anchors: readonly [{ readonly symbol: string }, { readonly symbol: string }];
        };
      }
    >;
  };
  readonly pairedGate?: {
    readonly suppressed?: ReadonlyArray<
      SourceSuppression & {
        readonly finding: { readonly check: string; readonly blocking: boolean };
      }
    >;
  };
}

export interface ExpiryProjectionInput extends LapseSourceGates {
  readonly pairs: ReadonlyArray<LapseSourcePair>;
  /** The check's clock — the SAME `now` the suppression decision used, so a
   *  run cannot treat an entry as active and then compute its lapse against a
   *  different day. */
  readonly now: Date;
  /** Override the horizon (guardrail tuning). Defaults to the shared
   *  `SOON_TO_EXPIRE_DAYS`. */
  readonly horizonDays?: number;
}

/**
 * Collect every active suppression lapsing inside the horizon, across all five
 * sources, with what the lapse would cost. Pure; ordering is stable (soonest
 * first, blocks before warns, then by subject).
 */
export function collectExpiryProjection(input: ExpiryProjectionInput): ExpiryProjection {
  const horizonDays = input.horizonDays ?? SOON_TO_EXPIRE_DAYS;
  const lapsing: LapsingSuppression[] = [];

  const consider = (
    source: LapseSource,
    s: SourceSuppression,
    consequence: LapseConsequence,
    subject: string,
  ): void => {
    // A non-expiring category (`false-positive`, `test-fixture`,
    // `mitigated-externally`) never lapses, so it is not a decision waiting to
    // happen — it stays out.
    if (!s.expiresAt) return;
    const daysRemaining = daysUntilDate(s.expiresAt, input.now);
    if (daysRemaining < 0 || daysRemaining > horizonDays) return;
    lapsing.push({
      source,
      fingerprint: s.fingerprint,
      category: s.category,
      expiresAt: s.expiresAt,
      daysRemaining,
      consequence,
      subject,
    });
  };

  for (const p of input.pairs) {
    const s = p.suppressedByAllowlist;
    if (!s) continue;
    // Suppression is only consulted for a pair that blocks or warns, so one of
    // the two holds. Read the classification rather than re-deriving the tier:
    // it already folded in the policy's block rules and the custom-check
    // `blocking: false` intent (CLAUDE.md 2.30 — no second tier table).
    const consequence: LapseConsequence = p.classification.blocks ? 'block' : 'warn';
    const where = p.file ? `${p.file}${p.line !== undefined ? `:${p.line}` : ''}` : undefined;
    consider('finding', s, consequence, where ? `${p.kind} ${where}` : p.kind);
  }

  for (const s of input.flowGate?.suppressed ?? []) {
    // The gate applies its posture (a `warn`-mode gate demotes every finding)
    // BEFORE partitioning off the suppressions, so the verdict carried here is
    // the effective one, not the pre-posture one.
    consider('flow', s, s.finding.verdict, `${s.finding.method} ${s.finding.path}`);
  }

  for (const s of input.schemaDriftGate?.suppressed ?? []) {
    const target = s.finding.field ? `${s.finding.model}.${s.finding.field}` : s.finding.model;
    consider('schema-drift', s, s.finding.verdict, `${s.finding.changeClass} ${target}`);
  }

  for (const s of input.dupGate?.suppressed ?? []) {
    // A lone duplicate never blocks — the seam gate is warn-tier by design.
    const [a, b] = s.finding.anchors;
    consider('duplication', s, 'warn', `${a.symbol} / ${b.symbol}`);
  }

  for (const s of input.pairedGate?.suppressed ?? []) {
    consider('paired-change', s, s.finding.blocking ? 'block' : 'warn', s.finding.check);
  }

  const rank: Record<LapseConsequence, number> = { block: 0, warn: 1, info: 2 };
  lapsing.sort(
    (x, y) =>
      x.daysRemaining - y.daysRemaining ||
      rank[x.consequence] - rank[y.consequence] ||
      x.subject.localeCompare(y.subject) ||
      x.fingerprint.localeCompare(y.fingerprint),
  );

  const willBlock = lapsing.filter((l) => l.consequence === 'block').length;
  const willWarn = lapsing.filter((l) => l.consequence === 'warn').length;
  return {
    horizonDays,
    lapsing,
    willBlock,
    willWarn,
    ...(lapsing.length > 0 ? { nextLapseDays: lapsing[0]!.daysRemaining } : {}),
  };
}

/** One line for a lapsing suppression, shared by every renderer (Rule 2). */
export function describeLapsingSuppression(l: LapsingSuppression): string {
  const when = l.daysRemaining === 0 ? 'today' : `in ${l.daysRemaining}d`;
  const effect =
    l.consequence === 'block'
      ? 'will BLOCK'
      : l.consequence === 'warn'
        ? 'will warn'
        : 'disclosure';
  return `${l.subject} — ${l.category} expires ${l.expiresAt} (${when}), ${effect}`;
}

/**
 * The headline for a projection, or `undefined` when nothing lapses in the
 * horizon (the renderers print nothing at all in that case — an empty section
 * is noise on the overwhelming majority of runs).
 */
export function describeExpiryProjection(p: ExpiryProjection): string | undefined {
  if (p.lapsing.length === 0) return undefined;
  const n = p.lapsing.length;
  const when = p.nextLapseDays === 0 ? 'today' : `in ${p.nextLapseDays}d`;
  const consequence =
    p.willBlock > 0
      ? `${p.willBlock} will BLOCK` + (p.willWarn > 0 ? `, ${p.willWarn} will warn` : '')
      : p.willWarn > 0
        ? `${p.willWarn} will warn`
        : 'none will block or warn';
  return (
    `${n} allowlist suppression${n === 1 ? '' : 's'} expire${n === 1 ? 's' : ''} within ` +
    `${p.horizonDays} days (next ${when}); when ${n === 1 ? 'it lapses' : 'they lapse'}, ` +
    consequence
  );
}

/** The remedy every projection shares — one string so the three renderers
 *  agree. Never a block, so it reads as a choice, not an ultimatum. */
export const EXPIRY_PROJECTION_REMEDY =
  'fix the underlying findings before the window closes, or run ' +
  '`vyuh-dxkit allowlist audit` to review and extend the ones still in plan';
