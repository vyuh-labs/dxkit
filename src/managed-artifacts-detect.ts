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
  // Graph-refresh is opt-in via policy, so a repo that set `graph.refresh:
  // "cache"` but hasn't installed the workflow yet must still be treated as
  // enabled — otherwise `update` would never lay it down. Presence OR policy.
  flags.withGraphRefresh = flags.withGraphRefresh || graphRefreshEnabled(cwd);
  flags.withReportsRefresh = flags.withReportsRefresh || reportsRefreshEnabled(cwd);
  flags.withFlowRefresh = flags.withFlowRefresh || flowRefreshEnabled(cwd);
  flags.withExtensionsRefresh = flags.withExtensionsRefresh || extensionsRefreshEnabled(cwd);
  flags.withCommentDefer = flags.withCommentDefer || commentCommandsEnabled(cwd);
  flags.withDepBump = flags.withDepBump || depBumpEnabled(cwd);
  flags.withRemediate = flags.withRemediate || remediateEnabled(cwd);
  return flags;
}
