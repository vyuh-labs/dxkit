/**
 * `vyuh-dxkit baseline refresh` — the scheduled-refresh capture with the D4
 * advisory decision lane (4.1.4). Replaces the refresh workflows' bare
 * `baseline create --force`, which silently ABSORBED newly published
 * advisories into the fresh anchor: an advisory the feed disclosed after the
 * previous capture would grandfather with no decision and no expiry pressure —
 * defer-forever, the inverse failure of the false-block the classifier fixes.
 *
 * What it does instead:
 *
 *   1. Capture a fresh baseline (the existing `createBaseline` — one capture
 *      path, this module never re-implements it).
 *   2. REFUSE a degraded capture (4.4.8, #388; `refresh-degraded.ts`): a kind
 *      the prior recorded that the fresh capture did not observe, on a tree
 *      whose diff touched none of that kind's inputs, is never published. The
 *      prior anchor and the tree copy stay as they were and the run is red
 *      with the kind, the counts, what the provenance said and the remedy.
 *   3. Diff the fresh capture's dep-vulns against the PRIOR effective baseline
 *      (side-branch anchor first, tree copy second — the same precedence the
 *      guardrail check uses). A fresh dep-vuln known to NO "known before the
 *      prior capture" set (the prior anchor, the decision branch's carried
 *      hold-outs, an OSV publication date before the prior capture; #389,
 *      `refresh-holdout.ts`), on a tree whose diff since the prior anchor
 *      touched NO dependency manifest of any active pack, is a NEWLY PUBLISHED
 *      ADVISORY — the same ONE manifest discriminator
 *      (`changedFilesTouchDependencyManifest`) the classifier and the
 *      ref-based skip trust (Rule 2.30).
 *   4. HOLD those out of the written baseline — never absorbed silently — and
 *      raise the two-lane decision as a standing base-branch PR
 *      (`dxkit/advisory-decision`) whose content is short-dated `deferred`
 *      allowlist entries:
 *        - MERGE the PR  = defer, time-boxed (the expiry re-blocks — the
 *          forcing function back into the fix lane);
 *        - fix the dependencies instead and the next refresh absorbs the
 *          resolution; the PR is updated/obsoleted automatically.
 *      Until one of those happens the held-out advisories keep classifying as
 *      `newly_published_advisory` on every check, gated by the tier knob —
 *      dependency owners decide on the base branch before feature PRs fight
 *      the findings one at a time. An advisory already on the decision branch
 *      stays held out as STILL PENDING and is never announced as new again.
 *
 * Evidence honesty (Rule 19 applied to the refresh): a prior baseline that
 * cannot be loaded, or a changed-file set that cannot be computed, means the
 * discriminator has NO evidence — the refresh then absorbs nothing specially
 * and DISCLOSES why. A diff that DID touch a manifest absorbs normally (a
 * dependency change legitimately brings its advisories with it as pre-existing
 * debt — the standard refresh contract).
 *
 * Working-tree discipline: the decision branch is written with git PLUMBING
 * (temp index, commit parented on HEAD, forced push to the standing branch) —
 * the working tree and HEAD are never touched, so the workflow's later landing
 * steps (anchor publish / tree commit) see exactly the tree they expect.
 */

import * as fs from 'fs';
import * as path from 'path';
import { changedFilesTouchDependencyManifest, detectActiveLanguages } from '../languages';
import { readCommittedPrior, type CommittedPriorUnreadable } from '../gate/prior';
import { dxkitCli } from '../self-invocation';
import { computeChangedFiles } from './changed-files';
import { createBaseline } from './create';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineFile } from './baseline-file';
import { loadPolicyFromCwd, type BaselineSection } from './policy';
import { DEFAULT_ANCHOR_REF, resolveBaselineMode } from './modes';
import {
  ALLOWLIST_SCHEMA_VERSION,
  type AllowlistEntry,
  type AllowlistFile,
} from '../allowlist/file';
import { loadAllowlist } from '../allowlist/file';
import { makeExec, openOrUpdateStandingPr, type LandRefreshResult } from '../land-refresh';
import { detectDefaultBranch, expiryNoticeEnabled } from '../ship-installers';
import { syncExpiryNotice, type ExpiryNoticeResult } from './expiry-notice';
import type { OsvFetcher } from '../analyzers/tools/osv';
import {
  assessCaptureDegradation,
  degradedCaptureRefusal,
  describeClearedKind,
  NO_OBSERVATION_RECORD,
  observationFromScan,
  type CaptureObservation,
} from './refresh-degraded';
import {
  advisoryIdOf,
  classifyFreshAdvisories,
  decisionEntriesFor,
  depVulnIds,
  describeDisappeared,
  resolvePublishedDates,
  toHeldOut,
  type HeldOutAdvisory,
} from './refresh-holdout';
import {
  ADVISORY_DECISION_BRANCH,
  carryOverEntries,
  commitFileToDecisionBranch,
  serializeAllowlist,
} from './refresh-decision-branch';

// The decision PR body renderer, the hold-out projection and the standing
// branch name live in sibling modules (module-size splits); re-exported so
// consumers keep one import surface.
import { decisionPrBody } from './refresh-pr-body';
export { decisionPrBody, ADVISORY_DECISION_BRANCH };
export type { HeldOutAdvisory, CaptureObservation };

export interface BaselineRefreshResult {
  /** The fresh capture's finding count (post hold-out). */
  readonly findings: number;
  /** Advisories held OUT of the refreshed baseline (empty on a quiet feed):
   *  the ones new this refresh AND the ones still pending a decision
   *  (`pendingSince` set). */
  readonly heldOut: ReadonlyArray<HeldOutAdvisory>;
  /** The decision-PR landing outcome; absent when nothing was held out. */
  readonly decision?: LandRefreshResult;
  /** The expiry decision surface's outcome; absent when the knob is off (the
   *  default) — so a repo that never opted in cannot tell the difference. */
  readonly expiryNotice?: ExpiryNoticeResult;
  /** Why the advisory lane did / could not run — always populated so a refresh
   *  log never leaves the reader guessing (the GateFailure discipline). */
  readonly note: string;
  /** What this refresh published that a reader must know about: a kind that
   *  dropped to zero and was published as a full clear (with why that is
   *  honest), recorded debt that had disappeared from the prior anchor.
   *  Required so a renderer cannot forget them; empty on a plain refresh. */
  readonly disclosures: ReadonlyArray<string>;
}

export interface BaselineRefreshOptions {
  readonly cwd: string;
  readonly name?: string;
  readonly verbose?: boolean;
  /** Clock injection for deterministic tests. */
  readonly now?: Date;
  /** Exec injection for tests (PR mechanics). */
  readonly exec?: ReturnType<typeof makeExec>;
  /** OSV fetcher injection for tests (publication dates); production omits. */
  readonly osvFetcher?: OsvFetcher;
  /** TEST SEAM: replaces the `createBaseline` capture (the analyzers are not
   *  what refresh tests exercise — the decision lane is). Returns the capture's
   *  observation record; a seam that returns nothing recorded no evidence and
   *  reads as unobserved for every kind (#388). Production omits. */
  readonly _capture?: (args: { cwd: string; name: string }) => Promise<CaptureObservation | void>;
}

/** Best-effort policy baseline section (mirrors check.ts's safe read). */
function safeSection(cwd: string): BaselineSection | undefined {
  try {
    return loadPolicyFromCwd(cwd).baseline;
  } catch {
    return undefined;
  }
}

/**
 * The PRIOR effective baseline: the side-branch anchor when the transport is
 * `branch` and reachable, else the on-disk tree copy: the ONE committed
 * read the guardrail check and the remediation planner also use
 * (`readCommittedPrior`, #387), so the refresh diffs against what the gate
 * was actually using. MUST be read BEFORE the fresh capture overwrites the
 * tree copy. `baseline` is null when no prior exists (first capture);
 * `unreadable` is set when a prior EXISTS but could not be parsed, which the
 * lane must refuse on (#388): absorbing it as "first capture" would publish
 * a fresh baseline with every advisory pending a decision grandfathered.
 */
function loadPriorBaseline(
  cwd: string,
  treePath: string,
  section: BaselineSection | undefined,
): { baseline: BaselineFile | null; unreadable: CommittedPriorUnreadable | null } {
  const read = readCommittedPrior(cwd, {
    baselinePath: treePath,
    ...(section ? { section } : {}),
  });
  return { baseline: read.prior?.baseline ?? null, unreadable: read.unreadable };
}

/** The refusal a refresh raises over an unreadable prior: what failed, where,
 *  why, and the remedy. Thrown BEFORE the capture, so nothing is published. */
export function unreadablePriorRefusal(u: CommittedPriorUnreadable, anchorRef: string): string {
  const where =
    u.source === 'anchor'
      ? `the '${anchorRef}' anchor branch copy (materialized at ${u.path})`
      : `the committed tree copy at ${u.path}`;
  return (
    `refusing to refresh: a prior baseline exists but could not be read, so newly published ` +
    `advisories cannot be told apart from pre-existing debt (${where}: ${u.error.message}). ` +
    `Publishing a fresh capture over it would absorb every advisory pending a decision as ` +
    `ordinary debt. Inspect that copy, or re-capture deliberately with ` +
    `\`${dxkitCli('baseline create --force')}\` and \`${dxkitCli('baseline publish')}\`.`
  );
}

/** The committed tree copy's bytes before the capture overwrites it (null when
 *  absent), so a refused capture can put back exactly what was there. */
function snapshotTreeCopy(treePath: string): string | null {
  return fs.existsSync(treePath) ? fs.readFileSync(treePath, 'utf8') : null;
}

function restoreTreeCopy(treePath: string, snapshot: string | null): void {
  if (snapshot === null) fs.rmSync(treePath, { force: true });
  else fs.writeFileSync(treePath, snapshot);
}

/**
 * The refresh orchestration: the advisory decision lane, then the expiry
 * decision surface.
 *
 * The two are INDEPENDENT and both ride this one scheduled run. A suppression
 * can be about to lapse whether or not this refresh held any advisory out, so
 * the notice is synced on every path the advisory lane can take — including its
 * early returns (ref-based mode, first capture, no prior baseline). Wiring it
 * inside the lane would have made the notice a silent function of whether an
 * unrelated feed happened to move that week.
 */
export async function runBaselineRefresh(
  opts: BaselineRefreshOptions,
): Promise<BaselineRefreshResult> {
  const result = await runAdvisoryDecisionLane(opts);
  const cwd = path.resolve(opts.cwd);
  // Opt-in, default off: it is the only dxkit lane that opens an issue on its
  // own initiative, and it needs a permission the workflow only holds when the
  // repo asked for it (`refreshPermissionsBlock`).
  if (!expiryNoticeEnabled(cwd)) return result;
  const expiryNotice = syncExpiryNotice({
    cwd,
    exec: opts.exec ?? makeExec(cwd),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    // The finding-id set from the baseline this refresh just captured, so a
    // lapsing entry whose finding was FIXED reads as prunable bookkeeping,
    // never as a returning finding (the false-alarm class: a "lapses in 2
    // days" issue about an advisory the repo had already closed). Unreadable
    // baseline → null → every entry treated live (fail-open).
    currentFindingIds: freshFindingIds(cwd, opts.name ?? DEFAULT_BASELINE_NAME),
  });
  return { ...result, expiryNotice };
}

/** Finding ids from the freshest local baseline capture, or null when none
 *  is readable (anchor-only repos without a tree file, first runs). */
function freshFindingIds(cwd: string, name: string): ReadonlySet<string> | null {
  try {
    const file = readBaselineFile(pathForBaseline(cwd, name));
    if (!file) return null;
    return new Set(file.findings.map((f) => f.id));
  } catch {
    return null;
  }
}

/**
 * The advisory decision lane. See the module docs for semantics; the return's
 * `note` always says what it did (or why it could not run).
 */
async function runAdvisoryDecisionLane(
  opts: BaselineRefreshOptions,
): Promise<BaselineRefreshResult> {
  const cwd = path.resolve(opts.cwd);
  const name = opts.name ?? DEFAULT_BASELINE_NAME;
  const treePath = pathForBaseline(cwd, name);
  const section = safeSection(cwd);
  const now = opts.now ?? new Date();

  // Ref-based repos keep no committed baseline, so there is nothing to
  // refresh — and the advisory class cannot arise there: the check re-gathers
  // BOTH sides at the same moment, so a newly published advisory appears on
  // each and matches as pre-existing, never as net-new. Graceful no-op with
  // the explanation, not a "file not found" throw.
  const mode = resolveBaselineMode({
    cwd,
    policyMode: section?.mode,
    policyRef: section?.ref,
  });
  if (mode.mode === 'ref-based') {
    return {
      findings: 0,
      heldOut: [],
      disclosures: [],
      note:
        'ref-based baseline mode — no committed baseline to refresh, and newly published ' +
        'advisories cannot false-block there (the check gathers both sides against the same ' +
        'advisory feed). Nothing to do.',
    };
  }

  // The prior EFFECTIVE baseline — read before the capture overwrites the tree.
  const { baseline: prior, unreadable } = loadPriorBaseline(cwd, treePath, section);
  // Fail CLOSED on an unreadable prior (#388): nothing is captured or
  // published; the caller exits non-zero with the remedy named.
  if (unreadable) {
    throw new Error(unreadablePriorRefusal(unreadable, section?.anchorRef ?? DEFAULT_ANCHOR_REF));
  }

  // The tree copy as it was, so a refused capture (below) can restore it: the
  // capture writes the tree path before the lane can judge it.
  const treeBefore = snapshotTreeCopy(treePath);
  let observation: CaptureObservation;
  if (opts._capture) {
    observation = (await opts._capture({ cwd, name })) ?? NO_OBSERVATION_RECORD;
  } else {
    const created = await createBaseline({ cwd, name, force: true, verbose: opts.verbose });
    observation = created.scan
      ? observationFromScan(created.scan, created.mode.mode)
      : NO_OBSERVATION_RECORD;
  }
  const fresh = readBaselineFile(treePath);

  if (!prior) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      disclosures: [],
      note: 'first capture — no prior baseline to detect newly published advisories against',
    };
  }

  // The ONE discriminator (Rule 2.30): the diff prior-anchor → working tree.
  // No evidence (unreachable anchor commit) or a manifest-touching diff ⇒
  // absorb normally, and say which.
  const changed = prior.repo.commitSha ? computeChangedFiles(cwd, prior.repo.commitSha) : null;
  const manifestTouched =
    changed !== null && changedFilesTouchDependencyManifest(changed, detectActiveLanguages(cwd));

  // The degraded-capture refusal (#388) comes BEFORE any publish decision: a
  // kind the prior recorded that this capture did not observe, with no diff
  // explaining the drop, must not reach the anchor. The tree copy goes back
  // to what it was and the run is red with the evidence named.
  const degradation = assessCaptureDegradation({
    prior,
    fresh,
    changed,
    manifestTouched,
    observation,
  });
  if (degradation.refused.length > 0) {
    restoreTreeCopy(treePath, treeBefore);
    throw new Error(degradedCaptureRefusal(degradation.refused));
  }
  const disclosures: string[] = degradation.cleared.map(describeClearedKind);

  if (changed === null) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      disclosures,
      note:
        `changed files vs the prior anchor (${prior.repo.commitSha.slice(0, 12) || 'unknown'}) ` +
        'could not be computed — cannot attribute new dep-vulns to the feed, so nothing was ' +
        'held out (absorbed as ordinary pre-existing debt)',
    };
  }
  if (manifestTouched) {
    // Known hole (#389 follow-up, out of scope): this absorbs advisories still
    // pending a decision too, so a dependency change that merges before the
    // decision PR grandfathers them. The standard refresh contract stands.
    return {
      findings: fresh.findings.length,
      heldOut: [],
      disclosures,
      note:
        'a dependency manifest changed since the prior anchor — new dep-vulns may come from ' +
        'the dependency change itself, so the refresh absorbed them as ordinary pre-existing debt',
    };
  }

  // "Known before the prior capture" (#389): the prior anchor ∪ the decision
  // branch's carried hold-outs ∪ an OSV publication date before the prior
  // capture. Dates are resolved for the candidate set only.
  const carried = carryOverEntries(cwd);
  const priorIds = depVulnIds(prior);
  const candidateIds = fresh.findings
    .filter((f) => f.kind === 'dep-vuln' && !priorIds.has(f.id) && !carried.has(f.id))
    .flatMap((f) => {
      const id = advisoryIdOf(f);
      return id !== undefined ? [id] : [];
    });
  const published = await resolvePublishedDates(candidateIds, opts.osvFetcher);
  const cls = classifyFreshAdvisories({ fresh, prior, carried, published });
  if (cls.disappeared.length > 0) disclosures.push(describeDisappeared(cls.disappeared));

  const held = [
    ...cls.newlyPublished.map((entry) => toHeldOut(entry)),
    ...cls.pending.map(({ entry, since }) => toHeldOut(entry, since)),
  ];
  if (held.length === 0) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      disclosures,
      note: 'no newly published advisories since the prior capture',
    };
  }

  // HOLD OUT: the refreshed baseline never grandfathers the new advisories,
  // nor the ones still pending a decision.
  const heldIds = new Set(held.map((a) => a.fingerprint));
  const kept: BaselineFile = {
    ...fresh,
    findings: fresh.findings.filter((f) => !heldIds.has(f.id)),
  };
  writeBaselineFile(treePath, kept);
  const decisionEntries: AllowlistEntry[] = decisionEntriesFor(held, carried, now);

  // Merge onto the DEFAULT BRANCH's current allowlist (the tree's), so the
  // decision PR carries only the additive delta.
  const existing = loadAllowlist(cwd);
  const base: AllowlistFile = existing ?? {
    schemaVersion: ALLOWLIST_SCHEMA_VERSION,
    mode: 'full',
    entries: [],
  };
  const present = new Set(base.entries.map((e) => e.fingerprint));
  const merged: AllowlistFile = {
    ...base,
    entries: [...base.entries, ...decisionEntries.filter((e) => !present.has(e.fingerprint))],
  };

  const newCount = cls.newlyPublished.length;
  const pendingCount = cls.pending.length;
  const plural = (n: number): string => `advisor${n === 1 ? 'y' : 'ies'}`;
  const firstRaised = cls.pending.map((p) => p.since).sort()[0];
  const pendingClause =
    pendingCount > 0
      ? `${pendingCount} still pending a decision (first raised ${firstRaised})`
      : '';
  const prTitle =
    newCount > 0
      ? `dxkit: ${newCount} newly published ${plural(newCount)} need${newCount === 1 ? 's' : ''} a decision` +
        (pendingCount > 0 ? ` (${pendingCount} still pending)` : '')
      : `dxkit: ${pendingCount} ${plural(pendingCount)} still pending a decision`;
  let decision: LandRefreshResult;
  try {
    commitFileToDecisionBranch(
      cwd,
      '.dxkit/allowlist.json',
      serializeAllowlist(merged),
      `${prTitle}\n\n[skip ci]`,
    );
    decision = openOrUpdateStandingPr(opts.exec ?? makeExec(cwd), {
      branchName: ADVISORY_DECISION_BRANCH,
      defaultBranch: detectDefaultBranch(cwd),
      prTitle,
      prBody: decisionPrBody(held, decisionEntries),
    });
  } catch (err) {
    // Fail-open, never silent: the hold-out already protected the baseline;
    // an unreachable remote only delays the decision surface.
    decision = {
      outcome: 'branch-pushed-no-pr',
      mode: 'pr',
      note: `could not land the decision branch: ${(err as Error).message}`,
    };
  }

  const note =
    newCount > 0
      ? `${newCount} newly published ${plural(newCount)} held out of the refreshed baseline` +
        (pendingClause ? `, plus ${pendingClause}` : '') +
        `; decision raised on '${ADVISORY_DECISION_BRANCH}'`
      : `no newly published advisories since the prior capture; ${pendingClause}, held out ` +
        `of the refreshed baseline; decision re-raised on '${ADVISORY_DECISION_BRANCH}'`;
  return { findings: kept.findings.length, heldOut: held, decision, disclosures, note };
}
