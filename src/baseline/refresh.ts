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
 *   2. Diff the fresh capture's dep-vulns against the PRIOR effective baseline
 *      (side-branch anchor first, tree copy second — the same precedence the
 *      guardrail check uses). A fresh dep-vuln absent from the prior baseline,
 *      on a tree whose diff since the prior anchor touched NO dependency
 *      manifest of any active pack, is a NEWLY PUBLISHED ADVISORY — the same
 *      ONE discriminator (`changedFilesTouchDependencyManifest`) the
 *      classifier and the ref-based skip trust (Rule 2.30).
 *   3. HOLD those out of the written baseline — never absorbed silently — and
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
 *      the findings one at a time.
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

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { changedFilesTouchDependencyManifest, detectActiveLanguages } from '../languages';
import { computeChangedFiles } from './changed-files';
import { createBaseline } from './create';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineEntry } from './types';
import type { BaselineFile } from './baseline-file';
import { isSanitized } from './sanitize';
import { loadAnchorFromBranch } from './anchor';
import { readFromAnchorRef } from './anchor-publish';
import { loadPolicyFromCwd, type BaselineSection } from './policy';
import { resolveBaselineMode } from './modes';
import { deferAdvisoryExpiryDate } from '../allowlist/categories';
import {
  ALLOWLIST_SCHEMA_VERSION,
  type AllowlistEntry,
  type AllowlistFile,
} from '../allowlist/file';
import { loadAllowlist } from '../allowlist/file';
import { makeExec, openOrUpdateStandingPr, type LandRefreshResult } from '../land-refresh';
import { internalGitPushArgs } from '../git-internal-push';
import { detectDefaultBranch } from '../ship-installers';

/** The standing decision branch. ONE branch, force-updated — never a pile. */
export const ADVISORY_DECISION_BRANCH = 'dxkit/advisory-decision';

/** One held-out newly published advisory, projected for the decision PR. */
export interface HeldOutAdvisory {
  readonly fingerprint: string;
  readonly package: string;
  readonly installedVersion?: string;
  readonly advisoryId: string;
}

export interface BaselineRefreshResult {
  /** The fresh capture's finding count (post hold-out). */
  readonly findings: number;
  /** Advisories held OUT of the refreshed baseline (empty on a quiet feed). */
  readonly heldOut: ReadonlyArray<HeldOutAdvisory>;
  /** The decision-PR landing outcome; absent when nothing was held out. */
  readonly decision?: LandRefreshResult;
  /** Why the advisory lane did / could not run — always populated so a refresh
   *  log never leaves the reader guessing (the GateFailure discipline). */
  readonly note: string;
}

export interface BaselineRefreshOptions {
  readonly cwd: string;
  readonly name?: string;
  readonly verbose?: boolean;
  /** Clock injection for deterministic tests. */
  readonly now?: Date;
  /** Exec injection for tests (PR mechanics). */
  readonly exec?: ReturnType<typeof makeExec>;
  /** TEST SEAM: replaces the `createBaseline` capture (the analyzers are not
   *  what refresh tests exercise — the decision lane is). Production omits. */
  readonly _capture?: (args: { cwd: string; name: string }) => Promise<void>;
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
 * `branch` and reachable, else the on-disk tree copy — the same precedence the
 * guardrail check applies, so the refresh diffs against what the gate was
 * actually using. MUST be read BEFORE the fresh capture overwrites the tree
 * copy. Null when neither exists (first capture).
 */
function loadPriorBaseline(
  cwd: string,
  treePath: string,
  section: BaselineSection | undefined,
): BaselineFile | null {
  try {
    const fromBranch = loadAnchorFromBranch(cwd, treePath, section);
    if (fromBranch) return readBaselineFile(fromBranch);
  } catch {
    /* fall through to the tree copy */
  }
  try {
    if (fs.existsSync(treePath)) return readBaselineFile(treePath);
  } catch {
    /* unreadable tree copy — treat as absent */
  }
  return null;
}

function depVulnIds(file: BaselineFile): Set<string> {
  const out = new Set<string>();
  for (const f of file.findings) if (f.kind === 'dep-vuln') out.add(f.id);
  return out;
}

function toHeldOut(entry: BaselineEntry): HeldOutAdvisory {
  if (entry.kind !== 'dep-vuln') throw new Error('held-out projection is dep-vuln-only');
  // A sanitized entry (committed-sanitized mode) strips package/advisory
  // metadata — the fingerprint is all the identity that remains.
  if (isSanitized(entry)) {
    return { fingerprint: entry.id, package: '(sanitized)', advisoryId: entry.id };
  }
  return {
    fingerprint: entry.id,
    package: entry.package,
    ...(entry.installedVersion !== undefined ? { installedVersion: entry.installedVersion } : {}),
    advisoryId: entry.advisoryId ?? entry.id,
  };
}

/**
 * Existing deferred entries on the standing decision branch, so a re-raise
 * (the branch is force-updated every refresh) preserves each advisory's
 * ORIGINAL expiry — re-dating on every refresh would quietly turn the 7-day
 * window into defer-forever, the exact failure the lane exists to prevent.
 */
function carryOverEntries(cwd: string): Map<string, AllowlistEntry> {
  const out = new Map<string, AllowlistEntry>();
  const raw = readFromAnchorRef(cwd, ADVISORY_DECISION_BRANCH, '.dxkit/allowlist.json');
  if (!raw) return out;
  try {
    const file = JSON.parse(raw) as AllowlistFile;
    for (const e of file.entries ?? []) {
      if (e.kind === 'dep-vuln' && e.category === 'deferred') out.set(e.fingerprint, e);
    }
  } catch {
    /* malformed standing content — regenerate from scratch */
  }
  return out;
}

/** Serialize an allowlist file exactly as `saveAllowlist` does (plain JSON,
 *  the `full`-mode format — the decision lane never writes sanitized mode). */
function serializeAllowlist(file: AllowlistFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/**
 * Commit ONE file onto the standing decision branch, parented on the current
 * HEAD (so the PR is mergeable into the default branch), using a temp index —
 * the working tree and HEAD never move. Force-pushes the standing branch
 * (latest-wins; it is machine-owned) through the one internal-push argv.
 */
function commitFileToDecisionBranch(
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): void {
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-decision-idx-')), 'idx');
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: 'dxkit-bot',
    GIT_AUTHOR_EMAIL: 'dxkit-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'dxkit-bot',
    GIT_COMMITTER_EMAIL: 'dxkit-bot@users.noreply.github.com',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    }).toString();

  git(['read-tree', 'HEAD']);
  const blob = git(['hash-object', '-w', '--stdin'], content).trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},${relPath}`]);
  const tree = git(['write-tree']).trim();
  const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', message]).trim();
  git(internalGitPushArgs(`${commit}:refs/heads/${ADVISORY_DECISION_BRANCH}`, { force: true }));
}

/** The decision PR's body: the advisory table + the two lanes, stated once. */
export function decisionPrBody(
  heldOut: ReadonlyArray<HeldOutAdvisory>,
  entries: ReadonlyArray<AllowlistEntry>,
): string {
  const expiryByFp = new Map(entries.map((e) => [e.fingerprint, e.expiresAt ?? '—']));
  const rows = heldOut
    .map(
      (a) =>
        `| ${a.package}${a.installedVersion ? `@${a.installedVersion}` : ''} | ${a.advisoryId} | ` +
        `\`${a.fingerprint}\` | ${expiryByFp.get(a.fingerprint) ?? '—'} |`,
    )
    .join('\n');
  return [
    `## ${heldOut.length} newly published advisor${heldOut.length === 1 ? 'y' : 'ies'} need a decision`,
    '',
    'The scheduled baseline refresh found dependency advisories published to the feed AFTER',
    'the previous capture, on a tree whose diff touched no dependency manifest — nobody in',
    'this repo introduced them. They were **held out of the refreshed baseline** (never',
    'silently grandfathered), so they gate every PR by the advisory tier until this repo',
    'decides:',
    '',
    '| Package | Advisory | Fingerprint | Defer expires |',
    '|---|---|---|---|',
    rows,
    '',
    '**Lane 1 — fix (preferred):** upgrade or patch the affected dependencies and merge that',
    'change; the next refresh absorbs the resolution and this PR becomes obsolete.',
    '',
    '**Lane 2 — defer, time-boxed:** MERGE THIS PR. It adds `category=deferred` allowlist',
    'entries that clear the gate now and EXPIRE on the dates above — the findings re-block',
    'when the window lapses, which is the forcing function back into the fix lane.',
    '',
    'Closing this PR without fixing re-raises it on the next scheduled refresh — a live',
    'advisory never goes silent.',
    '',
    '🤖 raised by `vyuh-dxkit baseline refresh` (the D4 advisory decision lane)',
  ].join('\n');
}

/**
 * The refresh orchestration. See the module docs for semantics; the return's
 * `note` always says what the advisory lane did (or why it could not run).
 */
export async function runBaselineRefresh(
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
      note:
        'ref-based baseline mode — no committed baseline to refresh, and newly published ' +
        'advisories cannot false-block there (the check gathers both sides against the same ' +
        'advisory feed). Nothing to do.',
    };
  }

  // The prior EFFECTIVE baseline — read before the capture overwrites the tree.
  const prior = loadPriorBaseline(cwd, treePath, section);

  if (opts._capture) {
    await opts._capture({ cwd, name });
  } else {
    await createBaseline({ cwd, name, force: true, verbose: opts.verbose });
  }
  const fresh = readBaselineFile(treePath);

  if (!prior) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      note: 'first capture — no prior baseline to detect newly published advisories against',
    };
  }

  // The ONE discriminator (Rule 2.30): the diff prior-anchor → working tree.
  // No evidence (unreachable anchor commit) or a manifest-touching diff ⇒
  // absorb normally, and say which.
  const changed = prior.repo.commitSha ? computeChangedFiles(cwd, prior.repo.commitSha) : null;
  if (changed === null) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      note:
        `changed files vs the prior anchor (${prior.repo.commitSha.slice(0, 12) || 'unknown'}) ` +
        'could not be computed — cannot attribute new dep-vulns to the feed, so nothing was ' +
        'held out (absorbed as ordinary pre-existing debt)',
    };
  }
  if (changedFilesTouchDependencyManifest(changed, detectActiveLanguages(cwd))) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      note:
        'a dependency manifest changed since the prior anchor — new dep-vulns may come from ' +
        'the dependency change itself, so the refresh absorbed them as ordinary pre-existing debt',
    };
  }

  const priorIds = depVulnIds(prior);
  const heldEntries = fresh.findings.filter((f) => f.kind === 'dep-vuln' && !priorIds.has(f.id));
  if (heldEntries.length === 0) {
    return {
      findings: fresh.findings.length,
      heldOut: [],
      note: 'no newly published advisories since the prior capture',
    };
  }

  // HOLD OUT: the refreshed baseline never grandfathers the new advisories.
  const heldIds = new Set(heldEntries.map((f) => f.id));
  const kept: BaselineFile = {
    ...fresh,
    findings: fresh.findings.filter((f) => !heldIds.has(f.id)),
  };
  writeBaselineFile(treePath, kept);
  const heldOut = heldEntries.map(toHeldOut);

  // The decision content: short-dated deferred entries, expiry preserved from
  // the standing branch for advisories already awaiting a decision.
  const carried = carryOverEntries(cwd);
  const today = now.toISOString().slice(0, 10);
  const decisionEntries: AllowlistEntry[] = heldOut.map((a) => {
    const prev = carried.get(a.fingerprint);
    if (prev) return prev;
    return {
      fingerprint: a.fingerprint,
      kind: 'dep-vuln',
      category: 'deferred',
      reason:
        `newly published advisory ${a.advisoryId} (${a.package}) detected by the scheduled ` +
        `refresh on ${today} — merged as a time-boxed deferral; fix before expiry`,
      addedBy: 'dxkit-refresh',
      addedAt: today,
      expiresAt: deferAdvisoryExpiryDate(now),
    };
  });

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

  let decision: LandRefreshResult;
  const prTitle = `dxkit: ${heldOut.length} newly published advisor${heldOut.length === 1 ? 'y' : 'ies'} need a decision`;
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
      prBody: decisionPrBody(heldOut, decisionEntries),
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

  return {
    findings: kept.findings.length,
    heldOut,
    decision,
    note:
      `${heldOut.length} newly published advisor${heldOut.length === 1 ? 'y' : 'ies'} held out ` +
      `of the refreshed baseline; decision raised on '${ADVISORY_DECISION_BRANCH}'`,
  };
}
