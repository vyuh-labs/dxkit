/**
 * The advisory hold-out discriminator (4.4.8, #389): which fresh dep-vulns
 * are NEWLY PUBLISHED, which are STILL PENDING a decision, and which are
 * recorded debt that DISAPPEARED from the prior anchor.
 *
 * The old predicate was `fresh id not in the prior anchor`. The prior anchor is
 * the previous refresh's OUTPUT, which by construction excludes everything held
 * out before, so held-out => absent => held-out again: an advisory held out on
 * day N was announced as newly published on day N+1, and after one degraded
 * capture (#388) the repo's whole dependency debt left the anchor for good and
 * read as "newly published" every day after.
 *
 * "Known before the prior capture" is now ONE union (Rule 2.30), consulted in
 * this order:
 *   1. the prior anchor's dep-vuln ids (the old predicate);
 *   2. the carried-over held-out set on the decision branch (`carryOverEntries`,
 *      the same read that preserves expiries): still pending, never new;
 *   3. any fresh advisory whose OSV `published` date precedes the prior
 *      anchor's `createdAt`: recorded debt that disappeared from the anchor, a
 *      DISCLOSED anomaly absorbed as pre-existing debt, never held out.
 * Only an advisory in NONE of those is newly published.
 *
 * Known hole, out of scope here: a manifest-touching diff still absorbs every
 * fresh dep-vuln as ordinary debt (the lane's standard contract), which
 * grandfathers advisories pending a decision when a dependency change merges
 * before the decision PR does.
 */

import type { AllowlistEntry } from '../allowlist/file';
import { deferAdvisoryExpiryDate } from '../allowlist/categories';
import { enrichOsv, type OsvFetcher } from '../analyzers/tools/osv';
import type { BaselineFile } from './baseline-file';
import { isSanitized } from './sanitize';
import type { BaselineEntry } from './types';

/** One held-out newly published (or still pending) advisory, projected for
 *  the decision PR. */
export interface HeldOutAdvisory {
  readonly fingerprint: string;
  readonly package: string;
  readonly installedVersion?: string;
  readonly advisoryId: string;
  /** Set when the advisory was ALREADY held out by a previous refresh (the
   *  decision branch carries it): the date it was first raised. Absent on an
   *  advisory new this refresh. */
  readonly pendingSince?: string;
}

/** A fresh dep-vuln absent from the prior anchor that is OLDER than the prior
 *  capture by publication date: recorded debt that disappeared. */
export interface DisappearedAdvisory {
  readonly entry: BaselineEntry;
  readonly published: string;
}

export interface HoldOutClassification {
  /** Absent from every "known before" set: held out, announced as new. */
  readonly newlyPublished: ReadonlyArray<BaselineEntry>;
  /** Carried over from the decision branch: held out, NOT announced as new. */
  readonly pending: ReadonlyArray<{ readonly entry: BaselineEntry; readonly since: string }>;
  /** Absorbed as pre-existing debt with the anomaly disclosed. */
  readonly disappeared: ReadonlyArray<DisappearedAdvisory>;
}

export function depVulnIds(file: BaselineFile): Set<string> {
  const out = new Set<string>();
  for (const f of file.findings) if (f.kind === 'dep-vuln') out.add(f.id);
  return out;
}

/** The advisory id an entry carries, or undefined for a sanitized entry (the
 *  fingerprint is all the identity that remains, and OSV cannot resolve it). */
export function advisoryIdOf(entry: BaselineEntry): string | undefined {
  if (entry.kind !== 'dep-vuln' || isSanitized(entry)) return undefined;
  return entry.advisoryId;
}

/**
 * Publication dates for a set of advisory ids, from the same session-cached
 * OSV enrichment the security aggregate uses (one fetch serves severity, fix
 * resolution and this). Best effort: an id OSV does not know, or an offline
 * run, simply has no date and the discriminator treats it as new (the
 * pre-#389 behavior for that one advisory, never a false "old"). The lane
 * resolves only its CANDIDATE set (fresh ids absent from the prior), so the
 * per-PR gate pays nothing for this.
 */
export async function resolvePublishedDates(
  advisoryIds: ReadonlyArray<string>,
  fetcher?: OsvFetcher,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(advisoryIds)];
  if (ids.length === 0) return out;
  try {
    const details = await enrichOsv(ids, fetcher);
    for (const [id, detail] of details) {
      if (detail.published !== undefined) out.set(id, detail.published);
    }
  } catch {
    /* offline or a fetcher failure: no dates, every candidate reads as new */
  }
  return out;
}

/** True when `published` is a parseable date strictly before `priorCreatedAt`. */
function publishedBefore(published: string | undefined, priorCreatedAt: string): boolean {
  if (published === undefined) return false;
  const p = Date.parse(published);
  const c = Date.parse(priorCreatedAt);
  if (Number.isNaN(p) || Number.isNaN(c)) return false;
  return p < c;
}

/**
 * Classify the fresh dep-vulns against the "known before the prior capture"
 * union. Pure; the OSV dates are resolved beforehand (`resolvePublishedDates`)
 * so the decision is testable without a network.
 */
export function classifyFreshAdvisories(args: {
  readonly fresh: BaselineFile;
  readonly prior: BaselineFile;
  readonly carried: ReadonlyMap<string, AllowlistEntry>;
  /** advisory id -> OSV `published` (RFC 3339). */
  readonly published: ReadonlyMap<string, string>;
}): HoldOutClassification {
  const priorIds = depVulnIds(args.prior);
  const newlyPublished: BaselineEntry[] = [];
  const pending: { entry: BaselineEntry; since: string }[] = [];
  const disappeared: DisappearedAdvisory[] = [];
  for (const entry of args.fresh.findings) {
    if (entry.kind !== 'dep-vuln' || priorIds.has(entry.id)) continue;
    const carried = args.carried.get(entry.id);
    if (carried) {
      pending.push({ entry, since: carried.addedAt });
      continue;
    }
    const advisoryId = advisoryIdOf(entry);
    const published = advisoryId !== undefined ? args.published.get(advisoryId) : undefined;
    if (publishedBefore(published, args.prior.createdAt)) {
      disappeared.push({ entry, published: published! });
      continue;
    }
    newlyPublished.push(entry);
  }
  return { newlyPublished, pending, disappeared };
}

export function toHeldOut(entry: BaselineEntry, pendingSince?: string): HeldOutAdvisory {
  if (entry.kind !== 'dep-vuln') throw new Error('held-out projection is dep-vuln-only');
  const since = pendingSince !== undefined ? { pendingSince } : {};
  // A sanitized entry (committed-sanitized mode) strips package/advisory
  // metadata: the fingerprint is all the identity that remains.
  if (isSanitized(entry)) {
    return { fingerprint: entry.id, package: '(sanitized)', advisoryId: entry.id, ...since };
  }
  return {
    fingerprint: entry.id,
    package: entry.package,
    ...(entry.installedVersion !== undefined ? { installedVersion: entry.installedVersion } : {}),
    advisoryId: entry.advisoryId ?? entry.id,
    ...since,
  };
}

/**
 * The decision content: short-dated deferred entries, expiry preserved from
 * the standing branch for advisories already awaiting a decision (re-dating on
 * every refresh would quietly turn the window into defer-forever).
 */
export function decisionEntriesFor(
  heldOut: ReadonlyArray<HeldOutAdvisory>,
  carried: ReadonlyMap<string, AllowlistEntry>,
  now: Date,
): AllowlistEntry[] {
  const today = now.toISOString().slice(0, 10);
  return heldOut.map((a) => {
    const prev = carried.get(a.fingerprint);
    if (prev) return prev;
    return {
      fingerprint: a.fingerprint,
      kind: 'dep-vuln',
      category: 'deferred',
      reason:
        `newly published advisory ${a.advisoryId} (${a.package}) detected by the scheduled ` +
        `refresh on ${today}: merged as a time-boxed deferral; fix before expiry`,
      addedBy: 'dxkit-refresh',
      addedAt: today,
      expiresAt: deferAdvisoryExpiryDate(now),
    };
  });
}

/** The anomaly disclosure for recorded debt that disappeared from the prior
 *  anchor, pointing at the likely cause (a degraded capture, #388). */
export function describeDisappeared(list: ReadonlyArray<DisappearedAdvisory>): string {
  const ids = list.map((d) => advisoryIdOf(d.entry) ?? d.entry.id).join(', ');
  const n = list.length;
  return (
    `recorded debt disappeared from the prior anchor: ${n} advisor${n === 1 ? 'y' : 'ies'} ` +
    `published before the prior capture ${n === 1 ? 'was' : 'were'} absent from it (${ids}); ` +
    `absorbed as pre-existing debt, not held out. The likely cause is a degraded capture ` +
    `that published before the refresh refused one (the #388 class); the anchor is whole ` +
    `again after this refresh.`
  );
}
