/**
 * `baseline create` — the committed WRITE orchestrator, split from
 * `./create` at the large-file bar. `gatherCurrentScan` +
 * `scanToBaselineFile` (the scan/projection halves) stay in `./create`;
 * this module owns mode resolution for the write, sanitization, the
 * salt hard-error, and the file write. Re-exported from `./create` so
 * consumers keep one import surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_BASELINE_NAME, pathForBaseline, writeBaselineFile } from './baseline-file';
import type { BaselineFile } from './baseline-file';
import { resolveBaselineMode } from './modes';
import type { ResolvedMode } from './modes';
import { loadPolicyFromCwd } from './policy';
import { resolveSalt } from '../analyzers/tools/salt';
import { sanitizeFile } from './sanitize';
import { resolveEffectiveAllowlist } from '../allowlist/effective';
import { entryToAllowlistable, partitionByActiveAllowlist } from './allowlist-match';
import { captureFloorDebt } from './floor-debt';
import { trustedLocalContext } from '../analysis-trust';
import { gatherCurrentScan, scanToBaselineFile } from './create';

export interface CreateBaselineOptions {
  /** Repo root to baseline. Caller should pass an absolute path. */
  readonly cwd: string;
  /** Baseline name (becomes the filename stem under `.dxkit/baselines/`).
   *  Defaults to `'main'`. Different names allow per-branch / per-
   *  environment baselines to coexist on disk. */
  readonly name?: string;
  /** When true, overwrite an existing baseline file at the same path.
   *  When false (default), an existing file makes `createBaseline`
   *  throw — guards against accidentally clobbering a committed
   *  baseline with a fresh capture. */
  readonly force?: boolean;
  /** Forwarded to the underlying analyzer for per-tool timing logs. */
  readonly verbose?: boolean;
  /** Pre-resolved baseline mode. When supplied, the orchestrator
   *  skips its own resolution + policy load. Callers wanting
   *  deterministic behavior (tests, agents) pass this. */
  readonly resolvedMode?: ResolvedMode;
  /** Explicit CLI flag value for the mode (`--mode=<X>`). Forwarded
   *  to `resolveBaselineMode`. Ignored when `resolvedMode` is
   *  supplied. */
  readonly cliMode?: ResolvedMode['mode'];
  /** Explicit CLI flag value for the ref (`--ref=<R>`). Only
   *  consulted when the resolved mode is `ref-based`. */
  readonly cliRef?: string;
  /** Capture the correctness-floor debt envelope (compile + tests, full
   *  scope, bounded per-check). Default ON — cleanup agents rely on the
   *  envelope existing — with two opt-outs: pass `false` (the `--no-floor`
   *  flag) or set DXKIT_BASELINE_NO_FLOOR=1 (the test suite does, so
   *  hundreds of fixture baselines don't each run a floor pass). An
   *  explicit option always wins over the env. */
  readonly floor?: boolean;
}

/** Outcome of `createBaseline`. `path` and `file` are absent when
 *  mode resolved to `ref-based` — no file is written, and the
 *  `mode` field carries the audit trail so callers can surface
 *  WHY nothing landed on disk. */
export interface CreateBaselineResult {
  readonly mode: ResolvedMode;
  readonly path?: string;
  readonly file?: BaselineFile;
  /** How the captured findings split between what was baselined (`live`) and
   *  what an active allowlist entry suppressed and held OUT of the baseline
   *  (`allowlisted`, gh #155). Absent for `ref-based` mode (no file written).
   *  `byCategory` breaks the held-out count down by suppression category so the
   *  CLI can report an honest `N findings baselined (M allowlisted)` line. */
  readonly allowlistSplit?: {
    readonly live: number;
    readonly allowlisted: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
}

/**
 * Run the baseline-create pipeline. Pure-orchestrator: resolve
 * the baseline mode, gather the current scan, then either:
 *
 *   - `committed-full` → write rich entries to disk (today's
 *     behavior).
 *   - `committed-sanitized` → sanitize every entry, then write.
 *     The cross-run matching contract is preserved; locator
 *     fields are stripped.
 *   - `ref-based` → no file write. The guardrail check will
 *     recompute the prior side from a git ref instead.
 *
 * In all three cases the returned `CreateBaselineResult` carries
 * `resolvedMode` so callers can log WHY a given mode was picked
 * (CLI flag / policy file / visibility auto-detect).
 */
export async function createBaseline(
  options: CreateBaselineOptions,
): Promise<CreateBaselineResult> {
  const cwd = path.resolve(options.cwd);
  const name = options.name ?? DEFAULT_BASELINE_NAME;
  const mode =
    options.resolvedMode ??
    (() => {
      const policy = loadPolicyFromCwd(cwd);
      return resolveBaselineMode({
        cwd,
        cliMode: options.cliMode,
        cliRef: options.cliRef,
        policyMode: policy.baseline?.mode,
        policyRef: policy.baseline?.ref,
      });
    })();

  if (mode.mode === 'ref-based') {
    // Ref-based mode keeps no committed baseline. We still run no
    // gather here — the guardrail check does it on demand against
    // the configured ref. Returning the resolved mode lets the CLI
    // surface a clear "ref-based mode active; no file written" log.
    return { mode };
  }

  resolveSalt(cwd); // a COMMITTED baseline needs a re-derivable salt — hard error kept

  const filePath = pathForBaseline(cwd, name);
  if (!options.force && fs.existsSync(filePath)) {
    throw new Error(
      `baseline already exists at ${filePath}. Pass force: true to overwrite, ` +
        `or use a different --name to keep both.`,
    );
  }

  // Baseline capture runs on the operator's own tree by definition — you do
  // not baseline untrusted content. Explicit, not defaulted (4.2).
  const scan = await gatherCurrentScan({
    cwd,
    verbose: options.verbose,
    trust: trustedLocalContext(),
  });

  // Exclude actively-allowlisted findings from the captured set so a
  // reviewed-and-accepted finding never grandfathers into the baseline as
  // `persisted` (gh #155). Grandfathering an allowlisted finding double-
  // suppresses it AND defeats its expiry — a `persisted` finding never blocks,
  // so an accepted-risk entry that later lapsed would silently stay suppressed.
  // Held OUT of the baseline, the allowlist (with its expiry) is the single
  // source of suppression: an active entry keeps the finding suppressed today,
  // and when it lapses the finding resurfaces as net-new on the next check.
  // Resolved through the ONE effective-allowlist constructor + the ONE active-
  // suppression predicate, so create sees the identical suppression set the
  // guardrail check and the security score do (Rule 2).
  const effectiveAllowlist = resolveEffectiveAllowlist({
    cwd,
    findings: scan.findings.map(entryToAllowlistable),
    inlineAnnotations: scan.producerCtx.inlineAllowlistAnnotations,
  });
  const { live, suppressions } = partitionByActiveAllowlist(
    scan.findings,
    effectiveAllowlist,
    new Date(),
  );
  const byCategory: Record<string, number> = {};
  for (const s of suppressions) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;

  // Floor-debt inventory (T2.3 follow-through): record the pre-existing
  // build/test state WITH details so cleanup agents can prioritize and fix
  // it (`vyuh-dxkit debt`). Bounded; never gates; explicit option beats env.
  const captureFloor = options.floor ?? process.env.DXKIT_BASELINE_NO_FLOOR !== '1';
  const floorDebt = captureFloor ? (captureFloorDebt(cwd) ?? undefined) : undefined;

  const richFile = scanToBaselineFile(scan, { name, findings: live, floorDebt });

  const file = mode.mode === 'committed-sanitized' ? sanitizeFile(richFile) : richFile;
  writeBaselineFile(filePath, file);
  return {
    mode,
    path: filePath,
    file,
    allowlistSplit: { live: live.length, allowlisted: suppressions.length, byCategory },
  };
}
