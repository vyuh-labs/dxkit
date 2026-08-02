/**
 * Baseline PROVENANCE — the ONE place that answers "where did this repo's
 * committed baseline come from, and is it still a sound anchor?" (Rule 2.30
 * applied to baseline freshness: `capturedIn`, `createdAt`, and the CI
 * refresh lane's presence were all RECORDED, but no consumer read them — so
 * the guardrail issued a confident BLOCKED over a stale anchor, doctor
 * scored a local-anchor repo healthy, and the drift remediation recommended
 * the documented anti-pattern.)
 *
 * Consumers, all through this module:
 *   - `recallDriftRemedy` (the guardrail's envelope-drift copy) — recommends
 *     the CI refresh lane when it exists, `--force` only when it does not;
 *   - doctor's local-anchor check — a `capturedIn: local` committed baseline
 *     with no refresh workflow is the exact combination getting-started.md
 *     warns about;
 *   - the guardrail's baseline-suspect staleness disclosure (`check.ts`) —
 *     a delta wave in files the diff never touched is a stale-anchor
 *     signature, not developer fault.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo-relative path of the CI baseline-refresh workflow. The canonical
 * declaration lives on the `ci-baseline-refresh` managed surface
 * (`src/managed-artifacts.ts`); duplicated here as a constant (NOT a runtime
 * import — that would pull the whole ship-installer graph into every
 * guardrail run) and pinned against the registry by
 * `test/baseline/provenance.test.ts`.
 */
export const REFRESH_WORKFLOW_RELPATH = '.github/workflows/dxkit-baseline-refresh.yml';

/** Is the CI baseline-refresh lane installed in this repo? */
export function refreshWorkflowInstalled(cwd: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, REFRESH_WORKFLOW_RELPATH));
  } catch {
    return false;
  }
}

/** The provenance facts a consumer branches on. */
export interface BaselineProvenance {
  /** Where the committed baseline was captured (absent on pre-provenance
   *  baselines — treated as unknown, never assumed CI). */
  readonly capturedIn?: 'ci' | 'local';
  /** ISO capture timestamp from the baseline file. */
  readonly createdAt?: string;
  /** Whether the CI refresh lane exists — decides which re-baseline remedy
   *  is honest to recommend. */
  readonly refreshWorkflowInstalled: boolean;
}

export function readBaselineProvenance(
  cwd: string,
  baseline?: { readonly capturedIn?: 'ci' | 'local'; readonly createdAt?: string },
): BaselineProvenance {
  return {
    ...(baseline?.capturedIn !== undefined ? { capturedIn: baseline.capturedIn } : {}),
    ...(baseline?.createdAt !== undefined ? { createdAt: baseline.createdAt } : {}),
    refreshWorkflowInstalled: refreshWorkflowInstalled(cwd),
  };
}

/**
 * The staleness signature (#222): a large share of ADDED findings living in
 * files the diff under review never touched. Mechanically each finding has no
 * baseline match, but the truer cause is an anchor that predates the base
 * branch's recent history — the developer did not introduce a wave of
 * findings into files they never edited. Pure; thresholds deliberately
 * conservative (a disclosure, never a gating change).
 */
export interface BaselineSuspect {
  /** Added findings in files the diff did not touch. */
  readonly untouchedAdded: number;
  /** Total added findings considered. */
  readonly totalAdded: number;
  /** The baseline's capture timestamp, for the disclosure line. */
  readonly createdAt?: string;
  /** Human remedy — re-baseline deliberately on the base branch. */
  readonly remedy: string;
}

/** Minimum added findings before the signature is even evaluated — small
 *  deltas are triaged by hand and need no meta-disclosure. */
const SUSPECT_MIN_ADDED = 8;
/** Fraction of added findings outside the diff at/above which the anchor is
 *  suspect. */
const SUSPECT_MIN_FRACTION = 0.6;

/** Shared phrasing (Rule 2) — console, markdown, and the receipt agree. */
export function describeBaselineSuspect(s: BaselineSuspect): string {
  const anchor = s.createdAt ? ` (anchor captured ${s.createdAt.slice(0, 10)})` : '';
  return (
    `baseline suspect: ${s.untouchedAdded} of ${s.totalAdded} net-new findings are in files ` +
    `this change does not touch${anchor} — likely a stale anchor, not this change; ${s.remedy}`
  );
}

export function detectBaselineSuspect(args: {
  /** Files (repo-relative) of each ADDED-status finding, one per finding. */
  readonly addedFiles: readonly string[];
  /** The diff's changed-file set; null/undefined = unknowable → no claim. */
  readonly changedFiles: readonly string[] | null | undefined;
  readonly provenance: BaselineProvenance;
}): BaselineSuspect | null {
  const { addedFiles, changedFiles, provenance } = args;
  if (!changedFiles) return null; // cannot attribute either way — say nothing
  if (addedFiles.length < SUSPECT_MIN_ADDED) return null;
  const changed = new Set(changedFiles);
  const untouched = addedFiles.filter((f) => !changed.has(f)).length;
  if (untouched / addedFiles.length < SUSPECT_MIN_FRACTION) return null;
  const remedy = provenance.refreshWorkflowInstalled
    ? 'dispatch the baseline-refresh workflow (or merge to the default branch) to re-anchor from CI'
    : 'run `vyuh-dxkit baseline create --force` on the base branch to re-anchor deliberately';
  return {
    untouchedAdded: untouched,
    totalAdded: addedFiles.length,
    ...(provenance.createdAt !== undefined ? { createdAt: provenance.createdAt } : {}),
    remedy,
  };
}
