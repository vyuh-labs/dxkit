/**
 * Workspace-derived install-flag detection — the LEGACY FALLBACK for a repo
 * whose manifest does not carry `installFlags` (pre-2.5.2) or carries a partial
 * set. Split out of `managed-artifacts.ts` so that file stays the registry and
 * nothing else.
 *
 * This is one of the three lifecycle paths that DERIVE from
 * `MANAGED_SHIP_SURFACES` (CLAUDE.md Rule 15): the gated surfaces are inferred
 * from the registry's own `detectPresent` probes, never a hand-maintained list
 * here. The non-surface flags (`withDxkitAgents` is generator-driven,
 * `withPrecommit` / `withCiPushTrigger` are modifiers) are probed directly
 * because no surface owns them.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ManifestInstallFlags } from './types';
import { MANAGED_SHIP_SURFACES, existsRel } from './managed-artifacts';
import {
  graphRefreshEnabled,
  reportsRefreshEnabled,
  flowRefreshEnabled,
  extensionsRefreshEnabled,
  commentCommandsEnabled,
  depBumpEnabled,
  remediateEnabled,
} from './ship-installers';

/** Whether an already-installed guardrails workflow carries the opt-in `push:`
 *  trigger, so update's workspace-fallback path preserves it. */
function guardrailsHasPushTrigger(cwd: string): boolean {
  try {
    const wf = fs.readFileSync(
      path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml'),
      'utf8',
    );
    return /^\s*push:/m.test(wf);
  } catch {
    return false;
  }
}

/**
 * Workspace-derived flag detection — the fallback when a manifest doesn't carry
 * `installFlags` (pre-2.5.2 manifests) or is partial.
 *
 * False-positive risk is bounded — the installers are idempotent and emit
 * sidecars on conflict, so spurious detection can't clobber user state.
 */
export function detectInstallFlags(cwd: string): ManifestInstallFlags {
  const flags: ManifestInstallFlags = {
    withDxkitAgents: existsRel(cwd, path.join('.claude', 'skills', 'dxkit-learn')),
    withHooks: false,
    withPrecommit: existsRel(cwd, path.join('.githooks', 'pre-commit')),
    withDevcontainer: false,
    withCiGuardrails: false,
    withBaselineRefresh: false,
    withPrReview: false,
    withClaudeLoop: false,
    withCiPushTrigger: guardrailsHasPushTrigger(cwd),
    withDeepSastRefresh: false,
    withGraphRefresh: false,
    withReportsRefresh: false,
    withFlowRefresh: false,
    withExtensionsRefresh: false,
  };
  for (const surface of MANAGED_SHIP_SURFACES) {
    if (surface.gate.kind === 'flag' && surface.detectPresent) {
      flags[surface.gate.flag] = surface.detectPresent(cwd);
    }
  }
  return applyPolicyDerivedFlags(cwd, flags);
}

/**
 * OR the POLICY-DERIVED surface enables over whatever flags the caller already
 * has. THE one home for "policy switched this surface on" (Rule 2), consumed by
 * BOTH flag sources: `detectInstallFlags` (presence-derived) and `update`'s
 * `resolveInstallFlags` (manifest-derived).
 *
 * # The class this closes
 *
 * These surfaces are opt-in through policy, so a repo that set
 * `depBump.enabled: true` but has not installed the workflow yet MUST read as
 * enabled — otherwise `update` never lays it down. That OR was applied only on
 * the presence-derived path, and `resolveInstallFlags` returns the MANIFEST's
 * recorded flags verbatim whenever it has them (every modern install), so the
 * derivation was unreachable in the exact case it exists for: a flag absent
 * from an older manifest's record reads as `undefined` → falsy → skipped.
 *
 * The shipped consequence, found while dogfooding a fleet rollout: enable a lane
 * in policy, run `vyuh-dxkit update`, and the knob is ON with no workflow behind
 * it — the silent no-op Rule 15's registry exists to prevent, reintroduced one
 * layer up by a second source of truth for the same question. Two sources, the
 * stale one winning, no error: CLAUDE.md 2.30's semantic-divergence shape.
 *
 * Deliberately one-directional (OR, never AND): policy can only turn a surface
 * ON here. Turning one off is `uninstall`'s job, which reads provenance — an
 * update must never delete a workflow because a knob flipped.
 */
/**
 * The policy-switched lanes: each install flag, the switch that turns it on,
 * and the predicate that reads it. ONE list, read by two consumers:
 * `applyPolicyDerivedFlags` (install time: a switch turned on installs the
 * workflow) and `laneSwitchFor` (run time: the installed workflow asks
 * whether its switch is still on, via `vyuh-dxkit jobs enabled`). Install
 * is one-directional by design (update never deletes a workflow), so
 * without the run-time read a lane switched off kept firing on schedule.
 */
export interface LaneSwitch {
  readonly flag: keyof ManifestInstallFlags;
  /** The policy setting a user changes to turn the lane on or off. */
  readonly switchName: string;
  readonly enabled: (cwd: string) => boolean;
}

export const LANE_SWITCHES: readonly LaneSwitch[] = [
  { flag: 'withGraphRefresh', switchName: 'graph.refresh: "cache"', enabled: graphRefreshEnabled },
  { flag: 'withReportsRefresh', switchName: 'reports.onMerge', enabled: reportsRefreshEnabled },
  { flag: 'withFlowRefresh', switchName: 'flow.onMergeRefresh', enabled: flowRefreshEnabled },
  {
    flag: 'withExtensionsRefresh',
    switchName: 'an extension manifest with refresh: "on-merge"',
    enabled: extensionsRefreshEnabled,
  },
  {
    flag: 'withCommentDefer',
    switchName: 'newAdvisories.commentCommands',
    enabled: commentCommandsEnabled,
  },
  { flag: 'withDepBump', switchName: 'depBump.enabled', enabled: depBumpEnabled },
  { flag: 'withRemediate', switchName: 'remediate.enabled', enabled: remediateEnabled },
];

/** The switch governing an installed workflow (`dxkit-dep-bump.yml`), found
 *  through the surface registry's own artifact list; undefined for a
 *  workflow no policy switch governs (the guardrails, the baseline refresh). */
export function laneSwitchFor(workflowFile: string): LaneSwitch | undefined {
  const rel = `.github/workflows/${path.basename(workflowFile)}`;
  return LANE_SWITCHES.find((lane) =>
    MANAGED_SHIP_SURFACES.some(
      (surface) =>
        surface.gate.kind === 'flag' &&
        surface.gate.flag === lane.flag &&
        surface.artifacts({} as ManifestInstallFlags).includes(rel),
    ),
  );
}

export function applyPolicyDerivedFlags(
  cwd: string,
  flags: ManifestInstallFlags,
): ManifestInstallFlags {
  // Assign only where policy says YES, so a repo that enabled nothing gets a
  // byte-identical flag set back. Writing `false` into every slot would work
  // for update, but it would also silently rewrite the shape every other
  // consumer (and the manifest self-migration) sees.
  for (const lane of LANE_SWITCHES) {
    if (!flags[lane.flag] && lane.enabled(cwd)) flags[lane.flag] = true;
  }
  return flags;
}
