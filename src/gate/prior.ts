/**
 * Prior acquisition — the ONE seam that turns a resolved mode into the
 * prior side of a gate diff (4.4.0 WP1, Rule 11 applied to the engine).
 *
 * Dispatches on `mode.mode`:
 *
 *   - `committed-full` / `committed-sanitized` → read the on-disk
 *     baseline file (anchor transport aware). The path is
 *     `options.baselinePath` when supplied, otherwise the conventional
 *     `.dxkit/baselines/<name>.json`.
 *   - `ref-based` → run the full gather pipeline against a git
 *     worktree of `mode.ref` (via `gatherFromRef`, whose worktree
 *     mechanics stay in `src/baseline/ref-baseline.ts`), then project
 *     the resulting `CurrentScan` into a synthetic `BaselineFile`. The
 *     matcher downstream doesn't care which path produced the value.
 *
 * WP2 extends the same dispatch with `fresh` (empty prior — everything
 * net-new by construction) and `tree-baseline` (gather of a supplied
 * directory); both dir-shaped arms share the ref arm's
 * `CurrentScan → BaselineFile` projection through the ONE converter
 * `scanToBaselineFile` — never a hand-built literal (the drift that
 * dropped `recall` from ref-based mode once already).
 *
 * The synthetic `BaselineFile` for ref-based mode carries the ref-
 * scan's envelope unchanged — including its `repo.commitSha`,
 * `tools`, `analysis` hashes, and `saltMode`. That's exactly what
 * the matcher needs to compute git-aware diffs + envelope drift
 * against the current scan.
 */

import * as fs from 'fs';
import { dxkitCli } from '../self-invocation';
import { gatherCurrentScan, scanToBaselineFile } from '../baseline/create';
import type { CurrentScan } from '../baseline/create';
import {
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  readBaselineFile,
} from '../baseline/baseline-file';
import type { BaselineFile } from '../baseline/baseline-file';
import { DEFAULT_ANCHOR_REF, priorClassOf } from '../baseline/modes';
import type { ResolvedMode } from '../baseline/modes';
import { loadPolicyFromCwd } from '../baseline/policy';
import type { BaselineSection } from '../baseline/policy';
import { hydrateAnchorFromBranch, loadAnchorFromBranch } from '../baseline/anchor';
import { gatherFromRef } from '../baseline/ref-baseline';
import { FULL_SCOPE } from '../baseline/gather-scope';
import type { GatherScope } from '../baseline/gather-scope';
import { CURRENT_IDENTITY_SCHEME } from '../baseline/types';
import type { AnchorSourceDisclosure } from './result';
import type { GateEngineOptions } from './types';

/** What prior acquisition hands the engine. */
export interface AcquiredPrior {
  baseline: BaselineFile;
  baselinePath?: string;
  anchorSource?: AnchorSourceDisclosure;
}

/** The side-branch anchor reader (`loadAnchorFromBranch`'s shape), injectable
 *  so a test can stand in an anchor without a remote. */
export type AnchorReader = typeof loadAnchorFromBranch;

export interface CommittedPriorReadOptions {
  /** Baseline name under `.dxkit/baselines/<name>.json` (default `main`). */
  readonly name?: string;
  /** Explicit baseline file path; overrides `name`. */
  readonly baselinePath?: string;
  /** The policy's `baseline` section; read from the repo when omitted. */
  readonly section?: BaselineSection;
  /** Test seam: the anchor reader (default `loadAnchorFromBranch`). */
  readonly anchorReader?: AnchorReader;
}

/** A prior that EXISTS but could not be parsed: not the same thing as no
 *  prior at all (#388). A refresh over it would grandfather every advisory
 *  pending a decision as ordinary debt, so callers must tell the two apart. */
export interface CommittedPriorUnreadable {
  /** Which copy was chosen and failed to parse. */
  readonly source: 'anchor' | 'tree';
  /** The file that failed to parse (a temp materialization for `anchor`). */
  readonly path: string;
  /** The parse error, as `readBaselineFile` raised it. */
  readonly error: Error;
}

/** What `readCommittedPrior` answers. Exactly one of three states:
 *  `prior` set (read), both null (no prior exists), or `unreadable` set
 *  (a prior exists but could not be parsed). */
export interface CommittedPriorRead {
  /** The logical tree path (display + the missing-file remedy). */
  readonly baselinePath: string;
  /** The prior, or null when none was read. */
  readonly prior: AcquiredPrior | null;
  /** Set when the chosen copy exists but could not be parsed. */
  readonly unreadable: CommittedPriorUnreadable | null;
}

/**
 * The ONE read of "the effective committed prior for this repo" (#387; Rule
 * 2.30). Under the `branch` anchor transport the side branch is the source
 * of truth and the committed tree copy is whatever the last LOCAL capture
 * wrote, so every reader of the committed baseline resolves it here:
 * the anchor first, the tree copy second, the fallback DISCLOSED. The
 * guardrail's `acquirePrior`, the refresh lane's prior read and the
 * remediation planner all consume this; a second reader that opens the tree
 * path directly is the bug that had the planner minting orders for debt the
 * default branch had already paid.
 *
 * Returns `prior: null, unreadable: null` when neither exists (after a
 * hydrate attempt) and `unreadable` when the copy it chose exists but cannot
 * be parsed; never throws for either, so a caller cannot confuse "no prior"
 * with "a prior I could not read". Never runs a scan.
 */
export function readCommittedPrior(
  cwd: string,
  opts: CommittedPriorReadOptions = {},
): CommittedPriorRead {
  const baselinePath =
    opts.baselinePath ?? pathForBaseline(cwd, opts.name ?? DEFAULT_BASELINE_NAME);
  const section = opts.section ?? safeBaselineSection(cwd);
  const anchorRef = section?.anchorRef ?? DEFAULT_ANCHOR_REF;
  const readAnchor = opts.anchorReader ?? loadAnchorFromBranch;
  // Scoped to the `branch` anchor transport: the source-of-truth anchor lives
  // on the side branch (the refresh only updates that, so a committed tree copy
  // goes stale). Read it from there, read-only and into a temp file, so a LOCAL
  // read matches CI instead of a stale tree copy. Returns null for `tree` (the
  // tree copy IS the source of truth) and `cache` (CI-only, no local side
  // branch), and when the side branch is not created yet / we are offline; all
  // of which fall through to the on-disk copy below.
  const fromBranch = readAnchor(cwd, baselinePath, section);
  if (fromBranch) {
    // Keep `baselinePath` as the logical tree path for display; read the fresh
    // side-branch anchor from the temp file.
    const anchor = parseBaseline(fromBranch, 'anchor');
    if ('unreadable' in anchor) return { baselinePath, prior: null, unreadable: anchor.unreadable };
    return {
      baselinePath,
      prior: {
        baseline: anchor.baseline,
        baselinePath,
        anchorSource: {
          used: 'anchor',
          anchorRef,
          note: `baseline read from the '${anchorRef}' side branch (anchor transport)`,
        },
      },
      unreadable: null,
    };
  }
  if (!fs.existsSync(baselinePath)) {
    // No on-disk copy: materialize a `branch` anchor at the tree path if we can
    // (a bootstrap where the side branch became reachable between the two
    // calls, or a non-'branch' transport with a genuinely missing file).
    const hydrated = hydrateAnchorFromBranch(cwd, baselinePath, section);
    if (!hydrated) return { baselinePath, prior: null, unreadable: null };
  }
  // D4d disclosure: with the `branch` transport, reaching this line means the
  // side branch could NOT be read and the caller proceeds on the tree copy,
  // possibly stale (the refresh only updates the side branch). Fail-open, but
  // never silent: the incident's footer cited the stale tree SHA with nothing
  // saying the anchor read failed.
  const anchorSource: AnchorSourceDisclosure | undefined =
    section?.anchor === 'branch'
      ? {
          used: 'tree-fallback',
          anchorRef,
          note:
            `anchor transport 'branch': the '${anchorRef}' side branch could not be read ` +
            `(not created yet, offline, or unfetchable) — gating against the committed tree ` +
            `copy, which may be STALE. If this repo's refresh publishes the anchor, ` +
            `investigate with \`${dxkitCli('doctor')}\`.`,
        }
      : undefined;
  const tree = parseBaseline(baselinePath, 'tree');
  if ('unreadable' in tree) return { baselinePath, prior: null, unreadable: tree.unreadable };
  return {
    baselinePath,
    prior: {
      baseline: tree.baseline,
      baselinePath,
      ...(anchorSource ? { anchorSource } : {}),
    },
    unreadable: null,
  };
}

/** The one parse of a chosen copy: a failure is carried as `unreadable`
 *  (which copy, where, why), never a thrown-and-swallowed absence. */
function parseBaseline(
  file: string,
  source: CommittedPriorUnreadable['source'],
): { baseline: BaselineFile } | { unreadable: CommittedPriorUnreadable } {
  try {
    return { baseline: readBaselineFile(file) };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { unreadable: { source, path: file, error } };
  }
}

/**
 * Shared phrasing of WHICH prior a committed read used (Rule 2: the planner's
 * header, its plan disclosure and the lane ledger print this one line). Names
 * the anchor branch and its capture date, or the tree copy with its capture
 * environment, and says when the tree copy is a fallback for an unreachable
 * anchor (a `capturedIn: local` copy is the stale-install-day shape).
 */
export function describePriorSource(prior: AcquiredPrior): string {
  const { baseline, anchorSource } = prior;
  const date = baseline.createdAt ? baseline.createdAt.slice(0, 10) : 'unknown date';
  if (anchorSource?.used === 'anchor') {
    return `anchor branch '${anchorSource.anchorRef}' captured ${date}`;
  }
  const where =
    baseline.capturedIn === 'local'
      ? `captured locally ${date}`
      : baseline.capturedIn === 'ci'
        ? `captured in CI ${date}`
        : `captured ${date}`;
  if (anchorSource?.used === 'tree-fallback') {
    return (
      `tree copy ${where} (anchor branch '${anchorSource.anchorRef}' unreachable: ` +
      'not created yet, offline, or unfetchable; the tree copy may be STALE)'
    );
  }
  return `tree copy ${where}`;
}

/**
 * The `fresh` prior (4.4.0 WP2): zero findings, with the CURRENT scan's
 * own envelope. Built AFTER the current gather (the engine calls this in
 * place of `acquirePrior` for the empty prior class), through the ONE
 * `CurrentScan → BaselineFile` converter. Using the current envelope is
 * the load-bearing choice: recall matches BY CONSTRUCTION (same run,
 * same environment), so Rule 19 composes — the drift machinery is
 * inapplicable-by-construction rather than disabled, and every finding
 * classifies `added` because the prior finding set is empty, never
 * because attribution was bypassed.
 */
export function emptyPriorFromScan(current: CurrentScan, name?: string): AcquiredPrior {
  return {
    baseline: scanToBaselineFile(current, {
      name: name ?? DEFAULT_BASELINE_NAME,
      findings: [],
    }),
  };
}

/**
 * The scheme-mismatch remedy, state-aware (exported for tests). A repo whose
 * LOCAL baseline is already current-scheme while the gate read a
 * stale-scheme ANCHOR gets the real next step (`baseline publish`) —
 * telling a user who just ran `update` to "run update" is a loop.
 */
export function schemeMismatchRemedy(
  baselineScheme: string,
  anchorSource: AnchorSourceDisclosure | undefined,
  treeScheme: string | null,
): string {
  if (anchorSource?.used === 'anchor' && treeScheme === CURRENT_IDENTITY_SCHEME) {
    return (
      `The LOCAL baseline is already migrated to ${CURRENT_IDENTITY_SCHEME}, but this ` +
      `gate reads the '${anchorSource.anchorRef}' anchor branch, which still holds ` +
      `${baselineScheme}. Run \`${dxkitCli('baseline publish')}\` to land the migrated ` +
      `baseline on the anchor (and commit .dxkit/allowlist.json).`
    );
  }
  return (
    `Run \`${dxkitCli('update')}\` to migrate the baseline + allowlist ` +
    `automatically, or \`${dxkitCli('baseline create --force')}\` to re-anchor manually.`
  );
}

/** Best-effort read of the `baseline` policy section (for the anchor transport);
 *  undefined when the policy is absent/unreadable. */
function safeBaselineSection(cwd: string): BaselineSection | undefined {
  try {
    return loadPolicyFromCwd(cwd).baseline;
  } catch {
    return undefined;
  }
}

/**
 * Guard: a committed baseline minted under an older identity scheme cannot be
 * meaningfully diffed against the current one — every finding's id changed, so
 * the matcher would report all pre-existing findings as net-new. Stop with an
 * actionable message instead of that confusing churn. (Dir-shaped priors —
 * ref-based today, fresh/tree-baseline in WP2 — re-gather the prior side with
 * the current dxkit, so they are always current-scheme and exempt; a baseline
 * written before this field existed reads as the original 'v1'.)
 */
export function assertPriorSchemeComparable(prior: AcquiredPrior, mode: ResolvedMode): void {
  if (priorClassOf(mode.mode) !== 'committed') return;
  const baselineScheme = prior.baseline.identityScheme ?? 'v1';
  if (baselineScheme === CURRENT_IDENTITY_SCHEME) return;
  // The remedy must match the STATE (observed on the live migration
  // test): on an anchor-transport repo, `update` migrates the LOCAL
  // baseline but the gate reads the ANCHOR — telling a user who just
  // ran update to "run update" is a loop. When the source was the
  // anchor and the tree copy is already current-scheme, the real next
  // step is `baseline publish`.
  let treeScheme: string | null = null;
  if (
    prior.anchorSource?.used === 'anchor' &&
    prior.baselinePath &&
    fs.existsSync(prior.baselinePath)
  ) {
    try {
      treeScheme = readBaselineFile(prior.baselinePath).identityScheme ?? 'v1';
    } catch {
      /* unreadable tree copy — keep the generic remedy */
    }
  }
  const remedy = schemeMismatchRemedy(baselineScheme, prior.anchorSource, treeScheme);
  throw new Error(
    `Baseline "${prior.baseline.name}" was captured under finding-identity scheme ` +
      `${baselineScheme}, but this dxkit mints ${CURRENT_IDENTITY_SCHEME}. The identity ` +
      `scheme changed between versions; diffing across schemes would flag every existing ` +
      `finding as net-new. ${remedy}`,
  );
}

/**
 * Acquire the prior side of the gate diff for a resolved mode. The
 * `fresh` (empty) prior is the one arm NOT served here — it derives
 * from the current scan, so the engine calls `emptyPriorFromScan`
 * after the current gather instead (same module, one prior home).
 */
export async function acquirePrior(
  cwd: string,
  mode: ResolvedMode,
  options: GateEngineOptions,
  incrementalFiles?: ReadonlyArray<string>,
  scope: GatherScope = FULL_SCOPE,
): Promise<AcquiredPrior> {
  if (mode.mode === 'fresh') {
    // Programming error, not a user error: the engine owns the ordering.
    throw new Error('fresh prior derives from the current scan — call emptyPriorFromScan.');
  }
  if (mode.mode === 'tree-baseline') {
    if (!mode.baselineDir) {
      throw new Error('tree-baseline mode requires a resolved baselineDir; got undefined.');
    }
    // The dir-shaped prior collapse (Rule 2): a supplied tree goes through
    // the SAME two canonical calls the ref arm uses — `gatherCurrentScan`
    // over a directory, projected by the ONE `scanToBaselineFile`
    // converter — the only difference being that no worktree needs
    // materializing first.
    const treeScan = await gatherCurrentScan({
      cwd: mode.baselineDir,
      verbose: options.verbose,
      scope,
      skipRemediation: true,
      trust: options.trust,
    });
    return {
      baseline: scanToBaselineFile(treeScan, {
        name: options.name ?? DEFAULT_BASELINE_NAME,
        findings: treeScan.findings,
      }),
    };
  }
  if (mode.mode !== 'ref-based') {
    // The committed prior: the ONE anchor-first-then-tree read shared with
    // the refresh lane and the remediation planner (#387).
    const read = readCommittedPrior(cwd, {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.baselinePath !== undefined ? { baselinePath: options.baselinePath } : {}),
    });
    // A prior that exists but cannot be parsed refuses the gate exactly as
    // the parse error always did; only an absent prior gets the capture remedy.
    if (read.unreadable) throw read.unreadable.error;
    if (!read.prior) {
      throw new Error(
        `baseline file not found: ${read.baselinePath}. ` +
          `Run \`${dxkitCli('baseline create')}\` first to capture today's state.`,
      );
    }
    return read.prior;
  }

  if (!mode.ref) {
    // Defensive: the resolver always populates `ref` for ref-based
    // mode. A missing ref here would be a programming error.
    throw new Error('ref-based baseline mode requires a resolved ref; got undefined.');
  }
  const refScan = await gatherFromRef({
    cwd,
    ref: mode.ref,
    verbose: options.verbose,
    // Same policy-derived scope as the current side (opt 1), so the cross-run
    // diff stays balanced and the ref side skips the same non-blockable
    // analyzers.
    scope,
    // Symmetric incremental scoping: when the caller scoped the current side
    // to the changed files, scope the ref side to the SAME set (see the
    // `refIncrementalFiles` computation in the engine).
    incrementalFiles,
    // Match the current side: skip the dep remediation enrichment (the gate
    // never reads `upgradePlan`; the enrichment runs the package manager).
    skipRemediation: true,
    // Match the current side: never execute untrusted source during the audit.
    trust: options.trust,
  });
  // The ref-based prior side goes through the ONE `CurrentScan -> BaselineFile`
  // converter, so it carries `recall` + `coverage` exactly like the committed
  // write does. Hand-building it here is what dropped recall and made ref-based
  // mode drift on every run (Rule 2.30) — never reconstruct it inline.
  const baseline = scanToBaselineFile(refScan, {
    name: options.name ?? DEFAULT_BASELINE_NAME,
    findings: refScan.findings,
  });
  return { baseline };
}
