/**
 * Capture-time deferral (CLAUDE.md Rule 20, applied to the baseline itself).
 *
 * A baseline is only sound if it is captured in an environment that can
 * OBSERVE every finding class it claims to cover. The pre-4.0.2 capture path
 * assumed the machine running `init` could see everything — false whenever a
 * class's scanner cannot run here: a corporate PyPI mirror too stale to install
 * the pinned Python scanners, or a windows-only build gate on a linux operator's
 * laptop. When that assumption broke, the capture fail-opened and committed a
 * PARTIAL baseline as if it were authoritative — and every unobserved class then
 * drifted to warn-only on the first CI run, where the full toolchain DID install
 * (Rule 19). The gate looked green while enforcing nothing.
 *
 * This module answers the one question the capture path must ask BEFORE writing:
 * "which finding classes can this environment capture soundly, and which must be
 * deferred to one that can?" It unifies the two independent signals that make a
 * class unobservable here — deliberately, because they are architecturally
 * distinct (see `requirement.ts`):
 *
 *   1. a REGISTRY SCANNER is missing (`source === 'missing'`) — gitleaks,
 *      semgrep, pip-audit, jscpd… These are provisioned by `tools install`, so
 *      "missing here" usually means the local machine couldn't fetch the pinned
 *      version (a stale mirror / offline proxy). This is the incident's signal.
 *   2. a capability's EXECUTION REQUIREMENT is unmet (`unmetRequirement`) — the
 *      wrong host or a missing ambient toolchain (a `net*-windows` build on
 *      linux, a missing .NET SDK). This is the Rule 20 host/toolchain signal.
 *
 * Both route to the same answer — defer this class to the environment that can
 * observe it (CI, with the guaranteed pinned toolchain). The capture path records
 * the deferral honestly on the baseline; it never fabricates a "measured and
 * clean" record for a class it did not run.
 */

import * as path from 'path';

import { detect } from '../detect';
import { checkAllTools, type ToolStatus } from '../analyzers/tools/tool-registry';
import { collectExecutionRequirements, detectActiveLanguages } from '../languages';
// exec-requirement-ok: capture-time deferral is a deliberate Rule 20 consumer
// (the "init honesty" case named in the arch-check) — it asks the ONE predicate
// "can this environment observe the class?" before the baseline claims it did.
import {
  currentEnvironment,
  describeUnmetRequirement,
  unmetRequirement,
  type CapabilityRequirement,
  type ExecutionEnvironment,
} from '../execution';
import type { DeferredCaptureClass } from './baseline-file';

export type { DeferredCaptureClass };

export interface CaptureDeferral {
  /** Classes that must be captured elsewhere (empty ⇒ this environment can
   *  observe everything, and a locally-captured baseline is authoritative). */
  readonly deferred: readonly DeferredCaptureClass[];
}

/** Baseline-contributing capabilities whose execution requirement can gate the
 *  committed baseline. `correctness` is the liveness floor (never baselined —
 *  Rule 15) and `lintGate` has its own per-host fragment path (Rule 20 §3.4),
 *  so neither belongs in the capture-deferral partition. */
const BASELINE_CONTRIBUTING_CAPABILITIES: ReadonlySet<CapabilityRequirement['capability']> =
  new Set(['depVulns', 'deepSast']);

export interface AssessCaptureDeferralOptions {
  /** The environment to assess against. Default: the real local one. Injected
   *  in tests to simulate a stale-mirror / wrong-host machine. */
  readonly env?: ExecutionEnvironment;
  /** Pre-probed tool statuses (init already computes these — pass them to avoid
   *  a second probe). Default: `checkAllTools` for the detected stack. */
  readonly statuses?: readonly ToolStatus[];
  /** Capability execution requirements. Default: `collectExecutionRequirements`
   *  for the detected packs. Injected in tests to exercise signal 2 without
   *  constructing a windows-gated fixture. */
  readonly requirements?: readonly CapabilityRequirement[];
}

/**
 * Partition the repo's finding classes into observable-here vs deferred, for
 * THIS environment. Pure w.r.t. the injected env + statuses (no hidden global
 * state); the two default sources (`checkAllTools`, `currentEnvironment`) are
 * the same ones `init` and the runners already use, so the answer matches what
 * a full local capture would actually have observed.
 */
export function assessCaptureDeferral(
  cwd: string,
  opts: AssessCaptureDeferralOptions = {},
): CaptureDeferral {
  const resolved = path.resolve(cwd);
  const stack = detect(resolved);
  const env = opts.env ?? currentEnvironment();
  const statuses = opts.statuses ?? checkAllTools(stack.languages, resolved);

  const byId = new Map<string, DeferredCaptureClass>();

  // Signal 1 — a registry scanner that would populate a class is missing here.
  for (const s of statuses) {
    if (s.source !== 'missing') continue; // 'n/a' means the class doesn't apply — not a gap
    if (byId.has(s.name)) continue;
    byId.set(s.name, {
      id: s.name,
      label: s.requirement.description ?? s.name,
      reason:
        `${s.name} is not available in this environment — likely a package index that ` +
        `cannot reach the pinned version (a mirror or offline proxy). CI has the guaranteed ` +
        `toolchain, so this class is captured there.`,
      cause: 'scanner-missing',
    });
  }

  // Signal 2 — a baseline-contributing capability's host/toolchain requirement
  // is unmet here (the Rule 20 wrong-host / missing-SDK case).
  const requirements =
    opts.requirements ?? collectExecutionRequirements(resolved, detectActiveLanguages(resolved));
  for (const req of requirements) {
    if (!BASELINE_CONTRIBUTING_CAPABILITIES.has(req.capability)) continue;
    const unmet = unmetRequirement(req.requirement, env);
    if (unmet === null) continue;
    const id = `${req.pack}:${req.capability}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      label: `${req.capability} (${req.pack})`,
      reason: describeUnmetRequirement(unmet, env.host),
      cause: 'unmet-requirement',
    });
  }

  const deferred = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { deferred };
}
