/**
 * The ONE entry point that gathers a repo's custom-check findings for a cwd:
 * user-declared checks (`.dxkit/policy.json:checks`) PLUS pack-declared built-in
 * lint (`lint.enabled`). Both normalize to runner specs and run through the one
 * `runCustomChecks` — so the baseline producer (create time) and the guardrail
 * current-scan see the identical set from the identical code path (Rule 2).
 *
 * Zero-cost when nothing is configured: no `checks`, `lint.enabled` falsy →
 * returns `[]` without spawning anything. So a repo that hasn't opted into
 * custom checks pays nothing, and the custom-check kind contributes no baseline
 * entries.
 */

import { detectActiveLanguages } from '../../languages';
import type { LanguageSupport } from '../../languages/types';
import type { BrownfieldPolicy } from '../../baseline/policy';
import { lintGateSpecs, normalizeCustomChecks } from './config';
import { runCustomChecks } from './run';
import type { CommandExec } from '../tools/bounded-exec';
import { gatherExtensionFindings } from '../../extensions/extension-findings';
import type { CustomCheckFinding, CustomCheckSpec } from './types';

export interface GatherCustomChecksOptions {
  readonly cwd: string;
  readonly policy: BrownfieldPolicy;
  /** Active language packs. Defaults to `detectActiveLanguages(cwd)`; injected
   *  in tests + reused by callers that already detected them. */
  readonly packs?: readonly LanguageSupport[];
  /** Repo-relative changed files, threaded to lint providers (most lint the
   *  whole tree; the field is available for packs that scope). */
  readonly changedFiles?: readonly string[];
  /** Per-command wall-clock budget (ms); a slow check is a fail-open skip. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
}

/** Resolve the full spec set (user checks + built-in lint) for a repo. Pure
 *  aside from `detectActiveLanguages` (which reads the tree). Exposed so callers
 *  can tell "are any checks configured?" without running them. */
export function resolveCustomCheckSpecs(opts: GatherCustomChecksOptions): CustomCheckSpec[] {
  const { specs: userSpecs } = normalizeCustomChecks(opts.policy.checks);
  const packs = opts.packs ?? detectActiveLanguages(opts.cwd);
  const lintSpecs = lintGateSpecs(
    packs,
    { cwd: opts.cwd, changedFiles: opts.changedFiles ?? [] },
    opts.policy.lint,
  );
  return [...userSpecs, ...lintSpecs];
}

/**
 * Run every configured custom check for `cwd` and return the flattened
 * findings. Returns `[]` (no spawn) when nothing is configured.
 */
export function gatherCustomCheckFindings(
  opts: GatherCustomChecksOptions,
): readonly CustomCheckFinding[] {
  const specs = resolveCustomCheckSpecs(opts);
  const commandFindings =
    specs.length === 0
      ? []
      : runCustomChecks({
          cwd: opts.cwd,
          specs,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
        }).findings;
  // The seam's third consumer (after user checks + pack lint): findings
  // committed by findings-kind EXTENSIONS. Snapshot reads only — nothing
  // executes here (extensions run at refresh time; gates stay offline) —
  // and both the baseline producer and the guardrail current scan reach
  // extension findings through THIS one entry point, so the two sides
  // always see the identical set (Rule 2).
  return [...commandFindings, ...gatherExtensionFindings(opts.cwd)];
}
