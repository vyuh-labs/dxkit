/**
 * Nested dependency-audit roots — discovery + outcome merging for the
 * nested-lockfile gap: the dep audit ran at the repo root only, so a
 * vulnerability introduced in a nested sub-project's lockfile (a `server/`
 * app with its own `package-lock.json` that is not a workspace member) was
 * invisible to `health`, `vulnerabilities`, and the guardrail gate.
 *
 * One code path (Rule 2): the shared dispatch primitive
 * (`gatherDepVulnsWithAvailability`) routes EVERY consumer through this
 * module, so reports and the gate can never disagree about which lockfiles
 * were audited. Which basenames mark an independent root is pack-declared
 * (`DepVulnsProvider.lockfilePatterns`, Rule 6); discovery uses the
 * canonical depth-unlimited walker (exclusion-aware, so `node_modules` /
 * `vendor` lockfiles never count).
 */

import * as path from 'path';
import { walkPaths } from '../tools/walk-paths';
import type {
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  SeverityCounts,
} from '../../languages/capabilities/types';

/**
 * Ceiling on nested roots audited per pack per run. A pathological tree
 * (hundreds of vendored sub-projects that somehow escape exclusions) must
 * not turn one audit into hundreds of scanner invocations. NEVER silent:
 * the merged envelope's tool string carries a `+capped` marker and the
 * discovery result reports what was dropped.
 */
export const MAX_NESTED_DEP_ROOTS = 8;

export interface NestedRootDiscovery {
  /** Repo-relative directories (POSIX) to audit IN ADDITION to the root. */
  readonly roots: readonly string[];
  /** Directories beyond the cap, disclosed rather than silently dropped. */
  readonly dropped: readonly string[];
}

/**
 * Directories below `cwd` (never the root itself — the root audit already
 * runs) containing one of the pack's independent-resolution lockfiles.
 * Exclusion-aware and deterministic (sorted by path, cap applied after).
 */
export function discoverNestedDepRoots(
  cwd: string,
  lockfileBasenames: readonly string[],
): NestedRootDiscovery {
  if (lockfileBasenames.length === 0) return { roots: [], dropped: [] };
  const files = walkPaths(cwd, { extensions: [], basenames: [...lockfileBasenames] });
  const dirs = new Set<string>();
  for (const rel of files) {
    const dir = path.posix.dirname(rel);
    if (dir === '.' || dir === '') continue; // the root audit covers these
    dirs.add(dir);
  }
  const sorted = [...dirs].sort();
  return {
    roots: sorted.slice(0, MAX_NESTED_DEP_ROOTS),
    dropped: sorted.slice(MAX_NESTED_DEP_ROOTS),
  };
}

const SEVERITY_RANK: Record<DepVulnFinding['severity'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Per-package severity counts from a deduped finding list — the documented
 *  count model (counts are per PACKAGE at its worst severity; findings are
 *  per advisory). Only used on a multi-root merge; a single outcome passes
 *  through untouched. */
function recountByPackage(findings: readonly DepVulnFinding[]): SeverityCounts {
  const worst = new Map<string, DepVulnFinding['severity']>();
  for (const f of findings) {
    const key = `${f.package}\0${f.installedVersion ?? ''}`;
    const prev = worst.get(key);
    if (prev === undefined || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev]) {
      worst.set(key, f.severity);
    }
  }
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const sev of worst.values()) counts[sev]++;
  return counts;
}

/**
 * Merge one pack's root + nested audit outcomes into a single outcome.
 *
 * - No success anywhere → the ROOT outcome verbatim (the nested audits are
 *   additive recall; they never degrade the root's availability story).
 * - Exactly one success and it is the root's, with no nested successes →
 *   passthrough (byte-identical behavior for the single-lockfile majority).
 * - Otherwise: findings concatenated and deduped on the finding's true
 *   identity `(package, installedVersion, advisory id)` — the same vuln in
 *   two sub-projects is one finding (identity carries no location); counts
 *   recomputed per-package from the deduped set; tool string is the union
 *   (`npm-audit+osv-scanner`), with `+capped` appended when discovery
 *   dropped roots beyond the ceiling.
 */
export function mergeDepVulnOutcomes(
  root: DepVulnGatherOutcome,
  nested: readonly DepVulnGatherOutcome[],
  capped: boolean,
): DepVulnGatherOutcome {
  const successes: DepVulnResult[] = [];
  if (root.kind === 'success') successes.push(root.envelope);
  for (const n of nested) if (n.kind === 'success') successes.push(n.envelope);

  if (successes.length === 0) return root;
  if (successes.length === 1 && root.kind === 'success' && !capped) return root;

  const seen = new Set<string>();
  const findings: DepVulnFinding[] = [];
  for (const env of successes) {
    for (const f of env.findings ?? []) {
      const key = `${f.package}\0${f.installedVersion ?? ''}\0${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  const tools = [...new Set(successes.map((e) => e.tool))].join('+');
  const envelope: DepVulnResult = {
    ...successes[0],
    tool: capped ? `${tools}+capped` : tools,
    counts: recountByPackage(findings),
    findings,
  };
  return { kind: 'success', envelope };
}
