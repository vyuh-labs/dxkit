/**
 * The placement resolver (CLAUDE.md Rule 20, design §3.3): given the
 * repo's capability requirements and the primary execution host, decide
 * WHERE each capability runs. "CI-bootstrap onboarding" and "the windows CI
 * stage" are OUTPUTS of this resolver, never special cases — a capability
 * whose declared hosts exclude the primary is ROUTED to a host job that can
 * serve it, and the generator emits that job from the plan.
 *
 * The resolver is pure and layer-clean: it consumes structural
 * `CapabilityRequirement` inputs (collected from the packs by
 * `collectExecutionRequirements` in `src/languages/index.ts` — the languages
 * layer knows packs; this layer only knows requirements). It shares the ONE
 * concept with the runners' disclosure path: what the resolver places off the
 * primary host is exactly what the runners would `skipped-environment` on it
 * — pinned by the placement/honesty parity test
 * (`test/execution/placement-parity.test.ts`), the Rule 2.30 net for a
 * concept with two consumers holding different shapes.
 */

import type { ExecutionHost, ExecutionRequirement } from './requirement';

/** One capability's declared requirement, as collected from a pack. */
export interface CapabilityRequirement {
  /** Pack id (string here, `LanguageId` at the collector — layering). */
  readonly pack: string;
  readonly capability: 'correctness' | 'lintGate' | 'depVulns' | 'deepSast';
  readonly requirement: ExecutionRequirement;
}

/** The GitHub-hosted runner label for each execution host. */
export const CI_RUNNERS: Readonly<Record<ExecutionHost, string>> = {
  linux: 'ubuntu-latest',
  windows: 'windows-latest',
  macos: 'macos-latest',
};

/** A generated per-host gate job: the capabilities the PRIMARY host cannot
 *  serve, grouped by the host that can. */
export interface HostJob {
  readonly host: ExecutionHost;
  readonly runner: string;
  /** Distinct pack ids placed on this job (deterministic input order). */
  readonly packs: readonly string[];
  readonly capabilities: readonly CapabilityRequirement[];
}

export interface PlacementPlan {
  /** Capabilities the primary host serves (subject to toolchain presence —
   *  placement decides the HOST dimension; toolchain provisioning is the
   *  environment/health tier's job at run time). */
  readonly primary: readonly CapabilityRequirement[];
  /** Extra host jobs the generator must emit, one per required host,
   *  deterministic host order (windows before macos). */
  readonly hostJobs: readonly HostJob[];
}

const HOST_ORDER: readonly ExecutionHost[] = ['linux', 'windows', 'macos'];

/**
 * Route each capability: a requirement satisfiable on the primary host stays
 * primary; one that is not is placed on its FIRST declared host (declaration
 * order is the pack's preference; deterministic). This is the host dimension
 * only — toolchains/health are runtime facts the environment model answers.
 */
export function resolvePlacement(
  capabilities: readonly CapabilityRequirement[],
  primaryHost: ExecutionHost = 'linux',
): PlacementPlan {
  const primary: CapabilityRequirement[] = [];
  const byHost = new Map<ExecutionHost, CapabilityRequirement[]>();

  for (const cap of capabilities) {
    const hosts = cap.requirement.hosts;
    if (hosts.includes('any') || hosts.includes(primaryHost)) {
      primary.push(cap);
      continue;
    }
    const target = hosts.find((h): h is ExecutionHost => h !== 'any');
    if (!target) {
      // Unroutable (empty host list) — contract-tested to be impossible;
      // treat as primary so nothing silently vanishes from the plan.
      primary.push(cap);
      continue;
    }
    const list = byHost.get(target) ?? [];
    list.push(cap);
    byHost.set(target, list);
  }

  const hostJobs: HostJob[] = [];
  for (const host of HOST_ORDER) {
    const caps = byHost.get(host);
    if (!caps || caps.length === 0) continue;
    hostJobs.push({
      host,
      runner: CI_RUNNERS[host],
      packs: [...new Set(caps.map((c) => c.pack))],
      capabilities: caps,
    });
  }
  return { primary, hostJobs };
}
